// The setup kit's page: the plan provision.sh runs (android/scripts/provision-plan.json), run by
// the kit's interpreter in the browser, over WebUSB. Bundled into dist/web/app.js at build time.

import { AdbDaemonWebUsbDeviceManager } from "@yume-chan/adb-daemon-webusb";
import { TangoPhone } from "../adb/tango.js";
import { apkFacts, inspectApk, sameSha256, type ApkInfo } from "../apk/inspect.js";
import { runPlan, type PlanEvent } from "../plan/interpreter.js";
import { inputChecks, pageSteps, parsePlan, type InputCheck, type Plan } from "../plan/plan.js";
import { isBusy, WebUsbConnector } from "./webusb.js";

interface ChosenApk {
  name: string;
  bytes: Uint8Array;
  info: ApkInfo;
  fromKit: boolean;
}

let plan: Plan | undefined;
let apk: ChosenApk | undefined;
let connector: WebUsbConnector | undefined;
let phone: TangoPhone | undefined;
let serial = "";
let phoneName = "";
let running = false;
let activeStep: string | undefined;

function el(id: string): HTMLElement {
  const e = document.getElementById(id);
  if (e === null) throw new Error(`the page has no #${id}`);
  return e;
}
const input = (id: string): HTMLInputElement => el(id) as HTMLInputElement;
const button = (id: string): HTMLButtonElement => el(id) as HTMLButtonElement;
function say(id: string, words: string, tone = ""): void {
  const e = el(id);
  e.textContent = words;
  e.className = tone;
}
const why = (e: unknown): string => (e instanceof Error ? e.message : String(e));
/** A SHA-256 in pairs, as people write it down: "AB:CD:...". */
const fingerprint = (hex: string): string => hex.toUpperCase().match(/../g)?.join(":") ?? hex;

function updateButtons(): void {
  const ready = plan !== undefined && apk !== undefined && phone !== undefined && !running;
  button("connect").disabled = connector === undefined || running;
  button("check").disabled = !ready;
  button("setup").disabled = !ready;
  input("apk-file").disabled = running;
}

// ---- The app ----------------------------------------------------------------------------

function choose(chosen: ChosenApk): void {
  apk = chosen;
  const { info } = chosen;
  const problems: string[] = [];
  el("apk-info").hidden = false;
  say("apk-summary", chosen.fromKit ? "The app the setup kit built." : `The file ${chosen.name}.`);
  if (info.problem !== undefined) problems.push(`It can't be read as an app: ${info.problem}.`);
  else if (plan !== undefined && info.package !== plan.package) problems.push(`This isn't Belay: it's ${info.package}.`);
  say("apk-package", info.package === "" ? "(can't read it)" : info.package);
  if (info.testOnly) {
    say("apk-kind", "A test (debug) build. android/scripts/unprovision.sh can remove it later without a factory reset: for trying Belay out on a test phone.");
  } else {
    say("apk-kind", "A release build. Once it manages the phone, only a factory reset removes it.");
  }
  const cert = info.certificate;
  say("apk-cert", cert === undefined ? "none" : fingerprint(cert.sha256));
  say("apk-dn", cert?.dn ?? "");
  if (cert === undefined && info.problem === undefined) problems.push("This app isn't signed. A release build is signed with your family's key (docs/signing.md).");
  if (cert !== undefined && !info.testOnly && cert.dn.includes("CN=Android Debug")) {
    problems.push("This release build is signed with a debug key: Belay could never be updated on a phone set up with it. Sign it with your family's key (docs/signing.md).");
  }
  if (problems.length > 0) say("apk-summary", `${el("apk-summary").textContent} ${problems.join(" ")}`, "bad");
  el("apk-info").className = problems.length > 0 ? "card bad" : "card";
  compare();
  updateButtons();
}

function compare(): void {
  const written = input("apk-compare").value.trim();
  const cert = apk?.info.certificate?.sha256;
  if (written === "" || cert === undefined) {
    say("apk-compare-result", "");
  } else if (sameSha256(written, cert)) {
    say("apk-compare-result", "✓ The same: this app is signed with the key you wrote down.", "good");
  } else {
    say("apk-compare-result", "✗ Not the same. Don't set up the phone with this app: it isn't signed with the key you wrote down.", "bad");
  }
}

async function loadKitApk(): Promise<void> {
  const answer = (await (await fetch("kit/apk.json")).json()) as { available: boolean; name?: string };
  if (!answer.available) {
    el("no-kit-apk").hidden = false;
    return;
  }
  el("kit-apk").hidden = false;
  say("kit-apk-name", answer.name ?? "");
  const bytes = new Uint8Array(await (await fetch("kit/belay.apk")).arrayBuffer());
  choose({ name: answer.name ?? "belay.apk", bytes, info: await inspectApk(bytes), fromKit: true });
}

async function pickFile(): Promise<void> {
  const file = input("apk-file").files?.[0];
  if (file === undefined) return;
  const bytes = new Uint8Array(await file.arrayBuffer());
  choose({ name: file.name, bytes, info: await inspectApk(bytes), fromKit: false });
}

// ---- The server and code ------------------------------------------------------------------

