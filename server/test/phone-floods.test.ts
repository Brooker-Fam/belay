/**
 * What one phone token (a stolen, sold or rooted phone) can make the server keep, however it
 * sends it (docs/protocol.md, "What the server keeps"): new requests, fixes and app changes an
 * hour, settled requests, fixes, arrivals, app changes, apps and app lists in all, and usage days
 * only for dates a phone can have counted. Answered 429 with Retry-After past a rate, like the
 * other limits, except app changes, which are accepted and not kept. Made-up apps and places only.
 */
import { describe, expect, it } from "vitest";
import { APP_LIMITS } from "../src/device/apps.js";
import { savePlace, setLocation } from "../src/family/location/changes.js";
import { MAX_KEPT_FIXES, MAX_KEPT_PLACE_EVENTS, saveLocations } from "../src/family/location/fixes.js";
import { markHelpSeen } from "../src/family/kidside-changes.js";
import { answerRequest, decideApp, type PolicyContext } from "../src/family/policy.js";
import { MAX_SETTLED_REQUESTS, MAX_UNSEEN_HELP, getRequest, unseenHelp } from "../src/family/requests.js";
import { setPhoneSettings } from "../src/family/screentime/changes.js";
import { usageDays } from "../src/family/screentime/usage.js";
import { cleanUp } from "../src/maintenance.js";
import { databaseBytes } from "../src/ops/backups.js";
import { appState, deviceCall, enrollPhone, event, fix, pkg, signIn, snapshot, SPOT, testServer, T0, type TestServer } from "./helpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const words = (n: number) => "x".repeat(n);

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const requests = (list: Record<string, unknown>[]) => deviceCall(t, phone.token, "requests", { requests: list });
  const count = (where = "1") =>
    t.deps.db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM requests WHERE device_id = ? AND ${where}`).get(phone.deviceId)?.n ?? 0;
  return { t, phone, ctx, parent, requests, count };
}

let made = 0;
/** A hundred app requests that arrive already withdrawn: the cheapest rows a phone could send. */
const withdrawnBatch = (t: TestServer) =>
  Array.from({ length: 100 }, () => {
    made++;
    return { id: `withdrawn-${String(made).padStart(6, "0")}`, kind: "app", package: "com.example.game", label: words(200), reason: words(500), asked_at: t.now(), withdrawn_at: t.now() };
  });

describe("requests a phone sends", () => {
  it("count toward 300 new ones an hour, withdrawn on arrival too: past that, 429 with Retry-After, and none of them kept", async () => {
    const { t, requests, count } = await family();
    for (let call = 0; call < 3; call++) expect((await requests(withdrawnBatch(t))).status).toBe(200);
    t.advance(10 * 60_000);
    const limited = await requests(withdrawnBatch(t));
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    // Ten minutes into the hour that started with the first one: 50 minutes to wait.
    expect(Number(limited.headers.get("retry-after"))).toBe(50 * 60);
    expect(count()).toBe(300);
    // An hour after the first, the phone sends them again, and they're kept.
    t.advance(50 * 60_000);
    expect((await requests(withdrawnBatch(t))).status).toBe(200);
    expect(count()).toBe(400);
  });

  it(`keep at most ${MAX_SETTLED_REQUESTS} that wait for no one: the phone's own go first, a parent's answers stay`, async () => {
    const { t, phone, ctx, parent, requests, count } = await family();
    const before = databaseBytes(t.deps.db);
    // One a parent answers, before the flood.
    expect((await requests([{ id: "answered-000001", kind: "app", package: "com.example.trail", label: "Trail Maps", asked_at: t.now() }])).status).toBe(200);
    answerRequest(ctx(), phone.deviceId, "answered-000001", "declined", parent, "Not this week");
    t.advance(HOUR);
    // Withdrawn on arrival, asked again for the same app, and "I agree" again and again: all settled by the phone.
    for (let hour = 0; hour < 5; hour++) {
      for (let call = 0; call < 2; call++) expect((await requests(withdrawnBatch(t))).status).toBe(200);
      const again = Array.from({ length: 50 }, (_, i) => ({ id: `again-${hour}-${String(i).padStart(4, "0")}`, kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() + i }));
      const agree = Array.from({ length: 50 }, (_, i) => ({ id: `agree-${hour}-${String(i).padStart(4, "0")}`, kind: "agreement", version: 1, answer: "agree", asked_at: t.now() + i }));
      expect((await requests([...again, ...agree])).status).toBe(200);
      t.advance(HOUR);
    }
    // 5 hours of 300: 1 waiting (the newest "asked again"), the rest settled, and only the newest settled are kept.
    expect(count("status = 'pending'")).toBe(1);
    expect(count(`status != 'pending'`)).toBe(MAX_SETTLED_REQUESTS);
    expect(getRequest(t.deps.db, phone.deviceId, "answered-000001")).toMatchObject({ status: "declined", note: "Not this week" });
    expect(getRequest(t.deps.db, phone.deviceId, "withdrawn-000001")).toBeNull();
    expect(getRequest(t.deps.db, phone.deviceId, `withdrawn-${String(made).padStart(6, "0")}`)?.status).toBe("withdrawn");
    // What the flood could add to the database is bounded: about a megabyte, not a megabyte a minute.
    expect(databaseBytes(t.deps.db) - before).toBeLessThan(3_000_000);
  });

  it("that arrive withdrawn count toward the help no parent has seen, and a help request is never held back by the hour's limit", async () => {
    const { t, phone, ctx, parent, requests } = await family();
    // The hour's limit used up by app requests...
    for (let call = 0; call < 3; call++) await requests(withdrawnBatch(t));
    expect((await requests(withdrawnBatch(t))).status).toBe(429);
    // ...holds back no help request.
    expect((await requests([{ id: "help-real-0001", kind: "help", reason: "I'm lost", asked_at: t.now() }])).status).toBe(200);
    // Withdrawn on arrival, help still waits for a parent to see it: at most 100 of them, then 429.
    const withdrawnHelp = (from: number) => Array.from({ length: 50 }, (_, i) => ({ id: `help-${String(from + i).padStart(6, "0")}`, kind: "help", reason: `fake ${from + i}`, asked_at: t.now(), withdrawn_at: t.now() }));
    expect((await requests(withdrawnHelp(0))).status).toBe(200);
    const flood = await requests(withdrawnHelp(50));
    expect(flood.status).toBe(429);
    expect(Number(flood.headers.get("retry-after"))).toBe(3600);
    expect(unseenHelp(t.deps.db, phone.deviceId)).toHaveLength(MAX_UNSEEN_HELP);
    // A parent seeing them makes room again.
    markHelpSeen(ctx(), phone.deviceId, "help-000000", parent);
    expect((await requests([{ id: "help-real-0002", kind: "help", asked_at: t.now() }])).status).toBe(200);
  });

  it("go a year after they last changed, help requests aside: those stay until the phone is deleted", async () => {
    const { t, phone, ctx, parent, requests, count } = await family();
    await requests([
      { id: "request-0001", kind: "app", package: "com.example.trail", label: "Trail Maps", asked_at: t.now() },
      { id: "request-0002", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() },
      { id: "request-0003", kind: "talk", reason: "About the weekend", asked_at: t.now(), withdrawn_at: t.now() },
      { id: "request-0004", kind: "help", asked_at: t.now(), withdrawn_at: t.now() },
    ]);
    // Answered a month later: its year starts then.
    t.advance(30 * DAY);
    answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, null);
    t.advance(336 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(getRequest(t.deps.db, phone.deviceId, "request-0003")).toBeNull();
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("approved");
    // Still waiting: kept, however old.
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")?.status).toBe("pending");
    t.advance(30 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toBeNull();
    expect(getRequest(t.deps.db, phone.deviceId, "request-0004")?.kind).toBe("help");
    expect(count()).toBe(2);
  });
});

describe("fixes a phone sends", () => {
  it("lost-mode and help fixes are kept with location off, but at most 600 new ones an hour: past that, 429", async () => {
    const { t, phone } = await family();
    const send = (n: number, at = t.now()) => deviceCall(t, phone.token, "locations", { fixes: Array.from({ length: n }, (_, i) => fix({ reason: i % 2 ? "lost" : "help", at })), place_events: [] });
    for (let call = 0; call < 3; call++) expect((await send(200)).status).toBe(200);
    const limited = await send(200);
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBe(3600);
    const kept = () => t.deps.db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM fixes WHERE device_id = ?").get(phone.deviceId)?.n;
    expect(kept()).toBe(600);
    // The same fixes sent again an hour on: kept then (the call answered 429 kept none of its new ones).
    t.advance(HOUR);
    expect((await send(10)).status).toBe(200);
    expect(kept()).toBe(610);
  });

  it(`at most ${MAX_KEPT_FIXES} kept in all, the oldest going first; the fix a kid shared with a help request is kept with it`, async () => {
    const { t, phone, requests } = await family();
    const shared = fix({ reason: "help" });
    await requests([{ id: "help-0001", kind: "help", asked_at: t.now(), location: shared }]);
    const first = fix({ reason: "lost" });
    saveLocations(t.deps.db, phone.deviceId, { fixes: [first], place_events: [] }, t.now());
    for (let call = 0; call < MAX_KEPT_FIXES / 200 + 1; call++) {
      t.advance(1000);
      saveLocations(t.deps.db, phone.deviceId, { fixes: Array.from({ length: 200 }, () => fix({ reason: "lost" })), place_events: [] }, t.now());
    }
    const rows = t.deps.db.prepare<[string], { alone: number; withRequest: number }>(
      "SELECT SUM(request_id IS NULL) AS alone, SUM(request_id IS NOT NULL) AS withRequest FROM fixes WHERE device_id = ?",
    ).get(phone.deviceId);
    expect(rows).toEqual({ alone: MAX_KEPT_FIXES, withRequest: 1 });
    expect(t.deps.db.prepare("SELECT 1 FROM fixes WHERE device_id = ? AND id = ?").get(phone.deviceId, first.id)).toBeUndefined();
    expect(getRequest(t.deps.db, phone.deviceId, "help-0001")).toMatchObject({ fix: { id: shared.id } });
  });

  it(`arrivals and departures: at most ${MAX_KEPT_PLACE_EVENTS} kept, the oldest going first`, async () => {
    const { t, phone, ctx, parent } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    const place = savePlace(ctx(), phone.deviceId, { name: "School", ...SPOT, radiusM: 150, notify: [] }, parent).result.place;
    let n = 0;
    for (let call = 0; call < MAX_KEPT_PLACE_EVENTS / 200 + 1; call++) {
      t.advance(1000);
      const events = Array.from({ length: 200 }, () => ({ id: `event-${String(n++).padStart(6, "0")}`, place_id: place.id, kind: "arrived" as const, at: t.now(), fix_id: "fix-00001" }));
      saveLocations(t.deps.db, phone.deviceId, { fixes: [], place_events: events }, t.now());
    }
    const ids = t.deps.db.prepare<[string], { id: string }>("SELECT id FROM place_events WHERE device_id = ? ORDER BY id").all(phone.deviceId).map((r) => r.id);
    expect(ids).toHaveLength(MAX_KEPT_PLACE_EVENTS);
    expect(ids[0]).toBe("event-000200");
  });
});

describe("usage days a phone sends", () => {
  async function measuring() {
    const f = await family();
    setPhoneSettings(f.ctx(), f.phone.deviceId, { measure: true }, f.parent);
    const send = (days: unknown[]) => deviceCall(f.t, f.phone.token, "usage", { days });
    const stored = () => usageDays(f.t.deps.db, f.phone.deviceId).map((d) => [d.day, d.zone]);
    return { ...f, send, stored };
  }
  const day = (date: string, zone = "America/New_York") => ({ day: date, zone, as_of: T0, complete: false, screen_minutes: 5, unlocks: 1, by_hour: Array(24).fill(0), apps: [], gaps: [] });

  it("keeps only dates a phone can have counted by now: today in their zone and a day of skew, and none the family no longer keeps", async () => {
    const { send, stored } = await measuring();
    // T0 is Monday Nov 16, 10:00 in New York: the 17th is a day of skew, the 18th can't be counted yet.
    const res = await send([day("2026-11-16"), day("2026-11-17"), day("2026-11-18"), day("2999-12-31"), day("2025-10-15"), day("2025-10-16")]);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 6 });
    expect(stored()).toEqual([
      ["2026-11-17", "America/New_York"],
      ["2026-11-16", "America/New_York"],
      ["2025-10-16", "America/New_York"],
    ]);
    // A zone that isn't a real one could be any: UTC's date, the most a zone is ahead, and a day.
    await send([day("2026-11-18", "zone-1"), day("2026-11-19", "zone-1")]);
    expect(stored()[0]).toEqual(["2026-11-18", "zone-1"]);
  });

  it("keeps a date in at most 3 zones: one sent in another is dropped", async () => {
    const { t, phone, send, stored } = await measuring();
    await send(["zone-1", "zone-2", "zone-3", "zone-4", "zone-5"].map((z) => day("2026-11-16", z)));
    expect(stored().map(([, z]) => z).sort()).toEqual(["zone-1", "zone-2", "zone-3"]);
    // One of the three sent again still replaces what's kept.
    expect((await send([{ ...day("2026-11-16", "zone-2"), as_of: T0 + HOUR, screen_minutes: 9 }])).status).toBe(200);
    expect(usageDays(t.deps.db, phone.deviceId).find((d) => d.zone === "zone-2")?.screenMinutes).toBe(9);
  });

  it("the hourly clean-up deletes a day dated in the future that was kept before", async () => {
    const { t, phone, stored } = await measuring();
    t.deps.db
      .prepare("INSERT INTO usage_days (device_id, day, zone, as_of, complete, screen_minutes, unlocks, by_hour, gaps, received_at) VALUES (?, '2999-12-31', 'UTC', 0, 1, 10, 1, '[]', '[]', 0)")
      .run(phone.deviceId);
    cleanUp(t.deps.db, t.now());
    expect(stored()).toEqual([]);
  });
});

describe("app changes and app lists a phone sends", () => {
  async function apps(more: string[] = []) {
    const f = await family();
    const { t, phone } = f;
    const events = (list: unknown[]) => deviceCall(t, phone.token, "events", { events: list });
    const inventory = (body: unknown) => deviceCall(t, phone.token, "inventory", body);
    const rows = (table: string, where = "1") => t.deps.db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM ${table} WHERE device_id = ? AND ${where}`).get(phone.deviceId)?.n ?? 0;
    // The phone's first app list: the baseline, which records no changes.
    expect((await inventory(snapshot(["com.example.chess", "com.example.maps", ...more].map((name) => pkg(name)), t.now()))).status).toBe(200);
    /** The apps as the server has them now, as the phone would list them. */
    const asKept = () =>
      t.deps.db
        .prepare<[string], { package: string; version_code: number; first_install_time: number; last_update_time: number }>(
          "SELECT package, version_code, first_install_time, last_update_time FROM apps WHERE device_id = ? AND present = 1 ORDER BY package",
        )
        .all(phone.deviceId)
        .map(({ package: name, ...times }) => pkg(name, times));
    return { ...f, events, inventory, rows, asKept };
  }
  let made = 0;
  /** Updates of apps on the phone, each a new event: the cheapest app changes a phone could send. */
  const updates = (n: number, names: string[]) =>
    Array.from({ length: n }, () => {
      made++;
      return event("updated", names[made % names.length] ?? "com.example.chess", { label: words(200), to: { name: `1.${made}`, code: 100 + made }, happened_at: T0 + made });
    });

  it("events: a few thousand new app changes kept an hour; past that accepted and not kept, never 429, and the phone's next app list catches the apps up", async () => {
    // Spread over many apps, as a phone's updates are.
    const many = Array.from({ length: 50 }, (_, i) => `com.example.app${String(i).padStart(2, "0")}`);
    const { t, phone, events, inventory, rows, asKept } = await apps(many);
    const budget = t.deps.limits.appChangesPerPhone.limit;
    for (let call = 0; call < budget / 1000; call++) {
      const res = await events(updates(1000, many));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ accepted: 1000, duplicates: 0 });
    }
    expect(rows("app_events")).toBe(budget);
    // Past the hour's budget: answered 200 (the phone sends its events in the same queue as the kid's
    // requests, which must never wait behind them), and neither kept nor applied.
    const past = await events([...updates(10, many), event("updated", "com.example.chess", { to: { code: 555 }, happened_at: T0 + 1e7 }), event("installed", "com.example.newgame")]);
    expect(past.status).toBe(200);
    expect(await past.json()).toMatchObject({ accepted: 12 });
    expect(rows("app_events")).toBe(budget);
    expect(appState(t, phone.deviceId, "com.example.chess")?.version_code).toBe(10);
    expect(appState(t, phone.deviceId, "com.example.newgame")).toBeUndefined();
    // The next app list puts the apps right; its changes are past the budget too, so not kept as changes.
    const changed = asKept().map((p) => (p.package === "com.example.chess" ? { ...p, version_code: 555, last_update_time: T0 + 1e7 } : p));
    const list = await inventory(snapshot([...changed, pkg("com.example.newgame")], t.now()));
    expect(await list.json()).toMatchObject({ duplicate: false, backfilled: 0 });
    expect(appState(t, phone.deviceId, "com.example.chess")?.version_code).toBe(555);
    expect(appState(t, phone.deviceId, "com.example.newgame")?.present).toBe(1);
    expect(rows("app_events")).toBe(budget);
    // An hour after the first, changes are kept again, the phone's and those found in its lists.
    t.advance(HOUR);
    expect(await (await events(updates(5, many))).json()).toMatchObject({ accepted: 5 });
    const later = await inventory(snapshot(asKept().filter((p) => p.package !== "com.example.newgame"), t.now()));
    expect(await later.json()).toMatchObject({ backfilled: 1 });
    expect(rows("app_events")).toBe(budget + 6);
  });

  it(`keep at most ${APP_LIMITS.changes} app changes in all: the ones that arrived first go`, async () => {
    const { t, phone, events, rows } = await apps();
    // A year of changes already kept, made up straight in the database.
    const insert = t.deps.db.prepare(
      "INSERT INTO app_events (device_id, id, kind, package, label, detected_at, detection, backfilled, received_at, at) VALUES (?, ?, 'updated', 'com.example.chess', 'Chess', ?, 'broadcast', 0, ?, ?)",
    );
    t.deps.db.transaction(() => {
      for (let i = 0; i < APP_LIMITS.changes; i++) insert.run(phone.deviceId, `old-${String(i).padStart(6, "0")}`, T0 - DAY + i, T0 - DAY + i, T0 - DAY + i);
    })();
    const fresh = updates(10, ["com.example.chess", "com.example.maps"]);
    expect((await events(fresh)).status).toBe(200);
    expect(rows("app_events")).toBe(APP_LIMITS.changes);
    const kept = t.deps.db.prepare<[string], { id: string }>("SELECT id FROM app_events WHERE device_id = ? ORDER BY received_at, rowid LIMIT 1").get(phone.deviceId);
    expect(kept?.id).toBe("old-000010");
    expect(rows("app_events", `id IN (${fresh.map((e) => `'${e.id}'`).join(", ")})`)).toBe(10);
  });

  it(`at most ${APP_LIMITS.present} apps on the phone: a change that would add one more isn't kept`, async () => {
    const { t, phone, events, rows } = await apps();
    const insert = t.deps.db.prepare(
      "INSERT INTO apps (device_id, package, label, version_code, present, first_seen_at, install_seen_at) VALUES (?, ?, 'Made up', 1, 1, ?, ?)",
    );
    t.deps.db.transaction(() => {
      for (let i = rows("apps", "present = 1"); i < APP_LIMITS.present; i++) insert.run(phone.deviceId, `com.example.many${i}`, T0, T0);
    })();
    const install = event("installed", "com.example.onemore");
    expect(await (await events([install])).json()).toMatchObject({ accepted: 1 });
    expect(appState(t, phone.deviceId, "com.example.onemore")).toBeUndefined();
    expect(rows("app_events", `id = '${install.id}'`)).toBe(0);
    // One removed makes room for one more.
    await events([event("removed", "com.example.many7"), event("installed", "com.example.onemore", { id: "event-onemore-again" })]);
    expect(appState(t, phone.deviceId, "com.example.onemore")?.present).toBe(1);
    expect(rows("apps", "present = 1")).toBe(APP_LIMITS.present);
  });

  it(`keep at most ${APP_LIMITS.removed} apps that aren't on the phone any more, besides every one a parent decided on or reviewed`, async () => {
    const { t, phone, ctx, parent, inventory, rows } = await apps();
    // Two removed long ago that a parent blocked and reviewed, then a flood of made-up removed apps.
    const insert = t.deps.db.prepare(
      "INSERT INTO apps (device_id, package, label, version_code, present, first_seen_at, install_seen_at, removed_at) VALUES (?, ?, 'Made up', 1, 0, ?, ?, ?)",
    );
    t.deps.db.transaction(() => {
      insert.run(phone.deviceId, "com.example.blocked", T0 - 2 * DAY, T0 - 2 * DAY, T0 - 2 * DAY);
      insert.run(phone.deviceId, "com.example.reviewed", T0 - 2 * DAY, T0 - 2 * DAY, T0 - 2 * DAY);
      for (let i = 0; i < APP_LIMITS.removed; i++) insert.run(phone.deviceId, `com.example.gone${String(i).padStart(4, "0")}`, T0 - DAY, T0 - DAY, T0 - DAY + i);
    })();
    decideApp(ctx(), phone.deviceId, "com.example.blocked", "blocked", parent);
    t.deps.db
      .prepare("INSERT INTO reviews (device_id, package, reviewed_at, parent_id, via, note, version_code, permissions) VALUES (?, 'com.example.reviewed', ?, ?, 'web', 'Fine for now', 1, '[]')")
      .run(phone.deviceId, T0 - 2 * DAY, parent.parentId);
    // The phone's next list: maps removed, one more that isn't on the phone any more.
    expect((await inventory(snapshot([pkg("com.example.chess")], t.now()))).status).toBe(200);
    expect(rows("apps", "present = 0")).toBe(APP_LIMITS.removed + 2);
    expect(appState(t, phone.deviceId, "com.example.maps")?.present).toBe(0);
    expect(appState(t, phone.deviceId, "com.example.gone0000")).toBeUndefined();
    expect(appState(t, phone.deviceId, "com.example.gone0001")?.present).toBe(0);
    expect(appState(t, phone.deviceId, "com.example.blocked")?.present).toBe(0);
    expect(appState(t, phone.deviceId, "com.example.reviewed")?.present).toBe(0);
  });

  it(`keep the record of the newest ${APP_LIMITS.lists} app lists`, async () => {
    const { t, phone, inventory, rows } = await apps();
    const insert = t.deps.db.prepare("INSERT INTO snapshots (device_id, snapshot_id, taken_at, package_count, received_at, backfilled) VALUES (?, ?, ?, 2, ?, 0)");
    t.deps.db.transaction(() => {
      // With the baseline, as many as are kept.
      for (let i = 0; i < APP_LIMITS.lists - 1; i++) insert.run(phone.deviceId, `old-list-${String(i).padStart(5, "0")}`, T0 - DAY + i, T0 - DAY + i);
    })();
    const res = await inventory(snapshot([pkg("com.example.chess"), pkg("com.example.maps"), pkg("com.example.drawing")], t.now()));
    // Still not a baseline: the new app is found.
    expect(await res.json()).toMatchObject({ duplicate: false, backfilled: 1 });
    expect(rows("snapshots")).toBe(APP_LIMITS.lists);
    expect(rows("snapshots", "snapshot_id = 'old-list-00000'")).toBe(0);
    expect(rows("snapshots", "snapshot_id = 'old-list-00001'")).toBe(1);
  });
});
