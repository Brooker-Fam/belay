// The command-line runner: provision.sh's options and words, with the plan run by this kit's
// interpreter over Tango instead of by lib.sh over adb. dist/run.js wires it to a real adb
// server; the tests wire it to the fixtures' fake phone.

import { parsePlan, type Plan } from "./plan/plan.js";
import { runPlan, type ApkFacts, type Phone } from "./plan/interpreter.js";
import { printer, type TextOutput } from "./plan/text.js";
import type { Vars } from "./plan/template.js";

export const USAGE = `Make a freshly reset Android phone a Belay-managed phone: provision.sh's plan, run with the
setup kit's interpreter over an adb server (Tango's TCP client), without the Android SDK's
adb client. The phone needs USB debugging on, and an adb server must be running (adb
start-server), or give --adb-host and --adb-port.

Usage: node dist/run.js [options] [--apk APK | APK]

  --apk APK         the agent to install (like provision.sh's APK). Default: the release
                    build, android/app/build/outputs/apk/release/app-release.apk
  --debug           the debug build instead (test-only: unprovision.sh can undo it)
  --serial S        the phone's adb serial, when more than one device is connected
  --server URL      connect Belay to the family's Belay server at the end (needs --code)
  --code CODE       the one-time code from the server's "Add a phone" page
  --dry-run         run every check, change nothing, and print the commands it would run
  --yes             don't ask before making Belay the device owner
  --no-reboot       skip the restart at the end
  --adb-host HOST   the adb server (default 127.0.0.1)
  --adb-port PORT   its port (default $ANDROID_ADB_SERVER_PORT, or 5037)
  --plan FILE       another plan (default: android/scripts/provision-plan.json)
  -h, --help        this text

A release build that becomes device owner can only be removed by a factory reset.
`;

export interface Options {
  apk: string;
  serial: string;
  server: string;
  code: string;
  dryRun: boolean;
  yes: boolean;
  reboot: boolean;
  adbHost: string;
  adbPort: number;
  plan: string | undefined;
}

export type Parsed = { options: Options } | { help: true } | { error: string[] };

/** provision.sh's options, plus --apk, --adb-host, --adb-port and --plan. */
export function parseArgs(argv: string[], env: Record<string, string | undefined>, androidDir: string): Parsed {
  let apk = "";
  let debug = false;
  const o: Options = {
    apk: "",
    serial: env.ANDROID_SERIAL ?? "",
    server: "",
    code: "",
    dryRun: false,
    yes: false,
    reboot: true,
    adbHost: "127.0.0.1",
    adbPort: Number.parseInt(env.ANDROID_ADB_SERVER_PORT ?? "5037", 10),
    plan: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    const value = (): string => {
      const v = argv[i + 1];
      if (v === undefined || v === "") throw new MissingValue(arg);
      i++;
      return v;
    };
    try {
      switch (arg) {
        case "--debug":
          debug = true;
          break;
        case "--no-reboot":
          o.reboot = false;
          break;
        case "--serial":
          o.serial = value();
          break;
        case "--server":
          o.server = value();
          break;
        case "--code":
          o.code = value();
          break;
        case "--dry-run":
          o.dryRun = true;
          break;
        case "--yes":
          o.yes = true;
          break;
        case "--apk":
          apk = value();
          break;
        case "--adb-host":
          o.adbHost = value();
          break;
        case "--adb-port":
          o.adbPort = Number.parseInt(value(), 10);
          break;
        case "--plan":
          o.plan = value();
          break;
        case "-h":
        case "--help":
          return { help: true };
        default:
          if (arg.startsWith("-")) return { error: [`Unknown option ${arg}`, "Run with --help to see the options."] };
          apk = arg;
      }
    } catch (e) {
      if (e instanceof MissingValue) return { error: [`${e.option} needs a value`] };
      throw e;
    }
  }
  if (!Number.isInteger(o.adbPort) || o.adbPort <= 0 || o.adbPort > 65535) return { error: ["--adb-port needs a port number"] };
  o.apk = apk !== "" ? apk : `${androidDir}/app/build/outputs/apk/${debug ? "debug/app-debug.apk" : "release/app-release.apk"}`;
  return { options: o };
}

class MissingValue extends Error {
  constructor(readonly option: string) {
    super(option);
  }
}

/** The plan's variables for these options, as provision.sh sets them. */
export function planVars(o: Options): Vars {
  return new Map([
    ["apk", o.apk],
    ["server", o.server],
    ["code", o.code],
    ["serial", o.serial],
    ["dry_run", o.dryRun ? "1" : ""],
    ["assume_yes", o.yes ? "1" : ""],
    ["reboot", o.reboot ? "1" : ""],
  ]);
}

export interface CliHost {
  out: TextOutput;
  /** The next line typed, or undefined at the end of the input. */
  readLine(): Promise<string | undefined>;
  readPlan(path: string | undefined): Promise<string>;
  connect(o: Options): Promise<Phone>;
  inspectApk(path: string): Promise<ApkFacts>;
  sleep(seconds: number): Promise<void>;
  androidDir: string;
  env: Record<string, string | undefined>;
}

/** The runner: provision.sh's exit statuses (0 done, 1 stopped). */
export async function main(argv: string[], host: CliHost): Promise<number> {
  const show = printer(host.out);
  const parsed = parseArgs(argv, host.env, host.androidDir);
  if ("help" in parsed) {
    host.out.stdout(USAGE);
    return 0;
  }
  if ("error" in parsed) {
    show({ type: "stop", lines: parsed.error });
    return 1;
  }
  const o = parsed.options;
  let plan: Plan;
  try {
    plan = parsePlan(await host.readPlan(o.plan));
  } catch (e) {
    show({ type: "stop", lines: [`Can't use the plan: ${(e as Error).message}`] });
    return 1;
  }
  let phone: Phone | undefined;
  // Connect when the plan first asks for the phone, as provision.sh only looks for adb then.
  const lazy: Phone = {
    devices: async () => (phone ??= await host.connect(o)).devices(),
    use: async (serial) => (phone ??= await host.connect(o)).use(serial),
    shell: async (words) => (phone ??= await host.connect(o)).shell(words),
    install: async (args, apk) => (phone ??= await host.connect(o)).install(args, apk),
    reboot: async () => (phone ??= await host.connect(o)).reboot(),
    waitForDevice: async () => (phone ??= await host.connect(o)).waitForDevice(),
  };
  return runPlan(plan, planVars(o), {
    phone: lazy,
    inspectApk: (path) => host.inspectApk(path),
    sleep: (seconds) => host.sleep(seconds),
    // lib.sh's confirm: only y, Y, yes or YES is yes.
    ask: async (question) => {
      host.out.stdout(`${question} [y/N] `);
      const answer = ((await host.readLine()) ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
      return ["y", "Y", "yes", "YES"].includes(answer);
    },
    emit: show,
  });
}
