// The real plan (android/scripts/provision-plan.json) and what the kit reads from it, plus the
// checks parsePlan makes of any plan.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { inputChecks, pageSteps, parsePlan, PlanError } from "../src/plan/plan.js";
import { expand, holds, runs } from "../src/plan/template.js";

const text = readFileSync(new URL("../../android/scripts/provision-plan.json", import.meta.url), "utf8");
const plan = parsePlan(text);

describe("the provisioning plan", () => {
  it("is Belay's", () => {
    expect(plan.package).toBe("family.brooker.belay");
    expect(plan.admin).toBe("family.brooker.belay/.AdminReceiver");
  });

  it("names each part for the page, in order", () => {
    expect(pageSteps(plan).map((s) => s.id)).toEqual(["apk", "phone", "ready", "confirm", "install", "owner", "usage", "battery", "start", "restart", "enroll", "result"]);
    for (const { page } of pageSteps(plan)) expect(page).toMatch(/^[A-Z]/);
  });

  it("gives the page provision.sh's patterns for the server and the code", () => {
    const checks = inputChecks(plan);
    const server = checks.get("server")!;
    const code = checks.get("code")!;
    for (const ok of ["https://belay.example.org", "http://10.0.2.2:8080", "belay.example.org/", "https://belay.example.org:8443"]) expect(server.pattern.test(ok)).toBe(true);
    for (const bad of ["https://belay.example.org/x;reboot", "https://a b", "'x'", "https://x\nreboot", "ftp://belay.example.org"]) expect(server.pattern.test(bad)).toBe(false);
    for (const ok of ["7KQ2M9XA", "7KQ2-M9XA", "7KQ2 M9XA"]) expect(code.pattern.test(ok)).toBe(true);
    for (const bad of ["7KQ2'M9XA", "SHORT", "7KQ2M9XA7KQ2M9XA", "7KQ2M9XA\n"]) expect(code.pattern.test(bad)).toBe(false);
    expect(server.hint).toEqual(["It should look like https://belay.example.org"]);
    expect(code.hint).toEqual(["A code has 8 letters and numbers, like 7KQ2M9XA."]);
  });

  it("keeps its regular expressions to what both bash's and JavaScript's read alike", () => {
    // No POSIX classes ([[:space:]]), no Perl escapes (\d, \s, \w, \b), no lookarounds.
    const regexes = [...text.matchAll(/"(?:matches|success|tally)": "((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1] ?? ""}"`) as string);
    expect(regexes.length).toBeGreaterThan(5);
    for (const re of regexes) expect(re).not.toMatch(/\[\[:|\\[dswbDSWB]|\(\?/);
  });
});

describe("parsePlan refuses", () => {
  const minimal = { format: 1, package: "p", admin: "p/.A", steps: [] as unknown[] };
  const refuse = (plan: unknown, why: RegExp): void => {
    expect(() => parsePlan(JSON.stringify(plan))).toThrow(why);
  };
  it("other formats and broken JSON", () => {
    refuse({ ...minimal, format: 2 }, /format 2/);
    expect(() => parsePlan("{")).toThrow(PlanError);
    expect(() => parsePlan('{"format": 1, "note": "caf\\u00e9"}')).toThrow(/\\u escape/);
  });
  it("keys lib.sh can't read", () => {
    refuse({ ...minimal, "bad-key": 1 }, /bad-key/);
    refuse({ ...minimal, a__b: 1 }, /a__b/);
  });
  it("unknown kinds, fields and levels", () => {
    refuse({ ...minimal, steps: [{ kind: "teleport" }] }, /unknown kind "teleport"/);
    refuse({ ...minimal, steps: [{ kind: "say", text: "x", colour: "red" }] }, /unknown field "colour"/);
    refuse({ ...minimal, steps: [{ kind: "say", text: "x", level: "shout" }] }, /unknown level "shout"/);
    refuse({ ...minimal, steps: [{ kind: "say", text: "x", level: "info", prefix: "> " }] }, /prefix goes with say or err/);
  });
  it("missing fields and bad conditions", () => {
    refuse({ ...minimal, steps: [{ kind: "stop" }] }, /"message" is missing/);
    refuse({ ...minimal, steps: [{ kind: "say", text: "x", when: ["dry_run"] }] }, /can't read the condition "dry_run"/);
    refuse({ ...minimal, steps: [{ kind: "check", value: "{a}", contains: "x", equals: "y" }] }, /exactly one of contains, matches or equals/);
    refuse({ ...minimal, steps: [{ kind: "check", contains: "x" }] }, /needs run or value/);
    refuse({ ...minimal, steps: [{ kind: "set", var: "Not-a-var", value: "" }] }, /isn't a variable name/);
    refuse({ ...minimal, steps: [{ kind: "group", steps: [{ kind: "device" }] }] }, /plan.device must be an object/);
  });
});

describe("templates and conditions", () => {
  const vars = new Map([
    ["a", "one"],
    ["n", "8"],
  ]);
  it("expand once, leaving other braces", () => {
    expect(expand("{a}/{missing}/{8,12}/{A}", vars)).toBe("one//{8,12}/{A}");
    expect(expand("{a}", new Map([["a", "{a}"]]))).toBe("{a}");
  });
  it("compare", () => {
    expect(holds("{a}", vars)).toBe(true);
    expect(holds("!{missing}", vars)).toBe(true);
    expect(holds("{a}~n", vars)).toBe(true);
    expect(holds("{n}<10", vars)).toBe(true);
    expect(holds("{a}<10", vars)).toBe(false);
    expect(() => holds("{a} = one", vars)).toThrow(/can't read/);
  });
  it("when and unless", () => {
    expect(runs({ when: ["{a}"], unless: ["{n}"] }, vars)).toBe(false);
    expect(runs({ unless: [] }, vars)).toBe(true);
  });
});
