// Runs the provisioning plan against a phone, step by step, the way android/scripts/lib.sh's
// interpreter does: the same commands, checks, waits and messages. The fixtures in
// android/scripts/plan-tests hold both to that (test/plan-fixtures.test.ts here).

import type { DeviceMessages, Failure, Level, Matcher, Plan, Step, Stderr } from "./plan.js";
import { expand, runs, type Vars } from "./template.js";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** A line of `adb devices`. */
export interface DeviceEntry {
  serial: string;
  state: string;
}

/** What the APK check found, as lib.sh's build tools report it. */
export interface ApkFacts {
  found: boolean;
  /** Empty when it couldn't be read. */
  package: string;
  testOnly: "yes" | "no" | "unknown";
  /** The first signer's certificate; missing when unsigned, unreadable or there's no tool. */
  signer?: { sha256: string; dn: string } | undefined;
  /** Whether the signature could be checked at all (lib.sh: apksigner is installed). */
  signerTool: boolean;
}

/** The phone, over adb: a Tango connection, or a fake in the tests. */
export interface Phone {
  /** What `adb devices` lists. */
  devices(): Promise<DeviceEntry[]>;
  /** Use this device from now on. */
  use(serial: string): Promise<void>;
  /** `adb shell` with these words, joined by spaces as adb joins them. */
  shell(words: string[]): Promise<ShellResult>;
  /** `adb install` with these arguments; its output and errors together. */
  install(args: string[], apk: string): Promise<string>;
  /** `adb reboot`, then `adb wait-for-device`. */
  reboot(): Promise<void>;
  waitForDevice(): Promise<void>;
}

export interface Host {
  phone: Phone;
  inspectApk(apk: string): Promise<ApkFacts>;
  sleep(seconds: number): Promise<void>;
  /** The question before making Belay the device owner; true is yes. */
  ask(question: string): Promise<boolean>;
  emit(event: PlanEvent): void;
}

export type PlanEvent =
  /** A step with an id started. */
  | { type: "step"; id: string; page?: string | undefined }
  | { type: "say"; level: Level; text: string; prefix?: string | undefined }
  | { type: "stop"; lines: string[] }
  /** With dry_run, a command that would change the phone. */
  | { type: "dryRun"; command: string }
  /** What a change or an install printed, shown indented. */
  | { type: "output"; text: string }
  /** Output a command let through, as it is. */
  | { type: "stream"; stream: "stdout" | "stderr"; text: string }
  /** Each command sent to the phone, for a details view. */
  | { type: "command"; command: string };

/** The run ends with this exit status. */
export class PlanExit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/**
 * Runs the plan's steps with these variables (apk, server, code, serial, dry_run, assume_yes,
 * reboot; package and admin come from the plan). Returns the exit status provision.sh would.
 */
export async function runPlan(plan: Plan, vars: Vars, host: Host): Promise<number> {
  vars.set("package", plan.package);
  vars.set("admin", plan.admin);
  const run = new Run(plan, vars, host);
  try {
    await run.steps(plan.steps);
  } catch (e) {
    if (e instanceof PlanExit) return e.code;
    throw e;
  }
  return 0;
}

const trimNewlines = (text: string): string => text.replace(/\n+$/, "");
const lines = (text: string): string[] => text.split("\n");

class Run {
  constructor(
    readonly plan: Plan,
    readonly vars: Vars,
    readonly host: Host,
  ) {}

  private get dryRun(): boolean {
    return (this.vars.get("dry_run") ?? "") !== "";
  }
  private text(template: string): string {
    return expand(template, this.vars);
  }
  private set(name: string, value: string): void {
    this.vars.set(name, value);
  }
  private say(level: Level, text: string): void {
    this.host.emit({ type: "say", level, text });
  }
  private stop(message: string[]): never {
    this.host.emit({ type: "stop", lines: message.map((line) => this.text(line)) });
    throw new PlanExit(1);
  }

  async steps(steps: Step[] | undefined): Promise<void> {
    for (const step of steps ?? []) await this.step(step);
  }

