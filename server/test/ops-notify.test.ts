import { describe, expect, it } from "vitest";
import type { DeviceView, Problem } from "../src/family/devices.js";
import type { ServerProblem } from "../src/ops/health.js";
import { opsTick } from "../src/ops/jobs.js";
import { digestItems, digestNotice, getDigest, setDigest } from "../src/ops/notify.js";
import { setOpsOptions } from "../src/ops/options.js";
import { DRILL_KEY } from "../src/ops/verify.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, signIn, T0 } from "./helpers.js";
import { FAST_SCRYPT, opsServer, pushService, readNotice, subscribe, type FakeBrowser } from "./ops-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** 3% free: urgent. */
const NEARLY_FULL = { freeBytes: 15e9, totalBytes: 500e9 };

async function family(status = 201) {
  const push = pushService(status);
  const t = opsServer({ fetch: push.fetch });
  const sam = await signIn(t, "sam", "Sam");
  const alex = await signIn(t, "alex", "Alex");
  return { t, push, sam, alex };
}

const noticesTo = (push: ReturnType<typeof pushService>, browser: FakeBrowser) => push.sent.filter((s) => s.endpoint === browser.endpoint).map((s) => readNotice(browser, s.body));

describe("urgent problems with the server", () => {
  it("reach every parent's browsers at once, then at most once a day while they last", async () => {
    const { t, push, sam, alex } = await family();
    const samsLaptop = subscribe(t, sam.parent.id);
    const alexsPhone = subscribe(t, alex.parent.id, "Safari on iPhone");
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => NEARLY_FULL });
    await opsTick(t.deps);
    const notice = { title: "Belay", body: "The server needs you: the disk is almost full (3% free).", url: "/" };
    expect(noticesTo(push, samsLaptop)).toEqual([notice]);
    expect(noticesTo(push, alexsPhone)).toEqual([notice]);
    expect(t.logs).toContain("Told the parents: the disk is almost full (3% free).");
    for (let i = 0; i < 12; i++) {
      t.advance(5 * MIN);
      await opsTick(t.deps);
    }
    expect(push.sent).toHaveLength(2);
    t.advance(DAY);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(4);
  });

  it("backups failing for 2 days: told, with no app or phone names", async () => {
    const { t, push, sam } = await family();
    await enrollPhone(t, "Sam's phone");
    const laptop = subscribe(t, sam.parent.id);
    setOpsOptions(t.deps, { env: { BELAY_BACKUP_PASSPHRASE: "too short" }, scrypt: FAST_SCRYPT, disk: () => ({ freeBytes: 400e9, totalBytes: 500e9 }) });
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(0);
    t.advance(2 * DAY + HOUR);
    await opsTick(t.deps);
    expect(noticesTo(push, laptop)).toEqual([{ title: "Belay", body: "The server needs you: no backup yet.", url: "/" }]);
  });

  it("a push service that fails is tried again an hour later, not every 5 minutes", async () => {
    const { t, push, sam } = await family(500);
    subscribe(t, sam.parent.id);
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => NEARLY_FULL });
    await opsTick(t.deps);
    t.advance(5 * MIN);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(1);
    t.advance(HOUR);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(2);
  });

  it("with nobody's notifications on yet, a browser turned on later still hears about it", async () => {
    const { t, push, sam } = await family();
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => NEARLY_FULL });
    await opsTick(t.deps);
    const laptop = subscribe(t, sam.parent.id);
    t.advance(5 * MIN);
    await opsTick(t.deps);
    expect(noticesTo(push, laptop)).toHaveLength(1);
  });

  it("a restore drill's scratch copy tells nobody anything", async () => {
    const { t, push, sam } = await family();
    subscribe(t, sam.parent.id);
    setDigest(t.deps.db, sam.parent.id, true, 19);
    t.deps.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(DRILL_KEY, JSON.stringify({ at: T0, from: "belay-2026-11-16.db.enc" }));
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => NEARLY_FULL });
    await opsTick(t.deps);
    t.advance(9 * HOUR);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(0);
  });
});

