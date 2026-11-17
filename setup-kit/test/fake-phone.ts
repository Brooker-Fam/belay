// The fixtures' fake phone, with the same rules as android/scripts/test-plan.sh's fake adb,
// aapt2, apksigner and sleep (its header describes the fixture's fields).

import { readFileSync } from "node:fs";
import type { ApkFacts, DeviceEntry, Phone, ShellResult } from "../src/plan/interpreter.js";

export const FIXTURES = new URL("../../android/scripts/plan-tests/", import.meta.url);

type Response = string | { out?: string; err?: string; exit?: number; seq?: Response[] };
interface Entry {
  run: string;
  after?: string;
  out?: string;
  err?: string;
  exit?: number;
  seq?: Response[];
}
interface FakeApk {
  missing?: boolean;
  aapt2?: boolean;
  apksigner?: boolean;
  package?: string | null;
  testOnly?: boolean;
  signed?: boolean;
  sha256?: string;
  dn?: string;
}
export interface Fixture {
  name: string;
  base?: string;
  plan?: string;
  args?: string[];
  vars?: Record<string, string>;
  stdin?: string;
  exit?: number;
  apk?: FakeApk;
  devices?: DeviceEntry[];
  install?: Response;
  phone?: Entry[];
}

export function readFixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), "utf8")) as Fixture;
}

/** The fake phone: it logs each call as test-plan.sh's fake does (the .calls file). */
export class FakePhone implements Phone {
  readonly calls: string[] = [];
  private readonly base: Fixture | undefined;
  private readonly counts = new Map<object, number>();

  constructor(private readonly fixture: Fixture) {
    this.base = fixture.base === undefined ? undefined : readFixture(fixture.base);
  }

  /** A field of the fixture, or of its base. */
  private field<K extends keyof Fixture>(key: K): Fixture[K] | undefined {
    return this.fixture[key] ?? this.base?.[key];
  }

  private respond(response: Response): { out: string; err: string; exit: number } {
    let r = response;
    if (typeof r === "object" && r.seq !== undefined) {
      const k = this.counts.get(r) ?? 0;
      this.counts.set(r, k + 1);
      r = r.seq[Math.min(k, r.seq.length - 1)] ?? "";
    }
    if (typeof r === "string") return { out: r, err: "", exit: 0 };
    return { out: r.out ?? "", err: r.err ?? "", exit: r.exit ?? 0 };
  }

  devices(): Promise<DeviceEntry[]> {
    this.calls.push("devices");
    return Promise.resolve(this.listed());
  }

  /** The devices adb lists, without logging a call. */
  listed(): DeviceEntry[] {
    return this.field("devices") ?? [];
  }

  use(_serial: string): Promise<void> {
    return Promise.resolve();
  }

  shell(words: string[]): Promise<ShellResult> {
    const command = words.join(" ");
    // The fixture's own entries for the command, or else its base's; the last one whose
    // "after" call was already made.
    let entries = (this.fixture.phone ?? []).filter((e) => e.run === command);
    if (entries.length === 0) entries = (this.base?.phone ?? []).filter((e) => e.run === command);
    const entry = entries.filter((e) => e.after === undefined || this.calls.includes(e.after)).at(-1);
    this.calls.push(`shell ${command}`);
    const { out, err, exit } = entry === undefined ? { out: "", err: "", exit: 0 } : this.respond(entry);
    return Promise.resolve({ stdout: out === "" ? "" : `${out}\n`, stderr: err === "" ? "" : `${err}\n`, exitCode: exit });
  }

  install(args: string[], apk: string): Promise<string> {
    this.calls.push(`install ${[...args, apk].join(" ")}`);
    const response = this.field("install");
    if (response === undefined) return Promise.resolve("");
    const { out, err } = this.respond(response);
    return Promise.resolve((out === "" ? "" : `${out}\n`) + (err === "" ? "" : `${err}\n`));
  }

  reboot(): Promise<void> {
    this.calls.push("reboot");
    return Promise.resolve();
  }

  waitForDevice(): Promise<void> {
    this.calls.push("wait-for-device");
    return Promise.resolve();
  }

  sleep(seconds: number): Promise<void> {
    this.calls.push(`sleep ${seconds}`);
    return Promise.resolve();
  }

  /** What lib.sh's apk_package, apk_is_test_only and apk_signer say with the fake tools. */
  inspectApk(): Promise<ApkFacts> {
    const apk = { ...this.base?.apk, ...this.fixture.apk };
    const aapt2 = apk.aapt2 !== false;
    const apksigner = apk.apksigner !== false;
    const pkg = aapt2 ? (apk.package ?? "") : "";
    return Promise.resolve({
      found: apk.missing !== true,
      package: pkg,
      // The fake aapt2 fails without a package, which lib.sh reads as "not test-only".
      testOnly: !aapt2 ? "unknown" : pkg !== "" && apk.testOnly === true ? "yes" : "no",
      signer: apksigner && apk.signed !== false ? { sha256: apk.sha256 ?? "", dn: apk.dn ?? "" } : undefined,
      signerTool: apksigner,
    });
  }
}
