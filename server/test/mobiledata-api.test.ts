/**
 * Phase 13's mobile data, the server's side (docs/protocol.md, "POST /api/v1/mobile-data"): the
 * device token, 256 KB, at most 31 days of at most 500 apps, strict fields and byte limits;
 * idempotent by day (a day sent again replaces the stored one, apps and all); kept only while a
 * parent measures (otherwise accepted, dropped and counted); never a never-blocked app's own line
 * (its bytes go with Android's); kept as long as the family keeps it, cleaned hourly; Stop
 * collecting deletes it. The policy's `mobile_data` and the report's. Migration 15 keeps every
 * proposal and takes every kind the code has. Made-up apps only.
 */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { Device, Policy } from "../src/device/schemas.js";
import { keptFor, stopCollecting } from "../src/family/collection.js";
import { changeWifiOnly, setMobileDataMeasure } from "../src/family/mobiledata/changes.js";
import { bytesInWords, mobileDataDays, mobileDataSettings } from "../src/family/mobiledata/store.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { ALL_PROPOSAL_KINDS } from "../src/family/proposals.js";
import { loadMigrations, migrate } from "../src/db.js";
import { cleanUp } from "../src/maintenance.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, pkg, signIn, snapshot, testServer, T0 } from "./helpers.js";

const DAY = 86_400_000;
const TODAY = "2026-11-16";
const MB = 1_000_000;

const app = (name: string, bytes: number) => ({ package: name, bytes });
const day = (over: Record<string, unknown> = {}) => ({
  day: TODAY,
  zone: "America/New_York",
  from: T0 - 10 * 3_600_000,
  as_of: T0,
  complete: false,
  mobile_bytes: 412 * MB,
  wifi_bytes: 2100 * MB,
  apps: [app("com.example.video", 350 * MB), app("com.example.blocks", 10 * MB)],
  android_bytes: 52 * MB,
  removed_bytes: 0,
  hotspot_bytes: 0,
  ...over,
});

async function family(opts: { measure?: boolean } = {}) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  if (opts.measure) setMobileDataMeasure(ctx(), phone.deviceId, true, parent);
  const send = (body: unknown, token = phone.token) => deviceCall(t, token, "mobile-data", body);
  const kept = () => mobileDataDays(t.deps.db, phone.deviceId).map((d) => ({ day: d.day, mobile: d.mobileBytes, android: d.androidBytes, apps: d.apps.map((a) => `${a.package} ${a.bytes}`) }));
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, send, kept, policy };
}