describe("the daily summary", () => {
  it("is off by default", async () => {
    const { t, push, sam } = await family();
    subscribe(t, sam.parent.id);
    expect(getDigest(t.deps.db)).toEqual({ hour: 19, parents: [] });
    t.advance(9 * HOUR);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(0);
  });

  it("goes to the parents who turned it on, at 7 PM family time, once a day, with counts and no names or kid text", async () => {
    const { t, push, sam, alex } = await family();
    updateSettings(t.deps.db, { silentHours: 1 });
    const phone = await enrollPhone(t, "Sam's phone");
    await deviceCall(t, phone.token, "requests", {
      requests: [{ id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter Box", reason: "Everyone in my class has it", asked_at: T0 }],
    });
    setOpsOptions(t.deps, { env: { BELAY_BACKUP_PASSPHRASE: "too short" }, scrypt: FAST_SCRYPT, disk: () => ({ freeBytes: 400e9, totalBytes: 500e9 }) });
    const samsLaptop = subscribe(t, sam.parent.id);
    const alexsPhone = subscribe(t, alex.parent.id);
    setDigest(t.deps.db, sam.parent.id, true, 19);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(0);

    t.advance(9 * HOUR); // 7 PM in New York
    await opsTick(t.deps);
    expect(noticesTo(push, samsLaptop)).toEqual([
      { title: "Belay: today", body: "3 things need you: a phone has been silent 9 hours, a request is waiting, the last backup failed.", url: "/" },
    ]);
    expect(noticesTo(push, alexsPhone)).toEqual([]);
    const text = JSON.stringify(noticesTo(push, samsLaptop));
    for (const secret of ["Chatter", "com.example", "class", "Sam's phone"]) expect(text).not.toContain(secret);

    t.advance(30 * MIN);
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(1);
    t.advance(DAY - 30 * MIN);
    await opsTick(t.deps);
    expect(noticesTo(push, samsLaptop).at(-1)?.body).toBe("3 things need you: a phone has been silent 33 hours, a request is waiting, the last backup failed.");
  });

  it("at the family's hour; a server that's down all that hour skips the day rather than send it late", async () => {
    const { t, push, sam } = await family();
    const laptop = subscribe(t, sam.parent.id);
    const phone = await enrollPhone(t, "Sam's phone");
    setDigest(t.deps.db, sam.parent.id, true, 8);
    t.advance(22 * HOUR + 30 * MIN); // 8:30 AM the next day
    await deviceCall(t, phone.token, "checkin", { status: device({ device_time: t.now() }) });
    await opsTick(t.deps);
    expect(noticesTo(push, laptop)).toEqual([{ title: "Belay: today", body: "Nothing needs you today. The phone is OK.", url: "/" }]);
    t.advance(DAY + 2 * HOUR); // 10:30 AM the day after
    await opsTick(t.deps);
    expect(push.sent).toHaveLength(1);
  });

  it("can be turned off again, and leaves out a parent who was removed", async () => {
    const { t, sam, alex } = await family();
    setDigest(t.deps.db, sam.parent.id, true, 18);
    expect(setDigest(t.deps.db, alex.parent.id, true, 7)).toEqual({ hour: 7, parents: [sam.parent.id, alex.parent.id] });
    expect(setDigest(t.deps.db, sam.parent.id, false, 7)).toEqual({ hour: 7, parents: [alex.parent.id] });
    t.deps.db.prepare("DELETE FROM parents WHERE id = ?").run(alex.parent.id);
    expect(getDigest(t.deps.db)).toEqual({ hour: 7, parents: [] });
    expect(() => setDigest(t.deps.db, sam.parent.id, true, 24)).toThrow();
  });
});

describe("the summary's words", () => {
  const phone = (problems: Problem["code"][], lastSeenAt = T0, revokedAt: number | null = null) =>
    ({ revokedAt, lastSeenAt, enrolledAt: T0 - DAY, problems: problems.map((code) => ({ code, text: `the ${code} text` })) }) as unknown as DeviceView;
  const server = (code: ServerProblem["code"], urgent: boolean, short: string): ServerProblem => ({ code, urgent, short, text: short });

  it("groups phones by kind of problem, most serious first, in counts", () => {
    const items = digestItems({
      phones: [phone(["silent", "phone_reported"], T0 - 14 * HOUR), phone(["silent"], T0 - 3 * DAY), phone(["tampering", "phone_reported", "phone_reported"]), phone(["disconnected"], T0, T0)],
      requests: 2,
      proposals: 1,
      server: [server("backup_failed", false, "the last backup failed"), server("disk_low", true, "the disk is almost full (3% free)")],
      now: T0,
    });
    expect(items).toEqual([
      "someone may be getting around Belay on a phone",
      "the disk is almost full (3% free)",
      "2 phones have been silent up to 3 days",
      "Belay on 2 phones reported a problem",
      "2 requests are waiting",
      "an AI app's proposal is waiting",
      "the last backup failed",
    ]);
  });

  it("still counts a kind of problem it has no words for", () => {
    expect(digestItems({ phones: [phone(["agent_outdated" as Problem["code"]])], requests: 0, proposals: 0, server: [], now: T0 })).toEqual(["a phone needs attention"]);
  });

  it("stays short: the rest become a count", () => {
    const items = Array.from({ length: 12 }, (_, i) => `a fairly long description of problem number ${i + 1}`);
    const notice = digestNotice(items, 2);
    expect(notice.body.length).toBeLessThanOrEqual(300);
    expect(notice.body).toMatch(/^12 things need you: a fairly long description of problem number 1, .*, and \d+ more\.$/);
    expect(digestNotice(["a request is waiting"], 1).body).toBe("1 thing needs you: a request is waiting.");
    expect(digestNotice([], 0).body).toBe("Nothing needs you today.");
    expect(digestNotice([], 3).body).toBe("Nothing needs you today. All 3 phones are OK.");
  });
});