  private async step(s: Step): Promise<void> {
    if (!runs(s, this.vars)) return;
    if (s.id !== undefined) this.host.emit({ type: "step", id: s.id, page: s.page });
    switch (s.kind) {
      case "group":
        return this.steps(s.steps);
      case "say":
        this.host.emit({ type: "say", level: s.level ?? "say", text: this.text(s.text), prefix: s.prefix });
        return;
      case "stop":
        return this.stop(s.message);
      case "set":
        this.set(s.var, this.text(s.value));
        return;
      case "read":
        return this.read(s);
      case "check": {
        let text: string;
        let status = 0;
        const whole = s.run === undefined;
        if (s.run === undefined) {
          text = this.text(s.value ?? "");
        } else {
          ({ text, status } = await this.sh(s.run, s.stderr));
        }
        const ok = this.passes(s, text, status, whole);
        if (s.into !== undefined) this.set(s.into, ok ? "1" : "");
        return this.steps(ok ? s.pass : s.fail);
      }
      case "wait":
        for (let i = 0; i < s.tries; i++) {
          const { text, status } = await this.sh(s.run, s.stderr);
          if (this.passes(s, text, status, false)) {
            if (s.into !== undefined) this.set(s.into, "1");
            return;
          }
          await this.host.sleep(s.every);
        }
        if (s.into !== undefined) this.set(s.into, "");
        return;
      case "run": {
        const words = s.run.map((w) => this.text(w));
        if (this.dryRun) {
          this.dry(`adb shell ${words.join(" ")}`);
          return;
        }
        const r = await this.shell(words);
        if (s.quiet !== true && r.stdout !== "") this.host.emit({ type: "stream", stream: "stdout", text: r.stdout });
        if (r.stderr !== "") this.host.emit({ type: "stream", stream: "stderr", text: r.stderr });
        // provision.sh runs with set -e: a command that changes the phone and fails ends it.
        if (r.exitCode !== 0) throw new PlanExit(r.exitCode);
        return;
      }
      case "change": {
        const words = s.run.map((w) => this.text(w));
        if (this.dryRun) {
          this.dry(`adb shell ${words.join(" ")}`);
          return;
        }
        const r = await this.shell(words);
        return this.changed(s.success, s.failures, trimNewlines(r.stdout.replaceAll("\r", "") + r.stderr));
      }
      case "install": {
        const args = s.args.filter((a) => runs(a, this.vars)).map((a) => this.text(a.arg));
        const apk = this.vars.get("apk") ?? "";
        if (this.dryRun) {
          this.dry(`adb install ${[...args, apk].join(" ")}`);
          return;
        }
        this.host.emit({ type: "command", command: `adb install ${[...args, apk].join(" ")}` });
        // Not through the shell: adb install's own words, carriage returns and all.
        return this.changed(s.success, s.failures, trimNewlines(await this.host.phone.install(args, apk)));
      }
      case "confirm":
        if (this.dryRun || (this.vars.get("assume_yes") ?? "") !== "") return;
        if (!(await this.host.ask(this.text(s.text)))) this.stop(s.no);
        return;
      case "sleep":
        return this.host.sleep(s.seconds);
      case "reboot":
        this.host.emit({ type: "command", command: "adb reboot" });
        await this.host.phone.reboot();
        this.host.emit({ type: "command", command: "adb wait-for-device" });
        return this.host.phone.waitForDevice();
      case "broadcast":
        return this.broadcast(s);
      case "apk":
        return this.apk();
      case "device":
        return this.device();
      case "exit":
        throw new PlanExit(s.code);
    }
  }

  private dry(command: string): void {
    this.host.emit({ type: "dryRun", command });
  }

  private async shell(words: string[]): Promise<ShellResult> {
    this.host.emit({ type: "command", command: `adb shell ${words.join(" ")}` });
    return this.host.phone.shell(words);
  }

  /**
   * A command's output as lib.sh's plan_sh has it: carriage returns removed (ash's tr) and
   * trailing newlines ($(...)); standard error dropped, merged, or let through.
   */
  private async sh(run: string[], stderr: Stderr): Promise<{ text: string; status: number }> {
    const r = await this.shell(run.map((w) => this.text(w)));
    let text = r.stdout.replaceAll("\r", "");
    if (stderr === "merge") text += r.stderr;
    else if (stderr !== "drop" && r.stderr !== "") this.host.emit({ type: "stream", stream: "stderr", text: r.stderr });
    return { text: trimNewlines(text), status: r.exitCode };
  }

  /** lib.sh's plan_match: a command's output needs exit status 0 for contains and matches. */
  private passes(m: Matcher, text: string, status: number, whole: boolean): boolean {
    if (m.contains !== undefined) return status === 0 && text.includes(this.text(m.contains));
    if (m.matches !== undefined) {
      // A POSIX extended regular expression's "." also matches a newline.
      const re = new RegExp(this.text(m.matches), "s");
      return whole ? re.test(text) : status === 0 && lines(text).some((line) => re.test(line));
    }
    return text === this.text(m.equals ?? "");
  }

