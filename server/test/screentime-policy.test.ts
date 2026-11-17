/**
 * What a phone's policy says about screen time (family/screentime): its rules, its stage's with
 * its own changes on top, the next stage in the kid's words, the extra time for its day, and the
 * family agreement. Made-up apps and names only.
 */
import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { RuleRefused, answerRequest, buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { deleteStage, moveToStage, resetToStage, saveAgreement, saveStage, setPhoneRules, setPhoneSettings } from "../src/family/screentime/changes.js";
import { NO_RULES, type Limit, type RuleSet, type Schedule, phoneDay, phoneRules } from "../src/family/screentime/rules.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, testServer, T0, type TestServer } from "./helpers.js";

const games = (over: Partial<Limit> = {}): Limit => ({ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null, ...over });
const bedtime = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s-bed",
  kind: "bedtime",
  name: "Bedtime",
  days: ["sun", "mon", "tue", "wed", "thu"],
  start: "21:00",
  end: "07:00",
  allow: [],
  lock: false,
  skip: [],
  ...over,
});
const rules = (over: Partial<RuleSet> = {}): RuleSet => ({ ...structuredClone(NO_RULES), ...over });

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Alex's phone");
  const sam = { kind: "parent", parentId: parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => { t.deps.waiters.changed(id); } });
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, parent, phone, sam, ctx, policy };
}

const moreTime = (t: TestServer, token: string, id: string, limitId: string, minutes = 15, reason?: string) =>
  deviceCall(t, token, "requests", { requests: [{ id, kind: "more_time", limit_id: limitId, minutes, asked_at: t.now(), ...(reason ? { reason } : {}) }] });

describe("a phone's screen_time", () => {
  it("is null until a parent sets rules or turns measuring on, and the other Phase 3 fields are off", async () => {
    const { ctx, sam, phone, policy } = await family();
    expect(policy()).toMatchObject({ screen_time: null, stage: null, agreement: null, network_log: { enabled: false } });
    const on = setPhoneSettings(ctx(), phone.deviceId, { measure: true }, sam);
    expect(on).toMatchObject({ changed: true, version: 1 });
    expect(policy().screen_time).toEqual({
      measure: true,
      zone: "phone",
      day_starts: "00:00",
      limits: [],
      schedules: [],
      exempt: [],
      if_unmeasured: "pause_limited",
      extra: [],
      self_serve: null,
      warn_before: 5,
    });
    setPhoneSettings(ctx(), phone.deviceId, { measure: false }, sam);
    expect(policy().screen_time).toBeNull();
    // A limit enforces even without measuring: the phone counts, and sends no minutes.
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games()] }), sam);
    expect(policy().screen_time).toMatchObject({ measure: false, limits: [games()] });
    expect(policy().version).toBe(3);
  });

  it("turning measuring on or off, and the zone, are a person's: an AI app can't", async () => {
    const { ctx, phone, parent } = await family();
    const claude = { kind: "ai", parentId: parent.id, clientName: "Claude" } as const;
    expect(() => setPhoneSettings(ctx(), phone.deviceId, { measure: true }, claude as never)).toThrow(/Only a person/);
    expect(() => moveToStage(ctx(), phone.deviceId, null, claude as never)).toThrow(/Only a person/);
  });

  it("refuses a limit on an app the phone never pauses, and more than the phone takes", async () => {
    const { ctx, sam, phone } = await family();
    expect(() => setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games({ packages: ["com.google.android.dialer"] })] }), sam)).toThrow(RuleRefused);
    const many = Array.from({ length: 51 }, (_, i) => games({ id: `l-${i}`, name: `Limit ${i}` }));
    expect(() => setPhoneRules(ctx(), phone.deviceId, rules({ limits: many }), sam)).toThrow(/more than 50/);
    expect(() => setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games(), games()] }), sam)).toThrow(/same id/);
  });

  it("an AI app's change applies only when it only tightens", async () => {
    const { t: server, ctx, sam, phone, parent, policy } = await family();
    const claude = { kind: "ai", parentId: parent.id, clientName: "Claude" } as const;
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games()] }), sam);
    expect(() => setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games({ minutes: 90 })] }), claude)).toThrow(/only tighten/);
    expect(policy().screen_time?.limits[0]?.minutes).toBe(60);
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games({ minutes: 30 })] }), claude);
    expect(policy().screen_time?.limits[0]?.minutes).toBe(30);
    expect(listAudit(server.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({
      actor: "ai",
      action: "screen_time.changed",
      detail: { effect: "tightens", changes: ["Games: 30 min a day instead of 1 h, every day"] },
    });
  });
});