describe("POST /api/v1/mobile-data", () => {
  it("needs the phone's token and checks the body: strict fields, 1 to 31 days of at most 500 apps, bytes 0 to 10^14, 256 KB", async () => {
    const { send } = await family({ measure: true });
    expect((await send({ days: [day()] }, "not-a-token")).status).toBe(401);
    for (const bad of [
      {},
      { days: [] },
      { days: [day()], extra: 1 },
      { days: [{ ...day(), websites: [] }] },
      { days: [day({ day: "Monday" })] },
      { days: [day({ mobile_bytes: -1 })] },
      { days: [day({ wifi_bytes: 1e15 })] },
      { days: [day({ apps: [{ ...app("com.example.video", 1), network: "Home Wi-Fi" }] })] },
      { days: [day({ apps: [app("not a package", 1)] })] },
      { days: [day({ complete: "yes" })] },
      { days: Array.from({ length: 32 }, () => day()) },
      { days: [day({ apps: Array.from({ length: 501 }, (_, i) => app(`com.example.app${i}`, 1)) })] },
    ]) {
      const res = await send(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    const many = day({ apps: Array.from({ length: 500 }, (_, i) => app(`com.example.${"x".repeat(200)}${i}`, 1)) });
    const big = { days: [many, { ...many, day: "2026-11-15" }, { ...many, day: "2026-11-14" }] };
    expect((await send(big)).status).toBe(413);
    const ok = await send({ days: [day()] });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ server_time: expect.any(Number), accepted: 1 });
  });

  it("keeps each day once, a newer report replacing it, apps and all", async () => {
    const { send, kept } = await family({ measure: true });
    await send({ days: [day(), day({ day: "2026-11-15", complete: true, apps: [app("com.example.chat", 5 * MB)] })] });
    expect(kept()).toEqual([
      { day: TODAY, mobile: 412 * MB, android: 52 * MB, apps: [`com.example.video ${350 * MB}`, `com.example.blocks ${10 * MB}`] },
      { day: "2026-11-15", mobile: 412 * MB, android: 52 * MB, apps: [`com.example.chat ${5 * MB}`] },
    ]);
    await send({ days: [day({ mobile_bytes: 500 * MB, apps: [app("com.example.video", 450 * MB)] })] });
    expect(kept()[0]).toEqual({ day: TODAY, mobile: 500 * MB, android: 52 * MB, apps: [`com.example.video ${450 * MB}`] });
  });

  it("keeps nothing while the phone doesn't measure: accepted, dropped and counted", async () => {
    const { t, send, kept, phone, ctx, parent } = await family();
    expect((await send({ days: [day()] })).status).toBe(200);
    expect(kept()).toEqual([]);
    setMobileDataMeasure(ctx(), phone.deviceId, true, parent);
    setMobileDataMeasure(ctx(), phone.deviceId, false, parent);
    const res = await send({ days: [day(), day({ day: "2026-11-15" })] });
    expect(await res.json()).toMatchObject({ accepted: 2 });
    expect(kept()).toEqual([]);
    expect(mobileDataSettings(t.deps.db, phone.deviceId)).toMatchObject({ measure: false, dropped: 2 });
    expect(t.logs.some((l) => l.includes("2 days of mobile data use its rules didn't ask for"))).toBe(true);
  });

  it("never keeps a never-blocked app's own line: its bytes go with Android's, calls and texting", async () => {
    const { send, kept } = await family({ measure: true });
    await send({ days: [day({ apps: [app("com.example.video", 350 * MB), app("com.google.android.apps.messaging", 4 * MB), app("com.android.phone", 1 * MB)] })] });
    expect(kept()[0]).toEqual({ day: TODAY, mobile: 412 * MB, android: 57 * MB, apps: [`com.example.video ${350 * MB}`] });
  });

  it("drops a day that isn't real, is after tomorrow in its zone, or is older than the family keeps", async () => {
    const { t, send, kept } = await family({ measure: true });
    await send({ days: [day({ day: "2026-02-30" }), day({ day: "2026-11-18" }), day({ day: "2026-08-01" }), day({ day: "2026-11-17" })] });
    expect(kept().map((d) => d.day)).toEqual(["2026-11-17"]);
    // The hourly clean-up keeps the family's 90 days, then deletes them; fewer when it says so.
    await send({ days: [day({ day: "2026-09-01" })] });
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual(["2026-11-17", "2026-09-01"]);
    updateSettings(t.deps.db, { mobileDataDays: 30 });
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual(["2026-11-17"]);
    t.advance(2 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual(["2026-11-17"]);
  });

  it("Stop collecting turns measuring off and deletes the days, and keeps the Wi-Fi-only apps", async () => {
    const { t, send, kept, phone, ctx, parent, policy } = await family({ measure: true });
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" })], T0));
    changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: [] }, parent);
    await send({ days: [day()] });
    const before = keptFor(t.deps.db, phone.deviceId, "mobile_data", t.now());
    expect(before).toMatchObject({
      goes: ["1 day of mobile data use: how much mobile data each app used, and how much the phone used on Wi-Fi"],
      stopping: "Measuring mobile data turns off: the phone stops sending how much mobile data each app uses.",
      stays: ["The 1 Wi-Fi-only app: it's one of this phone's rules, and collects nothing."],
      anything: true,
    });
    const done = stopCollecting(ctx(), phone.deviceId, "mobile_data", parent, before.fingerprint);
    expect(done.result.deleted).toEqual({ mobile_data_days: 1 });
    expect(kept()).toEqual([]);
    expect(policy().mobile_data).toEqual({ wifi_only: ["com.example.video"], measure: false });
  });
});

