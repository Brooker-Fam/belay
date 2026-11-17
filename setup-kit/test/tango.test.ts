// The command-line runner with the real Tango client: each provision fixture, through a fake adb
// server over TCP (fake-adb-server.ts) instead of the fake phone directly. It must print and
// ask what provision.sh does, but for adb install's own words: adb's client prints
// "Performing Streamed Install" and "adb: failed to install <file>: " around the phone's
// answer, and Tango gives the phone's answer alone.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { adbServer } from "../src/adb/server.js";
import { TangoPhone } from "../src/adb/tango.js";
import { main } from "../src/cli.js";
import { deviceInstallAnswer, FakeAdbServer } from "./fake-adb-server.js";
import { FakePhone, FIXTURES, readFixture } from "./fake-phone.js";

const APK = "/fixture/belay.apk";
const provisionFixtures = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .filter((name) => (readFixture(name).plan ?? "provision") === "provision")
  .sort();

const expected = (name: string, ext: string): string => readFileSync(new URL(`${name}.${ext}`, FIXTURES), "utf8").trimEnd();
// adb install's words, and its calls, as they reach the phone.
const asThePhoneSaysIt = (output: string): string =>
  output
    .split("\n")
    .map((line) => (line.startsWith("  ") ? `  ${deviceInstallAnswer(line.slice(2))}` : line))
    .filter((line) => line !== "  ")
    .join("\n");
const calls = (text: string): string =>
  text
    .split("\n")
    .filter((line) => line !== "devices" && line !== "")
    .map((line) => (line.startsWith("install ") ? "install" : line))
    .join("\n");

describe("the command-line runner through Tango and an adb server", () => {
  for (const name of provisionFixtures) {
    it(name, async () => {
      const fixture = readFixture(name);
      const phone = new FakePhone(fixture);
      const server = new FakeAdbServer(fixture, phone.listed(), phone);
      const port = await server.start();
      let output = "";
      const typed = (fixture.stdin ?? "").split("\n");
      if (typed.at(-1) === "") typed.pop();
      let tango: TangoPhone | undefined;
      try {
        const status = await main([...(fixture.args ?? []).map((a) => a.replaceAll("{apk}", APK)), "--adb-port", String(port)], {
          out: { stdout: (t) => (output += t), stderr: (t) => (output += t) },
          readLine: () => Promise.resolve(typed.shift()),
          readPlan: () => Promise.resolve(readFileSync(new URL("../provision-plan.json", FIXTURES), "utf8")),
          connect: (o) => {
            tango = new TangoPhone(adbServer(o.adbHost, o.adbPort), () => Promise.resolve(new Uint8Array(3000).fill(7)));
            return Promise.resolve(tango);
          },
          inspectApk: () => phone.inspectApk(),
          sleep: (s) => phone.sleep(s),
          androidDir: "/fixture/android",
          env: {},
        });
        expect(output.replaceAll(APK, "{apk}").trimEnd()).toBe(asThePhoneSaysIt(expected(name, "out")));
        expect(calls(phone.calls.join("\n"))).toBe(calls(expected(name, "calls")));
        expect(status).toBe(fixture.exit ?? 0);
      } finally {
        await tango?.close();
        await server.stop();
      }
    });
  }
});
