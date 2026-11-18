/**
 * Phase 11's "stop collecting" (docs/privacy.md, "How long it's kept"): per data category, the
 * confirmation lists exactly what goes, and stopping turns the phone's switch off (measuring,
 * location) and deletes that category's rows, and only those, in the activity log. Every table
 * with a phone's rows belongs to a category or is a record. Made-up apps, places and words only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { saveContact, setCalls } from "../src/family/calls/changes.js";
import { COLLECTED, COLLECTED_TABLES, PHONE_KEEPS_REQUESTS_MS, RECORDS, keptAbout, keptFor, stopCollecting, type Collected } from "../src/family/collection.js";
import { savePlace, setLocation, setLost } from "../src/family/location/changes.js";
import { answerRequest, buildPolicy, decideApp, RuleRefused, type PolicyContext } from "../src/family/policy.js";
import { markHelpSeen } from "../src/family/kidside-changes.js";
import { setPhoneSettings } from "../src/family/screentime/changes.js";
import { deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, SPOT, testServer, T0, type TestServer } from "./helpers.js";

const DAY = 86_400_000;

const rows = (t: TestServer, table: string, deviceId: string) =>
  (t.deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE device_id = ?`).get(deviceId) as { n: number }).n;

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const other = await enrollPhone(t, "Kim's phone");
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => { t.deps.waiters.changed(id); } });
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const db = t.deps.db;

  for (const p of [phone, other]) {
    // Apps: two lists (the first is the server's start), the second without two apps (two removals),
    // and the racing game blocked after it went.
    await deviceCall(t, p.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block Party" }), pkg("com.example.chat"), pkg("com.example.racer")], T0));
    await deviceCall(t, p.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block Party" })], T0 + 1000));
    decideApp(ctx(), p.deviceId, "com.example.racer", "blocked", parent);
    db.prepare("INSERT INTO reviews (device_id, package, reviewed_at, parent_id, via, note) VALUES (?, 'com.example.blocks', ?, ?, 'web', 'Fine for now')").run(p.deviceId, T0, sam.parent.id);
    // Screen time: measuring, and two days of it.
    setPhoneSettings(ctx(), p.deviceId, { measure: true }, parent);
    const day = (d: string) => ({ day: d, zone: "America/New_York", as_of: T0, complete: true, screen_minutes: 30, unlocks: 4, by_hour: Array.from({ length: 24 }, () => 0), apps: [{ package: "com.example.blocks", minutes: 30, opens: 2 }], gaps: [] });
    expect((await deviceCall(t, p.token, "usage", { days: [day("2026-11-15"), day("2026-11-16")] })).status).toBe(200);
    // Location: on demand, kept on, a place, a check's fix and an arrival.
    setLocation(ctx(), p.deviceId, { mode: "on_demand", keepOn: true }, parent);
    savePlace(ctx(), p.deviceId, { name: "School", lat: SPOT.lat, lng: SPOT.lng, radiusM: 150, notify: [] }, parent);
    const fix = db.prepare("INSERT INTO fixes (device_id, id, at, lat, lng, accuracy_m, provider, reason, request_id, mock, received_at) VALUES (?, ?, ?, 40.1, -73.2, 20, 'gps', ?, ?, 0, ?)");
    fix.run(p.deviceId, "fix-check", T0, "on_demand", null, T0);
    db.prepare("INSERT INTO place_events (device_id, id, place_id, place_name, kind, at, fix_id, received_at) VALUES (?, 'event-0001', 'p-1', 'School', 'arrived', ?, 'fix-check', ?)").run(p.deviceId, T0, T0);
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at, expires_at) VALUES (?, ?, 'locate_now', ?, ?)").run(`c-${p.deviceId}`, p.deviceId, T0, T0 + 120_000);
    // Requests: an old answered one, a recent answered one with words, one waiting, a help request seen
    // (with where the phone was), and one nobody has seen.
    const old = T0 - 90 * DAY;
    await deviceCall(t, p.token, "requests", {
      requests: [
        { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", reason: "Everyone has it", asked_at: old },
        { id: "request-0002", kind: "app", package: "com.example.blocks", label: "Block Party", reason: "For the bus", asked_at: T0 },
        { id: "request-0003", kind: "talk", reason: "About my curfew", asked_at: T0 },
        { id: "request-0004", kind: "help", reason: "Lost my bag", asked_at: T0, location: { id: "fix-help", at: T0, lat: 40.1, lng: -73.2, accuracy_m: 20, provider: "gps", reason: "help", mock: false } },
        { id: "request-0005", kind: "help", asked_at: T0 },
      ],
    });
    db.prepare("UPDATE requests SET received_at = ? WHERE device_id = ? AND id = 'request-0001'").run(old, p.deviceId);
    answerRequest(ctx(), p.deviceId, "request-0001", "declined", parent, "Not yet");
    answerRequest(ctx(), p.deviceId, "request-0002", "approved", parent, "Sure, for the bus");
    markHelpSeen(ctx(), p.deviceId, "request-0004", parent, null);
  }
  return { t, db, sam, phone, other, parent, ctx, policy };
}

describe("what the server keeps about a phone", () => {
  it("lists exactly what each category's stop deletes, and what stays", async () => {
    const { t, phone } = await family();
    const [apps, screen, location, calls, network, mobileData, requests] = keptAbout(t.deps.db, phone.deviceId, t.now());
    // Calls, network logging and measuring mobile data were never turned on for this phone: nothing to stop.
    expect(calls).toMatchObject({ category: "calls", goes: [], stays: [], anything: false });
    expect(network).toMatchObject({ category: "network", goes: [], stays: [], anything: false });
    expect(mobileData).toMatchObject({ category: "mobile_data", goes: [], stays: [], anything: false });
    expect(apps).toMatchObject({
      category: "apps",
      goes: [
        "2 app changes (installs, updates and removals)",
        "1 review of apps, with their notes",
        "1 app that isn't on the phone any more",
        "the record of 2 app lists the phone sent (when, and how many apps)",
      ],
      stays: ["The 1 app on the phone now, and your allow and block decisions. New app changes arrive as they happen."],
      anything: true,
    });
    expect(screen).toMatchObject({
      goes: ["2 days of screen time: minutes in each app, opens, the hours the phone was used, and unlocks"],
      stopping: "Measuring turns off: the phone stops sending how long apps are used.",
      stays: [],
    });
    expect(location).toMatchObject({
      goes: ["2 fixes (where the phone was), including any shared with a help request", "1 arrival or departure", "1 place: School", "the record of 1 check of where the phone was"],
      stopping: "Location turns off, with lost mode and keeping location on: Belay stops taking fixes, and gives up the location permission.",
    });
    expect(requests).toMatchObject({
      goes: ["what the kid wrote in 3 requests", "your notes on 2 answers (they go from the kid's phone too)", "where the phone was, shared with 1 help request", "1 request from more than 60 days ago, entirely"],
      stays: [
        "2 requests waiting for you (or a help request nobody has seen), as they are.",
        "For 2 requests of the last 60 days, that the kid asked (for which app, or what) and your answer, without anyone's words: the kid's phone keeps its own list that long, and still shows your answers.",
      ],
    });
  });

  it("apps: its history goes; the apps on the phone now, and a decided app's row, stay", async () => {
    const { t, db, phone, other, parent, ctx } = await family();
    const done = stopCollecting(ctx(), phone.deviceId, "apps", parent, keptFor(db, phone.deviceId, "apps", t.now()).fingerprint);
    expect(done.result.deleted).toEqual({ app_changes: 2, reviews: 1, removed_apps: 1, app_lists: 2 });
    expect(db.prepare("SELECT package, present FROM apps WHERE device_id = ? ORDER BY package").all(phone.deviceId)).toEqual([
      { package: "com.example.blocks", present: 1 },
      { package: "com.example.racer", present: 0 },
    ]);
    for (const table of ["app_events", "reviews", "snapshots"]) expect(rows(t, table, phone.deviceId), table).toBe(0);
    // The other phone's, and this phone's other kinds of data, stay.
    expect(rows(t, "app_events", other.deviceId)).toBe(2);
    expect(rows(t, "usage_days", phone.deviceId)).toBe(2);
    expect(rows(t, "fixes", phone.deviceId)).toBe(2);
    expect(listAudit(db, { limit: 1, includeReads: false })[0]).toMatchObject({
      actor: "parent",
      action: "collection.stopped",
      deviceName: "Alex's phone",
      detail: { category: "apps", deleted: { app_changes: 2, reviews: 1, removed_apps: 1, app_lists: 2 } },
    });
    // The next app list is a new start: nothing it finds is a change.
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block Party" }), pkg("com.example.new")], T0 + 5000));
    expect(rows(t, "app_events", phone.deviceId)).toBe(0);
  });

  it("screen time: measuring goes off and the days go", async () => {
    const { t, db, phone, other, parent, ctx, policy } = await family();
    const version = policy().version;
    stopCollecting(ctx(), phone.deviceId, "screen_time", parent, keptFor(db, phone.deviceId, "screen_time", t.now()).fingerprint);
    expect(policy().screen_time).toBeNull();
    expect(policy().version).toBeGreaterThan(version);
    expect(rows(t, "usage_days", phone.deviceId)).toBe(0);
    expect(rows(t, "usage_apps", phone.deviceId)).toBe(0);
    expect(rows(t, "usage_days", other.deviceId)).toBe(2);
    expect(listAudit(db, { limit: 2, includeReads: false }).map((e) => e.action)).toEqual(["collection.stopped", "screen_time.measure"]);
    // A day sent now isn't kept: measuring is off.
    const day = { day: "2026-11-17", zone: "America/New_York", as_of: T0, complete: false, screen_minutes: 1, unlocks: 1, by_hour: Array.from({ length: 24 }, () => 0), apps: [], gaps: [] };
    await deviceCall(t, phone.token, "usage", { days: [day] });
    expect(rows(t, "usage_days", phone.deviceId)).toBe(0);
  });

  it("location: it turns off, lost mode too, and fixes, arrivals, places and checks go", async () => {
    const { t, db, phone, other, parent, ctx, policy } = await family();
    setLost(ctx(), phone.deviceId, { message: "This phone is lost. Please call", number: null }, parent);
    stopCollecting(ctx(), phone.deviceId, "location", parent, keptFor(db, phone.deviceId, "location", t.now()).fingerprint);
    expect(policy().location).toMatchObject({ mode: "off", keep_on: false, lost: null, places: [] });
    for (const table of ["fixes", "place_events", "places"]) expect(rows(t, table, phone.deviceId), table).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND kind = 'locate_now'").get(phone.deviceId)).toEqual({ n: 0 });
    expect(rows(t, "fixes", other.deviceId)).toBe(2);
    // The help request it was shared with stays, without where the phone was.
    expect(db.prepare("SELECT reason FROM requests WHERE device_id = ? AND id = 'request-0004'").get(phone.deviceId)).toEqual({ reason: "Lost my bag" });
  });

  it("requests: words and old ones go; waiting ones and unseen help stay; the kid's phone still gets its answers", async () => {
    const { t, db, phone, other, parent, ctx, policy } = await family();
    const answers = () => Object.fromEntries(policy().requests.map((r) => [r.id, [r.status, r.note]]));
    // The old one was answered just now, so the policy carries its answer; the phone forgot it after 60 days.
    expect(answers()).toEqual({
      "request-0001": ["declined", "Not yet"],
      "request-0002": ["approved", "Sure, for the bus"],
      "request-0003": ["pending", null],
      "request-0004": ["approved", null],
      "request-0005": ["pending", null],
    });
    const done = stopCollecting(ctx(), phone.deviceId, "requests", parent, keptFor(db, phone.deviceId, "requests", t.now()).fingerprint);
    expect(done.result.deleted).toEqual({ words: 3, notes: 2, shared_fixes: 1, old_requests: 1 });
    expect(db.prepare("SELECT id, kind, package, status, reason, note FROM requests WHERE device_id = ? ORDER BY id").all(phone.deviceId)).toEqual([
      { id: "request-0002", kind: "app", package: "com.example.blocks", status: "approved", reason: null, note: null },
      { id: "request-0003", kind: "talk", package: null, status: "pending", reason: "About my curfew", note: null },
      { id: "request-0004", kind: "help", package: null, status: "approved", reason: null, note: null },
      { id: "request-0005", kind: "help", package: null, status: "pending", reason: null, note: null },
    ]);
    // The answers still reach the phone, so it doesn't show them as waiting again; the notes went.
    expect(answers()).toEqual({
      "request-0002": ["approved", null],
      "request-0003": ["pending", null],
      "request-0004": ["approved", null],
      "request-0005": ["pending", null],
    });
    expect(policy().help_seen.map((s) => s.request_id)).toEqual(["request-0004"]);
    expect(db.prepare("SELECT id FROM fixes WHERE device_id = ? ORDER BY id").all(phone.deviceId)).toEqual([{ id: "fix-check" }]);
    expect(rows(t, "requests", other.deviceId)).toBe(5);
    // Once the kid's phone has forgotten them too, the bare records can go, entirely.
    t.advance(PHONE_KEEPS_REQUESTS_MS + 1);
    expect(keptFor(db, phone.deviceId, "requests", t.now()).goes).toEqual(["2 requests from more than 60 days ago, entirely"]);
  });

  it("refuses when what goes changed since the parent looked, and is a person's only", async () => {
    const { t, db, phone, parent, sam, ctx } = await family();
    const looked = keptFor(db, phone.deviceId, "location", t.now()).fingerprint;
    db.prepare("INSERT INTO fixes (device_id, id, at, lat, lng, accuracy_m, provider, reason, mock, received_at) VALUES (?, 'fix-new', ?, 40.1, -73.2, 20, 'gps', 'periodic', 0, ?)").run(phone.deviceId, T0, T0);
    expect(() => stopCollecting(ctx(), phone.deviceId, "location", parent, looked)).toThrow(RuleRefused);
    expect(() => stopCollecting(ctx(), phone.deviceId, "location", parent, looked)).toThrow(/changed since you looked/);
    expect(rows(t, "fixes", phone.deviceId)).toBe(3);
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" };
    expect(() => stopCollecting(ctx(), phone.deviceId, "apps", ai as unknown as Parameters<typeof stopCollecting>[3], "x")).toThrow(/an AI app can't/);
  });

  it("on the phone's page: the list, a confirmation with exactly what goes, then the stop", async () => {
    const { t, sam, phone } = await family();
    const page = await (await get(t, `/devices/${phone.deviceId}`, sam.cookie)).text();
    expect(page).toContain("What the server keeps about this phone");
    expect(page).toContain(`href="/devices/${phone.deviceId}/collection/location"`);
    const confirm = await (await get(t, `/devices/${phone.deviceId}/collection/location`, sam.cookie)).text();
    expect(confirm).toContain("Stop collecting where the phone is for Alex&#39;s phone?");
    expect(confirm).toContain("<li>1 place: School</li>");
    const fingerprint = /name="fingerprint" value="([^"]+)"/.exec(confirm)?.[1] ?? "";
    expect(fingerprint).not.toBe("");
    const stale = await postForm(t, `/devices/${phone.deviceId}/collection/location`, { _csrf: sam.csrf, fingerprint: "stale" }, { cookie: sam.cookie });
    expect(stale.status).toBe(409);
    expect(await stale.text()).toContain("changed since you looked");
    const done = await postForm(t, `/devices/${phone.deviceId}/collection/location`, { _csrf: sam.csrf, fingerprint }, { cookie: sam.cookie });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`/devices/${phone.deviceId}?saved=collection_stopped#collecting`);
    expect(rows(t, "fixes", phone.deviceId)).toBe(0);
    expect((await get(t, `/devices/${phone.deviceId}/collection/contacts`, sam.cookie)).status).toBe(404);
    // Without the CSRF token, nothing happens.
    expect((await postForm(t, `/devices/${phone.deviceId}/collection/apps`, { fingerprint }, { cookie: sam.cookie })).status).toBe(403);
  });

  it("every table with a phone's rows is in a category, or is a record kept with the phone", () => {
    const t = testServer();
    const db = t.deps.db;
    const tables = db
      .prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .filter((name) => db.prepare<[], { name: string }>(`SELECT name FROM pragma_table_info('${name}')`).all().some((c) => c.name === "device_id" || c.name === "used_by_device"));
    const known = new Set([...COLLECTED.flatMap((c: Collected) => COLLECTED_TABLES[c]), ...RECORDS]);
    const missing = tables.filter((name) => !known.has(name));
    // A new table with a phone's rows: add it to a category in family/collection.ts (with what its stop
    // deletes, and the phone's DataCategory and docs/privacy.md), or to RECORDS if it isn't collected data.
    expect(missing, `tables with no category: ${missing.join(", ")}`).toEqual([]);
    // And every table listed there exists, with a phone's rows.
    expect([...known].filter((name) => !tables.includes(name))).toEqual([]);
  });
});

describe("calls (Phase 5)", () => {
  const MOM = "+15555550100";
  const COACH = "+15555550142";

  async function calling() {
    const t = testServer();
    const sam = await signIn(t);
    const phone = await enrollPhone(t, "Alex's phone");
    const parent = { kind: "parent", parentId: sam.parent.id } as const;
    const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => { t.deps.waiters.changed(id); } });
    const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
    setCalls(ctx(), phone.deviceId, { enabled: true, mode: "contacts", log: true }, parent);
    saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, parent);
    const record = t.deps.db.prepare(
      "INSERT INTO call_records (device_id, id, at, direction, contact_id, contact_name, number, duration_s, outcome, reason, received_at) VALUES (?, ?, ?, 'in', NULL, NULL, ?, 60, 'missed', 'unknown', ?)",
    );
    record.run(phone.deviceId, "call-0001", T0, "+15555550199", T0);
    record.run(phone.deviceId, "call-0002", T0 + 1, "+15555550198", T0);
    await deviceCall(t, phone.token, "requests", {
      requests: [{ id: "request-0001", kind: "contact", contact_name: "Coach Sam", contact_number: COACH, reason: "For practice", asked_at: t.now() }],
    });
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", parent, "Let's ask the coach first");
    return { t, phone, parent, ctx, policy };
  }

  it("the records go and recording turns off; calls, their rules and the contacts stay", async () => {
    const { t, phone, parent, ctx, policy } = await calling();
    const kept = keptFor(t.deps.db, phone.deviceId, "calls", t.now());
    expect(kept).toMatchObject({
      goes: ["2 call records: who called whom, when, for how long, and what happened"],
      stopping: "Recording calls turns off: the phone stops sending who calls and who is called.",
      stays: ["Calls stay on, with their rules: Belay as the phone app still decides who rings.", "The contacts, and the private and blocked numbers: they're this phone's rules."],
      anything: true,
    });
    const done = stopCollecting(ctx(), phone.deviceId, "calls", parent, kept.fingerprint);
    expect(done.result.deleted).toEqual({ call_records: 2 });
    expect(policy().calls).toMatchObject({ mode: "contacts", log: false });
    expect(policy().contacts.map((c) => c.name)).toEqual(["Mom"]);
    expect(rows(t, "call_records", phone.deviceId)).toBe(0);
    expect(keptFor(t.deps.db, phone.deviceId, "calls", t.now()).anything).toBe(false);
  });

  it("a contact request's bare record keeps the number it asked for, not the name the kid gave it", async () => {
    const { t, phone, parent, ctx, policy } = await calling();
    expect(keptFor(t.deps.db, phone.deviceId, "requests", t.now()).goes).toEqual(["what the kid wrote in 1 request", "your notes on 1 answer (they go from the kid's phone too)"]);
    stopCollecting(ctx(), phone.deviceId, "requests", parent, keptFor(t.deps.db, phone.deviceId, "requests", t.now()).fingerprint);
    expect(t.deps.db.prepare("SELECT kind, status, reason, note, contact_name, contact_number FROM requests WHERE device_id = ?").all(phone.deviceId)).toEqual([
      { kind: "contact", status: "declined", reason: null, note: null, contact_name: COACH, contact_number: COACH },
    ]);
    expect(policy().requests).toMatchObject([{ id: "request-0001", status: "declined", note: null }]);
    expect(keptFor(t.deps.db, phone.deviceId, "requests", t.now()).anything).toBe(false);
  });
});