describe("stages", () => {
  async function staged() {
    const f = await family();
    const starter = saveStage(f.ctx(), null, { name: "Starter", how: null, rules: rules({ limits: [games()], schedules: [bedtime()] }) }, f.sam).stage;
    const explorer = saveStage(
      f.ctx(),
      null,
      { name: "Explorer", how: "A month of kept limits", rules: rules({ limits: [games({ id: "l-games-2", minutes: 90 })], schedules: [bedtime({ id: "s-bed-2", start: "21:30" })] }) },
      f.sam,
    ).stage;
    return { ...f, starter, explorer };
  }

  it("a phone on a stage gets its rules, and the next stage in the kid's words, with its rules", async () => {
    const { ctx, sam, phone, starter, explorer, policy, t: server } = await staged();
    expect([starter.number, explorer.number]).toEqual([1, 2]);
    moveToStage(ctx(), phone.deviceId, starter.id, sam);
    const p = policy();
    expect(p.screen_time).toMatchObject({ limits: [games()], schedules: [bedtime()] });
    expect(p.stage).toEqual({
      name: "Starter",
      number: 1,
      since: server.now(),
      next: {
        name: "Explorer",
        unlocks: ["Games: 1 h 30 min a day instead of 1 h, every day", "Bedtime: 9:30 pm to 7:00 am instead of 9:00 pm to 7:00 am"],
        how: "A month of kept limits",
        screen_time: { ...p.screen_time, limits: explorer.rules.limits, schedules: explorer.rules.schedules, extra: [] },
      },
    });
  });

  it("the phone's own changes stay on top of its stage's, which every phone on it gets", async () => {
    const { t: server, ctx, sam, phone, starter, policy } = await staged();
    moveToStage(ctx(), phone.deviceId, starter.id, sam);
    // Games lowered for this phone alone.
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games({ minutes: 45 })], schedules: [bedtime()] }), sam);
    expect(phoneRules(server.deps.db, phone.deviceId).origin("l-games")).toBe("changed");
    const before = policy().version;
    // The stage gains a limit: the phone gets it, and keeps its own Games.
    const chat: Limit = { id: "l-chat", name: "Chat", packages: ["com.example.chat"], minutes: 30, by_day: null };
    const saved = saveStage(ctx(), starter.id, { name: "Starter", how: null, rules: rules({ limits: [games(), chat], schedules: [bedtime()] }) }, sam);
    expect(saved.phonesChanged).toBe(1);
    expect(policy().version).toBe(before + 1);
    expect(policy().screen_time?.limits).toEqual([games({ minutes: 45 }), chat]);
    // The stage drops Games: the phone's change to it goes with it.
    saveStage(ctx(), starter.id, { name: "Starter", how: null, rules: rules({ limits: [chat], schedules: [bedtime()] }) }, sam);
    expect(policy().screen_time?.limits).toEqual([chat]);
    // A limit of the phone's own stays through all that.
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [chat, games({ id: "l-mine", name: "Racing", packages: ["com.example.racer"] })], schedules: [bedtime()] }), sam);
    expect(phoneRules(server.deps.db, phone.deviceId).origin("l-mine")).toBe("own");
    // Putting back the stage's rules clears the phone's own.
    resetToStage(ctx(), phone.deviceId, sam);
    expect(policy().screen_time?.limits).toEqual([chat]);
  });

  it("moving to another stage gives exactly its rules; off its stage, the phone keeps them as its own", async () => {
    const { t: server, ctx, sam, phone, starter, explorer, policy } = await staged();
    moveToStage(ctx(), phone.deviceId, starter.id, sam);
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games({ minutes: 45 })], schedules: [] }), sam);
    moveToStage(ctx(), phone.deviceId, explorer.id, sam);
    expect(policy().screen_time).toMatchObject({ limits: explorer.rules.limits, schedules: explorer.rules.schedules });
    // Off belay is every family's last stage (Phase 11).
    expect(policy().stage).toMatchObject({ name: "Explorer", number: 2, next: { name: "Off belay", unlocks: expect.any(Array) as unknown } });
    moveToStage(ctx(), phone.deviceId, null, sam);
    expect(policy().stage).toBeNull();
    expect(policy().screen_time).toMatchObject({ limits: explorer.rules.limits, schedules: explorer.rules.schedules });
    expect(listAudit(server.deps.db, { limit: 3, includeReads: false }).map((e) => e.action)).toContain("stage.moved");
  });

  it("numbers: a new stage at a taken number goes in before it, and a stage moving there swaps", async () => {
    const { t: server, ctx, sam, starter, explorer } = await staged();
    const middle = saveStage(ctx(), null, { name: "Middle", number: 2, how: null, rules: rules() }, sam).stage;
    const db = server.deps.db;
    const numbers = () => Object.fromEntries(db.prepare<[], { name: string; number: number }>("SELECT name, number FROM stages").all().map((s) => [s.name, s.number]));
    expect(numbers()).toEqual({ Starter: 1, Middle: 2, Explorer: 3, "Off belay": 4 });
    saveStage(ctx(), explorer.id, { name: "Explorer", number: 1, how: null, rules: explorer.rules }, sam);
    expect(numbers()).toEqual({ Starter: 3, Middle: 2, Explorer: 1, "Off belay": 4 });
    expect(() => saveStage(ctx(), middle.id, { name: "starter", how: null, rules: rules() }, sam)).toThrow(/already called/);
    expect(starter.id).not.toBe(middle.id);
  });

  it("a stage with a phone on it can't be deleted", async () => {
    const { ctx, sam, phone, starter } = await staged();
    moveToStage(ctx(), phone.deviceId, starter.id, sam);
    expect(() => { deleteStage(ctx(), starter.id, sam); }).toThrow(/Alex's phone is on this stage/);
    moveToStage(ctx(), phone.deviceId, null, sam);
    deleteStage(ctx(), starter.id, sam);
  });
});