describe("the policy and the report", () => {
  it("always sends mobile_data, off by default; measuring is in the activity log", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    expect(policy().mobile_data).toEqual({ wifi_only: [], measure: false });
    const version = policy().version;
    expect(setMobileDataMeasure(ctx(), phone.deviceId, true, parent).result.already).toBe(false);
    expect(policy()).toMatchObject({ version: version + 1, mobile_data: { wifi_only: [], measure: true } });
    expect(setMobileDataMeasure(ctx(), phone.deviceId, true, parent).result.already).toBe(true);
    expect(policy().version).toBe(version + 1);
    const actions = t.deps.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'mobile_data.%'").all();
    expect(actions).toEqual([{ action: "mobile_data.measure_on" }]);
    // Only a person: the types say so, and it's checked at run time too.
    expect(() => setMobileDataMeasure(ctx(), phone.deviceId, false, { kind: "ai", parentId: parent.parentId, clientName: "Claude" } as never)).toThrow(/Only a parent/);
  });

  it("takes the report's mobile_data: the packages Android keeps off mobile data, at most 100", async () => {
    const { t, phone } = await family();
    const report = (mobileData: unknown) => deviceCall(t, phone.token, "checkin", { status: { ...device(), enforcement: { policy_version: 1, mobile_data: mobileData } } });
    expect((await report({ wifi_only: ["com.example.video"] })).status).toBe(200);
    expect((await report({ wifi_only: ["not a package"] })).status).toBe(400);
    expect((await report({ wifi_only: [], extra: true })).status).toBe(400);
    expect((await report({ wifi_only: Array.from({ length: 101 }, (_, i) => `com.example.app${i}`) })).status).toBe(400);
    expect((await report(null)).status).toBe(200);
    expect(Device.shape.enforcement.unwrap().unwrap().shape.mobile_data).toBeDefined();
  });

  it("words bytes the way phones show a data plan", () => {
    expect([0, 1, 999, 1000, 1500, 999_999, 12_345_678, 350_000_000, 2_100_000_000].map(bytesInWords)).toEqual([
      "0 bytes",
      "1 byte",
      "999 bytes",
      "1 KB",
      "1.5 KB",
      "1 MB",
      "12 MB",
      "350 MB",
      "2.1 GB",
    ]);
  });
});

describe("migration 15 (mobile data)", () => {
  it("keeps every proposal, takes mobile_data ones, and the check takes every kind the code has", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(
      db,
      loadMigrations().filter((m) => m.version < 15),
    );
    db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES ('parent-1', 'Sam', 'sam', 'x', 0)").run();
    db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'Alex''s phone', 'h', 0)").run();
    db.prepare("INSERT INTO proposals (id, device_id, kind, payload, reason, client_name, parent_id, created_at, status) VALUES ('p-1', 'phone-1', 'calls', '{}', 'x', 'Claude', 'parent-1', 0, 'pending')").run();
    expect(() => db.prepare("INSERT INTO proposals (id, device_id, kind, reason, client_name, created_at) VALUES ('p-0', 'phone-1', 'mobile_data', 'x', 'Claude', 0)").run()).toThrow(/CHECK/);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(loadMigrations().at(-1)?.version);
    expect(db.prepare("SELECT id, kind, status, parent_id FROM proposals").all()).toEqual([{ id: "p-1", kind: "calls", status: "pending", parent_id: "parent-1" }]);
    // Every kind the code has, and no other.
    const insert = db.prepare("INSERT INTO proposals (id, device_id, kind, reason, client_name, created_at) VALUES (?, 'phone-1', ?, 'x', 'Claude', 0)");
    for (const kind of ALL_PROPOSAL_KINDS) insert.run(`p-${kind}`, kind);
    expect(() => insert.run("p-x", "measure")).toThrow(/CHECK/);
    // The new tables go with the phone.
    db.prepare("INSERT INTO mobile_data_settings (device_id, measure, changed_at) VALUES ('phone-1', 1, 0)").run();
    db.prepare("INSERT INTO wifi_only_apps (device_id, package, added_at, added_by, parent_id) VALUES ('phone-1', 'com.example.video', 0, 'parent', 'parent-1')").run();
    expect(() => db.prepare("INSERT INTO wifi_only_apps (device_id, package, added_at, added_by) VALUES ('phone-1', 'com.example.chat', 0, 'kid')").run()).toThrow(/CHECK/);
    db.prepare(
      "INSERT INTO mobile_data_days (device_id, day, zone, from_at, as_of, complete, mobile_bytes, wifi_bytes, android_bytes, removed_bytes, hotspot_bytes, received_at) VALUES ('phone-1', '2026-11-16', 'UTC', 0, 0, 0, 1, 1, 0, 0, 0, 0)",
    ).run();
    db.prepare("INSERT INTO mobile_data_apps (device_id, day, package, bytes) VALUES ('phone-1', '2026-11-16', 'com.example.video', 1)").run();
    expect(() => db.prepare("INSERT INTO mobile_data_apps (device_id, day, package, bytes) VALUES ('phone-1', '2026-11-16', 'com.example.chat', 0)").run()).toThrow(/CHECK/);
    db.prepare("DELETE FROM devices WHERE id = 'phone-1'").run();
    for (const table of ["proposals", "mobile_data_settings", "wifi_only_apps", "mobile_data_days", "mobile_data_apps"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
  });
});