  private async read(s: Extract<Step, { kind: "read" }>): Promise<void> {
    const { text } = await this.sh(s.run, s.stderr);
    let value = text;
    if (s.count !== undefined) {
      const literal = s.count;
      value = String(lines(text).filter((line) => line.includes(literal)).length);
    } else if (s.lines !== undefined) {
      const literal = s.lines;
      const indent = s.indent ?? "";
      value = lines(text)
        .filter((line) => line.includes(literal))
        .map((line) => indent + line.replace(/^[ \t\n\v\f\r]+/, ""))
        .join("\n");
    } else if (s.tally !== undefined) {
      const re = new RegExp(s.tally, "s");
      const found = lines(text).flatMap((line) => {
        const m = re.exec(line);
        return m === null ? [] : [m[1] ?? ""];
      });
      // sort | uniq -c, in the C locale.
      found.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const counted: string[] = [];
      for (let i = 0; i < found.length; ) {
        let j = i;
        while (j < found.length && found[j] === found[i]) j++;
        counted.push(`${j - i} ${found[i] ?? ""}`);
        i = j;
      }
      value = counted.join("\n");
    }
    this.set(s.into, value);
  }

  /** After a change or an install: its output, indented; then success, or the first failure that fits. */
  private async changed(success: string, failures: Failure[], out: string): Promise<void> {
    this.host.emit({ type: "output", text: out });
    this.set("output", out);
    const re = new RegExp(success, "s");
    if (lines(out).some((line) => re.test(line))) return;
    for (const failure of failures) {
      if (failure.contains !== undefined && !out.includes(this.text(failure.contains))) continue;
      return this.steps(failure.steps);
    }
  }

  private async broadcast(s: Extract<Step, { kind: "broadcast" }>): Promise<void> {
    const words = s.run.map((w) => this.text(w));
    if (this.dryRun) {
      this.dry(`adb shell ${words.join(" ")}`);
      return;
    }
    const until = s.retry === undefined ? "" : this.text(s.retry.contains);
    const tries = s.retry?.tries ?? 1;
    const first = s.retry?.first === undefined ? "" : this.text(s.retry.first);
    let out: string;
    let result: string;
    for (let k = 0; ; ) {
      const r = await this.shell(words);
      out = trimNewlines((r.stdout + r.stderr).replaceAll("\r", ""));
      result = lines(out)
        .filter((line) => line.startsWith("Broadcast completed: "))
        .map((line) => line.slice("Broadcast completed: ".length))
        .join("\n");
      if (until !== "" && result.includes(until)) {
        k++;
        if (k < tries) {
          if (k === 1 && first !== "") this.say("info", first);
          await this.host.sleep(s.retry?.every ?? 0);
          continue;
        }
      }
      break;
    }
    const data = lines(result)
      .map((line) => line.replace(/^result=[-0-9]*, data="/, "").replace(/"$/, ""))
      .join("\n");
    this.set("output", out);
    this.set("result", result);
    this.set("data", data);
    for (const outcome of s.outcomes) {
      if (outcome.prefix !== undefined && !result.startsWith(this.text(outcome.prefix))) continue;
      if (outcome.contains !== undefined && !result.includes(this.text(outcome.contains))) continue;
      if (outcome.into !== undefined) this.set(outcome.into, data);
      return this.steps(outcome.steps);
    }
  }

  private async apk(): Promise<void> {
    const apk = this.vars.get("apk") ?? "";
    const facts = await this.host.inspectApk(apk);
    const signer = facts.found && facts.signer !== undefined ? facts.signer : undefined;
    this.set("apk_found", facts.found ? "1" : "");
    this.set("apk_package", facts.found ? facts.package : "");
    this.set("test_only", facts.found ? facts.testOnly : "unknown");
    this.set("signer", signer === undefined ? "" : `${signer.sha256}|${signer.dn}`);
    this.set("signer_sha256", signer?.sha256 ?? "");
    this.set("signer_dn", signer?.dn ?? "");
    this.set("signer_tool", facts.found && facts.signerTool ? "1" : "");
  }

  /** lib.sh's pick_device: the phone asked for, or the one connected, with the plan's messages. */
  private async device(): Promise<void> {
    this.host.emit({ type: "command", command: "adb devices" });
    const devices = await this.host.phone.devices();
    const list = devices.map((d) => `${d.serial}\t${d.state}`).join("\n");
    const ready = devices.filter((d) => d.state === "device").map((d) => d.serial);
    const unauthorized = devices.some((d) => d.state === "unauthorized" && d.serial !== "");
    const wanted = this.vars.get("serial") ?? "";
    let problem: keyof DeviceMessages | undefined;
    let serial = wanted;
    if (wanted !== "") {
      if (!ready.includes(wanted)) problem = "notConnected";
    } else if (ready.length === 0) {
      problem = unauthorized ? "unauthorized" : "none";
    } else if (ready.length > 1) {
      problem = "several";
    } else {
      serial = ready[0] ?? "";
    }
    if (problem !== undefined) {
      this.set("list", list);
      this.set("ready", ready.join("\n"));
      // parsePlan makes sure a plan with a device step has these.
      this.stop(this.plan.device?.messages[problem] ?? [problem]);
    }
    this.set("serial", serial);
    await this.host.phone.use(serial);
  }
}