function serverAndCode(): { server: string; code: string } {
  return { server: input("server").value.trim(), code: input("code").value.trim() };
}

/** What's wrong with them, with the plan's own patterns and words; empty when nothing is. */
function serverProblem(): string {
  const { server, code } = serverAndCode();
  if (server === "" && code === "") return "";
  if (server === "" || code === "") return "Fill in both the address and the code, or neither.";
  const checks = plan === undefined ? new Map<string, InputCheck>() : inputChecks(plan);
  const s = checks.get("server");
  if (s !== undefined && !s.pattern.test(server)) return `That doesn't look like a server address. ${s.hint.join(" ")}`;
  const c = checks.get("code");
  if (c !== undefined && !c.pattern.test(code)) return `That doesn't look like a code. ${c.hint.join(" ")}`;
  return "";
}

// ---- The phone ----------------------------------------------------------------------------

const readApk = (name: string): Promise<Uint8Array> =>
  apk !== undefined && apk.name === name ? Promise.resolve(apk.bytes) : Promise.reject(new Error("choose the app again"));

function connectProblem(e: unknown): string {
  if (isBusy(e)) {
    return "Another program on this computer is using the phone's USB debugging, most likely adb. Close it (or run adb kill-server), unplug the phone and plug it in again, then connect again.";
  }
  if (/access denied|unable to claim|failed to open/i.test(why(e))) {
    return "The browser isn't allowed to open the phone. On Linux the phone needs a udev rule, and on Windows a driver (docs/setup-kit.md). Then unplug it, plug it in again, and connect again.";
  }
  return `Couldn't connect to the phone: ${why(e)}`;
}

async function connect(): Promise<void> {
  if (connector === undefined) return;
  say("connect-status", "");
  let device;
  try {
    device = await connector.pick();
  } catch (e) {
    say("connect-status", `The browser couldn't list the phones: ${why(e)}`, "bad");
    return;
  }
  if (device === undefined) {
    say("connect-status", "No phone chosen. Is it plugged in, unlocked, with USB debugging on?", "bad");
    return;
  }
  phone = undefined;
  updateButtons();
  say("connect-status", 'Connecting. Look at the phone: if it asks "Allow USB debugging?", tap Allow.');
  const candidate = new TangoPhone(connector, readApk);
  try {
    await candidate.use(device.serial);
    const prop = async (name: string): Promise<string> => (await candidate.shell(["getprop", name])).stdout.trim();
    phoneName = `${await prop("ro.product.manufacturer")} ${await prop("ro.product.model")}, Android ${await prop("ro.build.version.release")}`;
    phone = candidate;
    serial = device.serial;
    say("connect-status", `Connected: ${phoneName} (serial ${serial}).`, "good");
  } catch (e) {
    say("connect-status", connectProblem(e), "bad");
  }
  updateButtons();
}

// ---- Running the plan ---------------------------------------------------------------------

function renderProgress(): void {
  if (plan === undefined) return;
  el("progress").replaceChildren(
    ...pageSteps(plan).map(({ id, page }) => {
      const li = document.createElement("li");
      li.dataset.step = id;
      li.textContent = page;
      return li;
    }),
  );
}

function mark(id: string, state: "active" | "done" | "stopped" | "skipped" | ""): void {
  const li = el("progress").querySelector<HTMLElement>(`li[data-step="${id}"]`);
  if (li !== null) li.className = state;
}

function log(words: string, tone = ""): void {
  const line = document.createElement("div");
  line.textContent = words;
  line.className = tone;
  const box = el("log");
  box.append(line);
  box.scrollTop = box.scrollHeight;
}

function onEvent(event: PlanEvent): void {
  switch (event.type) {
    case "step":
      if (activeStep !== undefined) mark(activeStep, "done");
      activeStep = event.id;
      mark(event.id, "active");
      return;
    case "say":
      if (event.prefix !== undefined && event.prefix !== "") {
        for (const line of event.text.split("\n")) log(event.prefix + line, event.level === "err" ? "warn" : "");
      } else if (event.level === "info") log(`  ${event.text}`);
      else if (event.level === "warn") log(`Warning: ${event.text}`, "warn");
      else log(event.text, event.level === "err" ? "warn" : "");
      return;
    case "stop": {
      const [first = "", ...rest] = event.lines;
      log(`Stopped: ${first}`, "bad");
      for (const line of rest) for (const part of line.split("\n")) log(`  ${part}`, "bad");
      return;
    }
    case "dryRun":
      log(`  [dry run] ${event.command}`);
      return;
    case "output":
      for (const line of event.text.split("\n")) log(`  ${line}`);
      return;
    case "stream":
      log(event.text.replace(/\n$/, ""), event.stream === "stderr" ? "warn" : "");
      return;
    case "command":
      el("commands").append(`${event.command}\n`);
      return;
  }
}

function countdown(seconds: number): Promise<void> {
  if (seconds < 3) return new Promise((resolve) => setTimeout(resolve, seconds * 1000));
  return new Promise((resolve) => {
    let left = seconds;
    const tick = (): void => {
      if (left <= 0) {
        say("run-status", "");
        resolve();
        return;
      }
      say("run-status", `Waiting ${left} seconds...`);
      left--;
      setTimeout(tick, 1000);
    };
    tick();
  });
}

