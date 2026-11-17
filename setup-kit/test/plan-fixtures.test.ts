// The plan's shared fixtures (android/scripts/plan-tests), run through this kit's interpreter:
// it must print what provision.sh prints there, ask the phone the same, and end the same.
// android/scripts/test-plan.sh runs the same fixtures through lib.sh.

import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { runPlan } from "../src/plan/interpreter.js";
import { parsePlan } from "../src/plan/plan.js";
import { printer } from "../src/plan/text.js";
import { FakePhone, FIXTURES, readFixture } from "./fake-phone.js";

const APK = "/fixture/belay.apk";
const names = readdirSync(FIXTURES)
  .filter((f) => f.endsWith(".json"))
  .map((f) => f.slice(0, -".json".length))
  .sort();

const expected = (name: string, ext: string): string => readFileSync(new URL(`${name}.${ext}`, FIXTURES), "utf8").trimEnd();
const withApk = (text: string): string => text.replaceAll(APK, "{apk}").trimEnd();

async function run(name: string): Promise<{ status: number; output: string; calls: string }> {
  const fixture = readFixture(name);
  const phone = new FakePhone(fixture);
  let output = "";
  const out = {
    stdout: (text: string) => (output += text),
    stderr: (text: string) => (output += text),
  };
  // Each line typed, the last one even without a newline (bash's read takes it too).
  const typed = (fixture.stdin ?? "").split("\n");
  if (typed.at(-1) === "") typed.pop();
  const readLine = (): Promise<string | undefined> => Promise.resolve(typed.shift());
  let status: number;
  if ((fixture.plan ?? "provision") === "provision") {
    status = await main(
      (fixture.args ?? []).map((a) => a.replaceAll("{apk}", APK)),
      {
        out,
        readLine,
        readPlan: () => Promise.resolve(readFileSync(new URL("../provision-plan.json", FIXTURES), "utf8")),
        connect: () => Promise.resolve(phone),
        inspectApk: () => phone.inspectApk(),
        sleep: (s) => phone.sleep(s),
        androidDir: "/fixture/android",
        env: {},
      },
    );
  } else {
    const plan = parsePlan(readFileSync(new URL(fixture.plan ?? "", FIXTURES), "utf8"));
    const vars = new Map([["apk", APK], ...Object.entries(fixture.vars ?? {})]);
    status = await runPlan(plan, vars, {
      phone,
      inspectApk: () => phone.inspectApk(),
      sleep: (s) => phone.sleep(s),
      ask: async (question) => {
        out.stdout(`${question} [y/N] `);
        const answer = ((await readLine()) ?? "").replace(/^[ \t]+|[ \t]+$/g, "");
        return ["y", "Y", "yes", "YES"].includes(answer);
      },
      emit: printer(out),
    });
  }
  return { status, output: withApk(output), calls: withApk(phone.calls.join("\n")) };
}

describe("the plan's fixtures (android/scripts/plan-tests)", () => {
  it("are all here", () => {
    expect(names.length).toBeGreaterThanOrEqual(30);
  });

  for (const name of names) {
    it(`${name}: ${readFixture(name).name}`, async () => {
      const fixture = readFixture(name);
      const result = await run(name);
      expect(result.output).toBe(expected(name, "out"));
      expect(result.calls).toBe(expected(name, "calls"));
      expect(result.status).toBe(fixture.exit ?? 0);
    });
  }
});