describe("extra time for the phone's day", () => {
  it("an approved more_time request gives the minutes for the phone's day, in its zone from its day_starts", async () => {
    const { t, ctx, sam, phone, policy } = await family();
    // The phone is in Los Angeles; its days start at 4:00.
    await deviceCall(t, phone.token, "checkin", { status: device({ timezone: "America/Los_Angeles" }) });
    setPhoneSettings(ctx(), phone.deviceId, { day_starts: "04:00" }, sam);
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games()] }), sam);
    // Tuesday 3:00 a.m. in Los Angeles (11:00 UTC): still Monday's day there.
    t.advance(Date.UTC(2026, 10, 17, 11, 0) - T0);
    expect(phoneDay(t.deps.db, phone.deviceId, t.now())).toBe("2026-11-16");
    expect((await moreTime(t, phone.token, "request-0001", "l-games", 15, "One more level")).status).toBe(200);
    const done = answerRequest(ctx(), phone.deviceId, "request-0001", "approved", sam, "OK, just today", { minutes: 30 });
    expect(done.result).toMatchObject({ kind: "more_time", minutes: 30, day: "2026-11-16" });
    const p = policy();
    expect(p.screen_time?.extra).toEqual([{ id: expect.stringMatching(/^x-/), limit_id: "l-games", minutes: 30, day: "2026-11-16", request_id: "request-0001", package: null }]);
    expect(p.requests).toEqual([expect.objectContaining({ id: "request-0001", status: "approved", minutes: 30, note: "OK, just today", answered_by: "Sam" })]);
    // Answering again replaces what the first answer gave.
    answerRequest(ctx(), phone.deviceId, "request-0001", "approved", sam, null, { minutes: 15 });
    expect(policy().screen_time?.extra.map((e) => e.minutes)).toEqual([15]);
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", sam, "Not today");
    expect(policy().screen_time?.extra).toEqual([]);
    expect(policy().requests[0]).toMatchObject({ status: "declined", minutes: null });
    // Approving more time needs the minutes.
    expect(() => answerRequest(ctx(), phone.deviceId, "request-0001", "approved", sam, null)).toThrow(RuleRefused);
  });

  it("the policy carries the phone's day's extra time and the day before's, and lets older go", async () => {
    const { t, ctx, sam, phone, policy } = await family();
    setPhoneRules(ctx(), phone.deviceId, rules({ limits: [games()] }), sam);
    await moreTime(t, phone.token, "request-0001", "l-games");
    answerRequest(ctx(), phone.deviceId, "request-0001", "approved", sam, null, { minutes: 15 });
    expect(policy().screen_time?.extra.map((e) => e.day)).toEqual(["2026-11-16"]);
    t.advance(86_400_000);
    expect(policy().screen_time?.extra.map((e) => e.day)).toEqual(["2026-11-16"]);
    t.advance(86_400_000);
    expect(policy().screen_time?.extra).toEqual([]);
  });

  it("days follow the zone and DST: the day clocks go back has 25 hours", async () => {
    const { t, ctx, sam, phone } = await family();
    setPhoneSettings(ctx(), phone.deviceId, { zone: "America/New_York", measure: true }, sam);
    const day = (ms: number) => phoneDay(t.deps.db, phone.deviceId, ms);
    expect(day(Date.UTC(2026, 10, 2, 4, 30))).toBe("2026-11-01"); // 11:30 p.m. EST, the 25-hour day
    expect(day(Date.UTC(2026, 10, 2, 5, 0))).toBe("2026-11-02");
    expect(day(Date.UTC(2026, 2, 9, 3, 59))).toBe("2026-03-08"); // 11:59 p.m. EDT, the 23-hour day
    // A named zone is followed wherever the phone is.
    await deviceCall(t, phone.token, "checkin", { status: device({ timezone: "Asia/Tokyo" }) });
    expect(day(Date.UTC(2026, 10, 16, 23, 0))).toBe("2026-11-16");
    setPhoneSettings(ctx(), phone.deviceId, { zone: "phone" }, sam);
    expect(day(Date.UTC(2026, 10, 16, 23, 0))).toBe("2026-11-17");
    expect(() => setPhoneSettings(ctx(), phone.deviceId, { zone: "Mars/Olympus" }, sam)).toThrow(RuleRefused);
    expect(() => setPhoneSettings(ctx(), phone.deviceId, { day_starts: "25:00" }, sam)).toThrow(RuleRefused);
  });
});