function ask(question: string, warning: string): Promise<boolean> {
  const dialog = el("confirm") as HTMLDialogElement;
  say("confirm-question", question);
  say("confirm-warning", warning, warning.includes("FACTORY RESET") ? "bad" : "");
  const cert = apk?.info.certificate?.sha256;
  say("confirm-details", `The app: ${apk?.name ?? ""}${cert === undefined ? "" : `, certificate ${fingerprint(cert)}`}. The phone: ${phoneName}.`);
  return new Promise((resolve) => {
    const done = (yes: boolean): void => {
      button("confirm-yes").onclick = null;
      button("confirm-no").onclick = null;
      dialog.oncancel = null;
      dialog.close();
      resolve(yes);
    };
    button("confirm-yes").onclick = () => {
      done(true);
    };
    button("confirm-no").onclick = () => {
      done(false);
    };
    dialog.oncancel = (e) => {
      e.preventDefault();
      done(false);
    };
    dialog.showModal();
  });
}

const warnLeaving = (e: BeforeUnloadEvent): void => {
  e.preventDefault();
};

async function run(dryRun: boolean): Promise<void> {
  if (plan === undefined || phone === undefined || apk === undefined || running) return;
  const problem = serverProblem();
  say("server-problem", problem);
  if (problem !== "") return;
  const chosen = apk;
  const { server, code } = serverAndCode();
  running = true;
  updateButtons();
  renderProgress();
  activeStep = undefined;
  el("log").replaceChildren();
  el("commands").replaceChildren();
  say("run-status", dryRun ? "Checking the phone. Nothing on it changes." : "Setting up the phone. Keep it plugged in and unlocked.");
  window.addEventListener("beforeunload", warnLeaving);
  let lastSaid = "";
  try {
    const status = await runPlan(
      plan,
      new Map([
        ["apk", chosen.name],
        ["server", server],
        ["code", code],
        ["serial", serial],
        ["dry_run", dryRun ? "1" : ""],
        ["assume_yes", ""],
        ["reboot", "1"],
      ]),
      {
        phone,
        inspectApk: () => Promise.resolve(apkFacts(chosen.info)),
        sleep: countdown,
        ask: (question) => ask(question, lastSaid),
        emit: (event) => {
          if (event.type === "say" && event.level === "say") lastSaid = event.text;
          onEvent(event);
        },
      },
    );
    finish(status, dryRun);
  } catch (e) {
    // Set by the plan's events, which TypeScript can't see from here.
    const stoppedAt = activeStep as string | undefined;
    if (stoppedAt !== undefined) mark(stoppedAt, "stopped");
    say("run-status", `Lost the connection to the phone: ${why(e)}. Check the cable and that the phone is unlocked, connect again, and run this again.`, "bad");
    phone = undefined;
  } finally {
    running = false;
    window.removeEventListener("beforeunload", warnLeaving);
    updateButtons();
  }
}

function finish(status: number, dryRun: boolean): void {
  if (status !== 0) {
    if (activeStep !== undefined) mark(activeStep, "stopped");
    say("run-status", "Stopped. What went wrong, and what to do, is below.", "bad");
    return;
  }
  if (activeStep !== undefined) mark(activeStep, "done");
  for (const li of el("progress").querySelectorAll<HTMLElement>("li")) if (li.className === "") li.className = "skipped";
  say(
    "run-status",
    dryRun
      ? "The check passed, and nothing on the phone changed. Now set up the phone."
      : "Done. On the phone, open Belay: under Setup checks, everything should have a check mark.",
    "good",
  );
}

// ---- Start ----------------------------------------------------------------------------------

async function start(): Promise<void> {
  const manager = AdbDaemonWebUsbDeviceManager.BROWSER;
  if (!window.isSecureContext) el("insecure").hidden = false;
  else if (manager === undefined) el("unsupported").hidden = false;
  else {
    connector = new WebUsbConnector(manager, {
      authenticating: () => {
        say("run-status", 'If the phone asks "Allow USB debugging?", tap Allow.');
      },
      waiting: () => {
        say("run-status", 'The phone is restarting. When it asks for its PIN, unlock it; if it asks "Allow USB debugging?", tap Allow.');
      },
    });
  }
  button("connect").addEventListener("click", () => void connect());
  button("check").addEventListener("click", () => void run(true));
  button("setup").addEventListener("click", () => void run(false));
  input("apk-file").addEventListener("change", () => void pickFile());
  input("apk-compare").addEventListener("input", compare);
  for (const id of ["server", "code"]) {
    input(id).addEventListener("input", () => {
      say("server-problem", serverProblem());
    });
  }
  updateButtons();
  try {
    plan = parsePlan(await (await fetch("plan.json")).text());
    renderProgress();
    await loadKitApk();
  } catch (e) {
    const box = el("load-problem");
    box.hidden = false;
    box.textContent = `The page couldn't load what it needs from the setup kit: ${why(e)}`;
  }
  updateButtons();
}

void start();
