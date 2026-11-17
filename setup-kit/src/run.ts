// node dist/run.js [provision.sh's options] --apk APK: provisions a phone from the plan, through
// an adb server (Tango's TCP client). See cli.ts for the options; CI runs it on the emulator.

import { readFile, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { adbServer } from "./adb/server.js";
import { TangoPhone } from "./adb/tango.js";
import { apkFacts, inspectApk } from "./apk/inspect.js";
import { main } from "./cli.js";

const androidDir = fileURLToPath(new URL("../../android", import.meta.url));
const defaultPlan = fileURLToPath(new URL("../../android/scripts/provision-plan.json", import.meta.url));

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

const typed = createInterface({ input: process.stdin, terminal: false });
const lines = typed[Symbol.asyncIterator]();
let phone: TangoPhone | undefined;
let adbAt = "";
try {
  process.exitCode = await main(process.argv.slice(2), {
    out: {
      stdout: (text) => process.stdout.write(text),
      stderr: (text) => process.stderr.write(text),
    },
    readLine: async () => {
      const line = await lines.next();
      return line.done === true ? undefined : line.value;
    },
    readPlan: (path) => readFile(path ?? defaultPlan, "utf8"),
    connect: (o) => {
      adbAt = `${o.adbHost}:${o.adbPort}`;
      phone = new TangoPhone(adbServer(o.adbHost, o.adbPort), async (apk) => new Uint8Array(await readFile(apk)));
      return Promise.resolve(phone);
    },
    inspectApk: async (path) => apkFacts((await isFile(path)) ? await inspectApk(new Uint8Array(await readFile(path))) : undefined),
    sleep: (seconds) => new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
    androidDir,
    env: process.env,
  });
} catch (e) {
  // provision.sh would carry on with adb's errors; a lost connection is better stopped.
  const why = e instanceof Error ? e.message : String(e);
  process.stderr.write(
    (e as NodeJS.ErrnoException).code === "ECONNREFUSED"
      ? `\nSTOPPED: No adb server at ${adbAt}.\n  Start one (adb start-server), or give --adb-host and --adb-port.\n`
      : `\nSTOPPED: Lost the connection to the phone: ${why}\n  Check the cable and that the phone is unlocked, then run this again.\n`,
  );
  process.exitCode = 1;
} finally {
  typed.close();
  await phone?.close();
}