describe("the family agreement", () => {
  it("a new version asks the kid again; the kid's answer is in the policy, in a new version", async () => {
    const { t, ctx, sam, phone, policy } = await family();
    saveAgreement(ctx(), phone.deviceId, [{ title: "Phones at dinner", text: "In the basket." }, { title: "", text: "" }], sam);
    expect(policy().agreement).toEqual({ version: 1, sections: [{ title: "Phones at dinner", text: "In the basket." }], kid_agreed_at: null, parents_agreed_at: t.now() });
    const version = policy().version;
    t.advance(60_000);
    const agreed = await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0009", kind: "agreement", version: 1, answer: "agree", asked_at: t.now() - 1000 }] });
    expect(agreed.status).toBe(200);
    expect(policy().agreement?.kid_agreed_at).toBe(t.now() - 1000);
    expect(policy().version).toBe(version + 1);
    // "I agree" is answered as it arrives; it doesn't wait for a parent.
    expect(policy().requests.find((r) => r.id === "request-0009")).toMatchObject({ status: "approved", answered_by: null });
    saveAgreement(ctx(), phone.deviceId, [{ title: "Phones at dinner", text: "In the basket, and at bedtime too." }], sam);
    expect(policy().agreement).toMatchObject({ version: 2, kid_agreed_at: null });
    expect(() => saveAgreement(ctx(), phone.deviceId, [{ title: " ", text: "" }], sam)).toThrow(RuleRefused);
  });
});
