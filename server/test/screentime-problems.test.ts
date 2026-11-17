/**
 * "Belay can't count screen time": the phone's report that it can't count (usage access off)
 * while its rules measure or limit, said plainly on the parent pages and in the daily summary.
 * Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { getDevice } from "../src/family/devices.js";
import type { PolicyContext } from "../src/family/policy.js";
import { setPhoneRules, setPhoneSettings } from "../src/family/screentime/changes.js";
import { NO_RULES } from "../src/family/screentime/rules.js";
import { digestItems } from "../src/ops/notify.js";
import { getSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, testServer } from "./helpers.js";

async function family() {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Alex's phone");
  const sam = { kind: "parent", parentId: parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const report = (measured: boolean, limits: { id: string; state: "open" | "used_up" | "extra" }[], usageAccess = measured) =>
    deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, screen_time: { day: "2026-11-16", measured, limits } } }, { usage_access: usageAccess }) });
  const problems = () => getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.problems ?? [];
  return { t, phone, sam, ctx, report, problems };
}

describe("Belay can't count screen time", () => {
  it("is said plainly when the phone can't count while its rules limit apps, once, with what happens", async () => {
    const { sam, ctx, phone, report, problems } = await family();
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, sam);
    await report(false, [{ id: "l-games", state: "open" }]);
    expect(problems()).toEqual([
      { code: "screen_time_unmeasured", text: "Usage access for Belay is turned off, so Belay can't count screen time. Apps with a time limit are paused until it's back on" },
    ]);
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, if_unmeasured: "keep_open", limits: [{ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, sam);
    expect(problems()[0]?.text).toBe("Usage access for Belay is turned off, so Belay can't count screen time. Apps with a time limit stay open until it's back on, as the rules say");
    await report(true, [{ id: "l-games", state: "open" }]);
    expect(problems()).toEqual([]);
  });

  it("while measuring, without limits, it's still said; without screen-time rules, it's Phase 1's plain problem", async () => {
    const { sam, ctx, phone, report, problems } = await family();
    await report(false, [], false);
    expect(problems().map((p) => p.code)).toEqual(["usage_access_off"]);
    setPhoneSettings(ctx(), phone.deviceId, { measure: true }, sam);
    expect(problems()).toEqual([{ code: "screen_time_unmeasured", text: "Usage access for Belay is turned off, so Belay can't count screen time" }]);
  });

  it("has words in the daily summary", async () => {
    const { t, phone, report, problems, sam, ctx } = await family();
    setPhoneSettings(ctx(), phone.deviceId, { measure: true }, sam);
    await report(false, []);
    const view = getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now());
    expect(problems()).toHaveLength(1);
    expect(digestItems({ phones: view ? [view] : [], requests: 0, proposals: 0, server: [], now: t.now() })).toEqual(["Belay can't count screen time on a phone: usage access is off"]);
  });
});
