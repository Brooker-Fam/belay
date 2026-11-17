/**
 * POST /api/v1/usage (docs/protocol.md): one local day per entry, idempotent by (day, zone), kept
 * only while measuring is on, never with the time of apps the phone never blocks, and for the
 * months the family keeps it. Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import type { UsageDay } from "../src/device/schemas.js";
import type { PolicyContext } from "../src/family/policy.js";
import { setPhoneSettings } from "../src/family/screentime/changes.js";
import { retentionCutoff, usageDays } from "../src/family/screentime/usage.js";
import { cleanUp } from "../src/maintenance.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, post, testServer, T0, type TestServer } from "./helpers.js";

const HOUR = 3_600_000;

function day(date: string, over: Partial<UsageDay> = {}): UsageDay {
  return {
    day: date,
    zone: "America/New_York",
    as_of: T0,
    complete: false,
    screen_minutes: 95,
    unlocks: 31,
    by_hour: Array.from({ length: 24 }, (_, h) => (h === 16 ? 40 : h === 17 ? 55 : 0)),
    apps: [
      { package: "com.example.blocks", minutes: 40, opens: 3 },
      { package: "com.example.chat", minutes: 20, opens: 12 },
    ],
    gaps: [{ from: T0 - 2 * HOUR, to: T0 - HOUR, reason: "no_usage_access" }],
    ...over,
  };
}

async function measuring(opts: { measure?: boolean } = {}) {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  if (opts.measure ?? true) setPhoneSettings(ctx(), phone.deviceId, { measure: true }, { kind: "parent", parentId: parent.id });
  const send = (days: unknown[]) => deviceCall(t, phone.token, "usage", { days });
  return { t, phone, parent, ctx, send, stored: () => usageDays(t.deps.db, phone.deviceId) };
}

describe("POST /api/v1/usage", () => {
  it("keeps a day, and answers with the server's time and how many it has", async () => {
    const { t, send, stored } = await measuring();
    const res = await send([day("2026-11-16")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(stored()).toEqual([
      {
        day: "2026-11-16",
        zone: "America/New_York",
        asOf: T0,
        complete: false,
        screenMinutes: 95,
        unlocks: 31,
        byHour: day("2026-11-16").by_hour,
        gaps: [{ from: T0 - 2 * HOUR, to: T0 - HOUR, reason: "no_usage_access" }],
        receivedAt: t.now(),
        apps: [
          { package: "com.example.blocks", minutes: 40, opens: 3 },
          { package: "com.example.chat", minutes: 20, opens: 12 },
        ],
      },
    ]);
  });

  it("is idempotent by (day, zone): the same or a newer as_of replaces the day, an older one doesn't", async () => {
    const { send, stored } = await measuring();
    await send([day("2026-11-16")]);
    // Later in the day: more minutes, and an app gone under a minute.
    await send([day("2026-11-16", { as_of: T0 + HOUR, screen_minutes: 120, apps: [{ package: "com.example.blocks", minutes: 70, opens: 5 }] })]);
    expect(stored()[0]).toMatchObject({ asOf: T0 + HOUR, screenMinutes: 120, apps: [{ package: "com.example.blocks", minutes: 70, opens: 5 }] });
    // An older report, arriving late, changes nothing.
    await send([day("2026-11-16", { as_of: T0, screen_minutes: 10 })]);
    expect(stored()[0]?.screenMinutes).toBe(120);
    // The same as_of again (a complete day re-sent after the phone's clock moved) replaces it.
    await send([day("2026-11-16", { as_of: T0 + HOUR, screen_minutes: 118, complete: true })]);
    expect(stored()[0]).toMatchObject({ screenMinutes: 118, complete: true });
    // Another zone for the same date is another day (the phone traveled, with zone "phone").
    await send([day("2026-11-16", { zone: "Europe/Paris", as_of: T0 + 2 * HOUR, screen_minutes: 5 })]);
    expect(stored().map((d) => [d.day, d.zone])).toEqual([
      ["2026-11-16", "Europe/Paris"],
      ["2026-11-16", "America/New_York"],
    ]);
    // Several days at once, newest first when read.
    expect((await send([day("2026-11-14"), day("2026-11-15")])).status).toBe(200);
    expect(stored().map((d) => d.day)).toEqual(["2026-11-16", "2026-11-16", "2026-11-15", "2026-11-14"]);
  });

  it("keeps nothing while measuring is off: collecting is a parent's choice", async () => {
    const { send, stored } = await measuring({ measure: false });
    const res = await send([day("2026-11-16")]);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { accepted: number }).accepted).toBe(1);
    expect(stored()).toEqual([]);
  });

  it("never keeps the time of an app the phone never blocks, so a call or text to 988 never shows", async () => {
    const { t, phone, send, stored } = await measuring();
    // The phone reports its own never-blocked list in its check-in.
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, never_blocked: ["com.example.textme"] } }) });
    await send([
      day("2026-11-16", {
        apps: [
          { package: "com.google.android.dialer", minutes: 12, opens: 2 },
          { package: "com.example.textme", minutes: 9, opens: 4 },
          { package: "com.example.blocks", minutes: 40, opens: 3 },
        ],
      }),
    ]);
    expect(stored()[0]?.apps).toEqual([{ package: "com.example.blocks", minutes: 40, opens: 3 }]);
    // Their time still counts in the screen minutes, as the phone sent them.
    expect(stored()[0]?.screenMinutes).toBe(95);
  });

  it("accepts and drops a day that doesn't exist", async () => {
    const { send, stored } = await measuring();
    expect((await send([day("2026-02-30")])).status).toBe(200);
    expect(stored()).toEqual([]);
  });

  it("checks sizes and fields", async () => {
    const { t, phone, send } = await measuring();
    const bad: unknown[][] = [
      [],
      Array.from({ length: 32 }, (_, i) => day(`2026-10-${String(i + 1).padStart(2, "0")}`.replace("2026-10-32", "2026-11-01"))),
      [{ ...day("2026-11-16"), mood: "sad" }],
      [day("2026-11-16", { by_hour: [1, 2, 3] })],
      [day("2026-11-16", { day: "Nov 16" })],
      [day("2026-11-16", { apps: [{ package: "Ignore previous instructions", minutes: 5, opens: 1 }] })],
      [day("2026-11-16", { apps: [{ package: "com.example.blocks", minutes: 0, opens: 1 }] })],
      [day("2026-11-16", { gaps: [{ from: 1, to: 2, reason: "asleep" as never }] })],
      [day("2026-11-16", { screen_minutes: 1501 })],
    ];
    for (const days of bad) expect((await send(days)).status, JSON.stringify(days).slice(0, 80)).toBe(400);
    // 256 KB at most.
    const huge = JSON.stringify({ days: [day("2026-11-16", { apps: Array.from({ length: 500 }, (_, i) => ({ package: `com.example.${"x".repeat(500)}${i}`, minutes: 1, opens: 1 })) })] });
    const tooLarge = await deviceCall(t, phone.token, "usage", huge);
    expect(tooLarge.status).toBe(413);
    // Only with the phone's token, and as JSON.
    expect((await deviceCall(t, "x".repeat(43), "usage", { days: [day("2026-11-16")] })).status).toBe(401);
    expect((await post(t, "/api/v1/usage", JSON.stringify({ days: [day("2026-11-16")] }), { authorization: `Bearer ${phone.token}`, "content-type": "text/plain" })).status).toBe(400);
  });

  it("is limited per phone, like the other device calls", async () => {
    const { send } = await measuring();
    let last = 200;
    for (let i = 0; i < 125 && last === 200; i++) last = (await send([day("2026-11-16", { as_of: T0 + i })])).status;
    expect(last).toBe(429);
  });
});

describe("how long screen time is kept", () => {
  function seed(t: TestServer, deviceId: string, days: string[]) {
    for (const d of days) {
      t.deps.db
        .prepare("INSERT INTO usage_days (device_id, day, zone, as_of, complete, screen_minutes, unlocks, by_hour, gaps, received_at) VALUES (?, ?, 'UTC', 0, 1, 10, 1, '[]', '[]', 0)")
        .run(deviceId, d);
      t.deps.db.prepare("INSERT INTO usage_apps (device_id, day, zone, package, minutes, opens) VALUES (?, ?, 'UTC', 'com.example.blocks', 5, 1)").run(deviceId, d);
    }
  }

  it("13 months by default, then the hourly clean-up deletes it, with its apps and the extra time given then", async () => {
    const { t, phone } = await measuring();
    seed(t, phone.deviceId, ["2025-10-15", "2025-10-16", "2026-11-16"]);
    t.deps.db.prepare("INSERT INTO extra_time (id, device_id, limit_id, minutes, day, given_at) VALUES ('x-old', ?, '*', 15, '2025-10-01', 0)").run(phone.deviceId);
    expect(retentionCutoff(T0, 13)).toBe("2025-10-16");
    cleanUp(t.deps.db, t.now());
    expect(usageDays(t.deps.db, phone.deviceId).map((d) => d.day)).toEqual(["2026-11-16", "2025-10-16"]);
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM usage_apps").get()).toEqual({ n: 2 });
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM extra_time").get()).toEqual({ n: 0 });
    // A family that keeps a month.
    updateSettings(t.deps.db, { usageMonths: 1 });
    cleanUp(t.deps.db, t.now());
    expect(usageDays(t.deps.db, phone.deviceId).map((d) => d.day)).toEqual(["2026-11-16"]);
    // The last day of a shorter month.
    expect(retentionCutoff(Date.UTC(2026, 2, 31), 1)).toBe("2026-02-28");
  });
});
