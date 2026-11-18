/**
 * The seventh security review's server probes (commit c7063d1), turned to assert what holds now.
 * Made-up names, phones and places only.
 * - H1: a caregiver gets only the help requests the kid asked once their help on that phone began
 *   (the later of the phone being added to their access and help being turned on): never one from
 *   before, by their page or by a notice, however late it arrives, and no notice of words added
 *   later to one they can't see. The kid's Help screen named them from then on.
 * - M1: change_wifi_only needs the Apps category, as block_app does: with it off, its answer is
 *   the category's refusal whatever the app, so it no longer tells which apps the phone has or had.
 *   sixth-review.test.ts's G4 test now walks every write tool too.
 */
import Database from "better-sqlite3";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { loadMigrations, migrate } from "../src/db.js";
import { Policy } from "../src/device/schemas.js";
import { getCaregiver, listCaregivers } from "../src/family/caregivers/store.js";
import { setKidNumber } from "../src/family/kidside-changes.js";
import { setMobileDataMeasure } from "../src/family/mobiledata/changes.js";
import { wifiOnlyApps } from "../src/family/mobiledata/store.js";
import { buildPolicy, pausePhone, resumePhone, type PolicyContext } from "../src/family/policy.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { AI_SCOPES, type AiScope, getSettings, updateSettings } from "../src/settings.js";
import { browserFor, deviceCall, enrollPhone, fix, get, PASSWORD, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** Thursday Nov 19 2026, 6:00 PM in New York. */
const THURSDAY_6PM = "2026-11-19T18:00";
/** Every AI category off, those added later included. */
const NO_SCOPES = Object.fromEntries(Object.keys(AI_SCOPES).map((key) => [key, false])) as Record<AiScope, boolean>;

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const other = await enrollPhone(t, "Jamie's phone");
  const form = (path: string, fields: Record<string, string | string[]> = {}) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const policy = (id = phone.deviceId) => Policy.parse(buildPolicy(t.deps.db, id, t.now()));
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  return { t, fetch, sam, phone, other, form, policy, ctx };
}
type Family = Awaited<ReturnType<typeof family>>;

/** Adds a caregiver on the Caregivers page: their one-time link, and their id. */
async function add(f: Family, fields: Record<string, string | string[]> = {}) {
  const res = await f.form("/caregivers", { name: "Grandma", phone: [f.phone.deviceId], can: ["status", "pause", "help"], until: THURSDAY_6PM, ...fields });
  const html = await res.text();
  expect(res.status, html).toBe(200);
  const token = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? "";
  const id = listCaregivers(f.t.deps.db).find((c) => c.name === (typeof fields.name === "string" ? fields.name : "Grandma"))?.id ?? "";
  return { token, id };
}

/** A parent changes a caregiver on the Caregivers page. */
async function change(f: Family, id: string, fields: Record<string, string | string[]>) {
  const res = await f.form(`/caregivers/${id}`, { name: "Grandma", phone: [f.phone.deviceId], can: ["status", "pause", "help"], ...fields });
  expect(res.status, await res.clone().text()).toBe(302);
}

/** The caregiver joins with their link: their page, and their forms. */
async function join(f: Family, token: string, username = "grandma") {
  const res = await postForm(f.t, `/care/join/${token}`, { username, password: PASSWORD, repeat: PASSWORD });
  expect(res.status).toBe(302);
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await (await get(f.t, "/care", cookie)).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  return {
    cookie,
    csrf,
    html: async (path = "/care") => (await get(f.t, path, cookie)).text(),
    form: (path: string, fields: Record<string, string | string[]> = {}) => postForm(f.t, path, { _csrf: csrf, ...fields }, { cookie }),
  };
}

const help = (id: string, at: number, over: Record<string, unknown> = {}) => ({ id, kind: "help", asked_at: at, ...over });

describe("H1: a caregiver gets only the help requests the kid asked once their help on that phone began", () => {
  it("a phone a parent adds later: none of its earlier help requests, the kid's words or where it was; a new one, at once", async () => {
    const f = await family();
    // Grandma looks after Alex's phone only: Jamie's Help screen says only the parents get it.
    const { token, id } = await add(f);
    const care = await join(f, token);
    expect(f.policy(f.other.deviceId).caregivers).toEqual([]);
    f.t.advance(HOUR);
    await deviceCall(f.t, f.other.token, "requests", {
      requests: [help("request-0101", f.t.now(), { reason: "Something private at school", location: fix({ reason: "help", at: f.t.now() }) })],
    });
    // Two days later a parent adds Jamie's phone to her access.
    f.t.advance(2 * DAY);
    await change(f, id, { phone: [f.phone.deviceId, f.other.deviceId] });
    expect(f.policy(f.other.deviceId).caregivers.map((c) => c.name)).toEqual(["Grandma"]);
    const before = await care.html();
    expect(before).not.toContain("Something private at school");
    expect(before).not.toContain("Where the phone was, shared by the kid");
    // What Jamie asks from now on is hers, at once and on her page.
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    f.fetch.mockClear();
    f.t.advance(MIN);
    await deviceCall(f.t, f.other.token, "requests", { requests: [help("request-0102", f.t.now(), { reason: "Now I need you" })] });
    await vi.waitFor(() => {
      expect(browser.notices().length).toBe(1);
    });
    expect(browser.notices()[0]?.body).toContain("Now I need you");
    const after = await care.html();
    expect(after).toContain("Now I need you");
    expect(after).not.toContain("Something private at school");
  });

  it("help turned on later: none of the help requests from while it was off", async () => {
    const f = await family();
    const { token, id } = await add(f, { can: ["status", "pause"] });
    const care = await join(f, token);
    expect(f.policy().caregivers[0]?.can).toEqual(["status", "pause"]);
    f.t.advance(HOUR);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0201", f.t.now(), { reason: "Please don't tell anyone" })] });
    f.t.advance(HOUR);
    await change(f, id, { can: ["status", "pause", "help"] });
    expect(f.policy().caregivers[0]?.can).toEqual(["status", "pause", "help"]);
    const html = await care.html();
    expect(html).toContain('<section id="help">');
    expect(html).not.toContain("Please don&#39;t tell anyone");
    expect(html).toContain("No help requests since a parent let you get them for these phones.");
    expect(getCaregiver(f.t.deps.db, id)?.helpFrom).toEqual({ [f.phone.deviceId]: f.t.now() });
  });

  it("asked offline before she was added, and sent once the phone came online: no notice, and not on her page", async () => {
    const f = await family();
    const asked = f.t.now();
    // The kid presses "I need help" with the phone offline, before any caregiver exists.
    f.t.advance(30 * MIN);
    const { token, id } = await add(f);
    const care = await join(f, token);
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    const parents = browserFor(f.t, f.sam.parent.id, () => f.fetch.mock.calls);
    f.fetch.mockClear();
    f.t.advance(30 * MIN);
    // Online again, it sends that one and one the kid asked after she was added.
    await deviceCall(f.t, f.phone.token, "requests", {
      requests: [help("request-0301", asked, { reason: "Asked before Grandma was added" }), help("request-0302", f.t.now() - 5 * MIN, { reason: "Asked after" })],
    });
    await vi.waitFor(() => {
      expect(parents.notices().length).toBe(2);
    });
    await vi.waitFor(() => {
      expect(browser.notices().length).toBe(1);
    });
    expect(browser.notices()[0]?.body).toContain("Asked after");
    const html = await care.html();
    expect(html).toContain("Asked after");
    expect(html).not.toContain("Asked before Grandma was added");
  });

  it("a phone's clock ahead can't make an earlier request hers: when the server got it bounds when it was asked", async () => {
    const f = await family();
    // Sent before she was added, claiming to be from a day later.
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0311", f.t.now() + DAY, { reason: "From a clock ahead" })] });
    f.t.advance(MIN);
    const { token } = await add(f);
    expect(await (await join(f, token)).html()).not.toContain("From a clock ahead");
  });

  it("words added later to a help request from before she was added: the parents hear, she doesn't", async () => {
    const f = await family();
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0401", f.t.now())] });
    f.t.advance(HOUR);
    const { token, id } = await add(f);
    const care = await join(f, token);
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    const parents = browserFor(f.t, f.sam.parent.id, () => f.fetch.mock.calls);
    f.fetch.mockClear();
    f.t.advance(10 * MIN);
    // No parent saw it yet: the kid adds what's wrong, and shares where the phone is.
    await deviceCall(f.t, f.phone.token, "requests", {
      requests: [help("request-0401", f.t.now() - 70 * MIN, { reason: "Words from before Grandma was added", location: fix({ reason: "help" }) })],
    });
    await vi.waitFor(() => {
      expect(parents.notices().length).toBe(1);
    });
    expect(parents.notices()[0]?.body).toContain("Words from before Grandma was added");
    expect(browser.notices()).toEqual([]);
    expect(await care.html()).not.toContain("Words from before Grandma was added");
  });

  it("words added later to one she gets: she hears again", async () => {
    const f = await family();
    const { token, id } = await add(f);
    await join(f, token);
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    f.fetch.mockClear();
    f.t.advance(MIN);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0501", f.t.now())] });
    f.t.advance(MIN);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0501", f.t.now() - MIN, { reason: "I lost my bag" })] });
    await vi.waitFor(() => {
      expect(browser.notices().length).toBe(2);
    });
    expect(browser.notices()[1]?.body).toContain("I lost my bag");
  });

  it("a phone she keeps keeps its start through other changes; help turned off and on again starts again", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    const began = f.t.now();
    f.t.advance(HOUR);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0601", f.t.now(), { reason: "While she had help" })] });
    // A new name, and another phone: Alex's phone keeps its start.
    f.t.advance(HOUR);
    await change(f, id, { name: "Granny", phone: [f.phone.deviceId, f.other.deviceId] });
    expect(getCaregiver(f.t.deps.db, id)?.helpFrom).toEqual({ [f.phone.deviceId]: began, [f.other.deviceId]: f.t.now() });
    expect(await care.html()).toContain("While she had help");
    // Help off, a request, help on again: that one isn't hers, and the earlier one isn't either now.
    await change(f, id, { name: "Granny", can: ["status", "pause"] });
    expect(getCaregiver(f.t.deps.db, id)?.helpFrom).toEqual({});
    f.t.advance(MIN);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0602", f.t.now(), { reason: "While help was off" })] });
    f.t.advance(MIN);
    await change(f, id, { name: "Granny" });
    const html = await care.html();
    expect(html).not.toContain("While help was off");
    expect(html).not.toContain("While she had help");
  });

  it("access given again starts every phone's help again", async () => {
    const f = await family();
    const { id } = await add(f, { phone: [f.phone.deviceId, f.other.deviceId] });
    await f.form(`/caregivers/${id}/end`);
    f.t.advance(MIN);
    await deviceCall(f.t, f.other.token, "requests", { requests: [help("request-0701", f.t.now(), { reason: "While she had no access" })] });
    f.t.advance(MIN);
    expect((await f.form(`/caregivers/${id}/renew`, { until: THURSDAY_6PM })).status).toBe(302);
    expect(getCaregiver(f.t.deps.db, id)?.helpFrom).toEqual({ [f.phone.deviceId]: f.t.now(), [f.other.deviceId]: f.t.now() });
  });

  it("migration 17: a caregiver from before begins at their last change, never earlier; help off has none", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(
      db,
      loadMigrations().filter((m) => m.version <= 16),
    );
    db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'Alex''s phone', 'h', ?)").run(T0);
    const caregiver = db.prepare(
      "INSERT INTO caregivers (id, name, can_status, can_pause, can_help, can_locate, access_from, ends_at, created_at, updated_at) VALUES (?, ?, 1, 1, ?, 0, ?, ?, ?, ?)",
    );
    caregiver.run("cg-1", "Grandma", 1, T0, T0 + DAY, T0, T0 + HOUR);
    caregiver.run("cg-2", "Coach Lee", 0, T0, T0 + DAY, T0, T0);
    db.prepare("INSERT INTO caregiver_phones (caregiver_id, device_id) VALUES ('cg-1', 'phone-1'), ('cg-2', 'phone-1')").run();
    migrate(db);
    expect(db.prepare("SELECT caregiver_id, help_from FROM caregiver_phones ORDER BY caregiver_id").all()).toEqual([
      { caregiver_id: "cg-1", help_from: T0 + HOUR },
      { caregiver_id: "cg-2", help_from: null },
    ]);
  });
});

/** One parent, one phone with an app installed and one removed since, and an AI app on a personal access token. */
async function mcpFamily() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const session = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" }), pkg("com.example.diary", { label: "Secret Diary" })], T0));
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" })], T0 + MIN));
  const { token } = createPersonalToken(t.deps.db, t.now(), session.parent.id, "Claude", "https://belay.example.org/mcp");
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL("https://belay.example.org/mcp"), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    let json: Record<string, unknown> = {};
    try {
      json = JSON.parse(text) as Record<string, unknown>;
    } catch {
      // A refusal is words.
    }
    return { json, text, isError: res.isError === true };
  };
  return { t, phone, client, call, session };
}

describe("M1: change_wifi_only needs the Apps category, as block_app does", () => {
  it("with Apps off, the same refusal for an app on the phone, one removed since and one never there; nothing changes", async () => {
    const f = await mcpFamily();
    updateSettings(f.t.deps.db, { aiScopes: NO_SCOPES });
    expect(Object.values(getSettings(f.t.deps.db).aiScopes).every((on) => !on)).toBe(true);
    const probe = (name: string) => f.call("change_wifi_only", { device: "Alex's phone", change: { add: [name, "zzzz.not.an.app"] }, reason: "probe" });
    const answers = [await probe("com.example.video"), await probe("com.example.diary"), await probe("com.example.neverhere")];
    const blocked = await f.call("block_app", { device: "Alex's phone", package: "com.example.video" });
    expect(blocked.isError).toBe(true);
    for (const a of answers) expect(a).toEqual({ json: {}, text: blocked.text, isError: true });
    expect(blocked.text).toBe("A parent turned off AI access to apps in Belay's settings, so this isn't available.");
    // A removal, a role app, a phone that isn't there: the same words, before anything else.
    expect((await f.call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.video"] }, reason: "x" })).text).toBe(blocked.text);
    expect((await f.call("change_wifi_only", { device: "Alex's phone", change: { add: ["com.android.phone"] }, reason: "x" })).text).toBe(blocked.text);
    expect((await f.call("change_wifi_only", { device: "Nobody's phone", change: { add: ["com.example.video"] }, reason: "x" })).text).toBe(blocked.text);
    expect(wifiOnlyApps(f.t.deps.db, f.phone.deviceId)).toEqual([]);
    // Apps on: it works as before, and its refusals name apps again, which that category reads anyway.
    updateSettings(f.t.deps.db, { aiScopes: { ...NO_SCOPES, apps: true } });
    expect((await probe("com.example.neverhere")).text).toContain("com.example.neverhere isn't an app this phone has reported");
    const done = await f.call("change_wifi_only", { device: "Alex's phone", change: { add: ["com.example.video"] }, reason: "It uses most of the plan." });
    expect(done.isError).toBe(false);
    expect(wifiOnlyApps(f.t.deps.db, f.phone.deviceId).map((w) => w.package)).toEqual(["com.example.video"]);
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "ai", action: "mobile_data.wifi_only_added" });
    await f.client.close();
  });
});

describe("M3: an AI app gets each whole day of mobile data, never today so far", () => {
  it("with only Mobile data on, today so far gives it no numbers and no time; the parent page has it; the whole day gives both", async () => {
    const f = await mcpFamily();
    updateSettings(f.t.deps.db, { aiScopes: { ...NO_SCOPES, mobile_data: true } });
    setMobileDataMeasure({ db: f.t.deps.db, now: f.t.now() }, f.phone.deviceId, true, { kind: "parent", parentId: f.session.parent.id });
    // Monday Nov 16 in New York, as the phone sends it now: so far at noon, then at 6 PM (core's DataUseUploads.SO_FAR_AT), then whole.
    const midnight = Date.UTC(2026, 10, 16, 5, 0, 0);
    const day = (asOf: number, mobile: number, wifi: number, complete = false) => ({
      day: "2026-11-16",
      zone: "America/New_York",
      from: midnight,
      as_of: asOf,
      complete,
      mobile_bytes: mobile,
      wifi_bytes: wifi,
      apps: [{ package: "com.example.video", bytes: mobile }],
      android_bytes: 0,
      removed_bytes: 0,
      hotspot_bytes: 0,
    });
    const read = async () => {
      const r = await f.call("get_mobile_data", { device: "Alex's phone", from: "2026-11-16", to: "2026-11-16" });
      expect(r.isError, r.text).toBe(false);
      return r.json as { days: Record<string, unknown>[]; period: Record<string, unknown>; measuring: string };
    };
    const send = async (d: ReturnType<typeof day>) => {
      expect((await deviceCall(f.t, f.phone.token, "mobile-data", { days: [d] })).status).toBe(200);
    };
    await send(day(midnight + 12 * HOUR, 50e6, 900e6));
    const noon = await read();
    await send(day(midnight + 18 * HOUR, 230e6, 900e6));
    const six = await read();
    // The two reads say the same: no numbers, no "counted until".
    expect(six).toEqual(noon);
    expect(noon.days).toEqual([{ day: "2026-11-16", weekday: "Monday", not_over: "Not over yet: AI apps get a day's numbers once it's over, never so far" }]);
    expect(noon.period).toMatchObject({ whole_days: 0, mobile_data: { bytes: 0 }, wifi: { bytes: 0 } });
    expect(noon.measuring).toContain("never today so far");
    // The parent page has today so far, counted up to 6 PM.
    const page = await (await get(f.t, `/devices/${f.phone.deviceId}/mobile-data`, f.session.cookie)).text();
    expect(page).toContain("230 MB");
    expect(page).toContain("Counted up to");
    // Once it's over: the whole day.
    await send(day(midnight + 24 * HOUR, 300e6, 1500e6, true));
    const whole = await read();
    expect(whole.days[0]).toMatchObject({ counted: "the whole day", mobile_data: { bytes: 300e6 }, wifi: { bytes: 1500e6 } });
    expect(whole.period).toMatchObject({ whole_days: 1 });
    // Where the phone was is still the Location category's, which is off.
    expect((await f.call("get_location", { device: "Alex's phone" })).isError).toBe(true);
    await f.client.close();
  });
});

describe("J5: a caregiver's name keeps no invisible or format character, so two that look alike are one", () => {
  it("a word joiner, an Arabic letter mark, a line separator or a no-break space doesn't make a second Grandma", async () => {
    const f = await family();
    await add(f);
    // "Grand" + WORD JOINER + "ma", "Grandma" + ARABIC LETTER MARK, a byte-order mark and a zero-width joiner: taken, as "Grandma" is.
    for (const name of ["Grand\u2060ma", "Grandma\u061c", "\ufeffGrand\u200dma"]) {
      const res = await f.form("/caregivers", { name, phone: [f.phone.deviceId], can: ["status"], until: THURSDAY_6PM });
      expect(res.status, name).toBe(400);
      expect(await res.text()).toContain("Another caregiver has that name already.");
    }
    // A line separator and a no-break space are spaces, and a run of them is one.
    await add(f, { name: "Coach\u2028Lee" });
    await add(f, { name: "Aunt\u00a0\u2003 Robin\u2029" });
    expect(listCaregivers(f.t.deps.db).map((c) => c.name).sort()).toEqual(["Aunt Robin", "Coach Lee", "Grandma"]);
    expect(f.policy().caregivers.map((c) => c.name).sort()).toEqual(["Aunt Robin", "Coach Lee", "Grandma"]);
  });

  it("the policy cleans a name kept before the same way, and the pause's and the lock's", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    f.t.deps.db.prepare("UPDATE caregivers SET name = ? WHERE id = ?").run("Grand\u2060ma\u202e", id);
    expect((await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "30", lock: "1" })).status).toBe(302);
    const p = f.policy();
    expect(p.caregivers.map((c) => c.name)).toEqual(["Grandma"]);
    expect(p.pause?.caregiver).toBe("Grandma");
    expect(p.commands.map((c) => c.caregiver)).toEqual(["Grandma"]);
  });
});

/** What the caregiver's page says after a pause or a lock: where it sends them, and its words there. */
async function pauseAs(care: Awaited<ReturnType<typeof join>>, deviceId: string, minutes: string, lock: boolean) {
  const res = await care.form(`/care/phones/${deviceId}/pause`, { minutes, lock: lock ? "1" : "0" });
  expect(res.status, await res.clone().text()).toBe(302);
  const location = res.headers.get("location") ?? "";
  const html = await care.html(location);
  const notice = /<div class="notice[^"]*"[^>]*>(.*?)<\/div>/s.exec(html)?.[1];
  expect(notice, html).toBeDefined();
  return { saved: new URL(location, "https://x.example").searchParams.get("saved"), notice };
}

describe("H2: a caregiver's lock under a parent's longer pause", () => {
  it("leaves the pause the parent's and names her on the lock alone, which the phone shows; her page says so", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    // A parent's pause until they resume it.
    pausePhone(f.ctx(), f.phone.deviceId, { minutes: null }, { kind: "parent", parentId: f.sam.parent.id });
    expect(f.policy().pause).toEqual({ until: null, note: null });
    const locked = await pauseAs(care, f.phone.deviceId, "15", true);
    const p = f.policy();
    // The pause the kid reads stays the parent's; the lock_now names her (the phone's kid.Caregivers.locks posts
    // "Grandma locked the screen", core's SeventhReviewTest).
    expect(p.pause).toEqual({ until: null, note: null });
    expect(p.commands.map((c) => ({ kind: c.kind, caregiver: c.caregiver }))).toEqual([{ kind: "lock_now", caregiver: "Grandma" }]);
    // Her page doesn't say it paused the phone or showed her name on the pause: the lock did, and the pause stayed as it was.
    expect(locked.saved).toBe("locked_kept");
    expect(locked.notice).toContain("and says you locked it");
    expect(locked.notice).toContain("so that pause stays as it was");
    expect(locked.notice).not.toContain("shows your name");
    // With nothing longer on, her pause and her lock both name her, as the page says.
    resumePhone(f.ctx(), f.phone.deviceId, { kind: "parent", parentId: f.sam.parent.id });
    const fresh = await pauseAs(care, f.phone.deviceId, "30", true);
    expect(fresh.saved).toBe("locked");
    expect(f.policy().pause).toMatchObject({ caregiver: "Grandma" });
    expect(await care.html()).toContain("The kid&#39;s phone names you for your pause, and for each lock once it has locked the screen");
  });
});

describe("J7: a caregiver with Pause but not Status gets the same confirmation, paused already or not", () => {
  it("the same words, and the same count against the hourly limit, whether a longer pause was on", async () => {
    const f = await family();
    const { token } = await add(f, { can: ["pause"] });
    const care = await join(f, token);
    const first = await pauseAs(care, f.phone.deviceId, "30", false);
    expect(f.policy().pause).toMatchObject({ caregiver: "Grandma" });
    // Now one longer is on (hers): a shorter pause changes nothing, and she's told just the same.
    const again = await pauseAs(care, f.phone.deviceId, "15", false);
    expect(again).toEqual(first);
    expect(first.saved).toBe("paused_any");
    expect(first.notice).not.toContain("nothing changed");
    // A parent's longer pause, then a lock: the same words as a lock with nothing on.
    pausePhone(f.ctx(), f.phone.deviceId, { minutes: null }, { kind: "parent", parentId: f.sam.parent.id });
    const underParent = await pauseAs(care, f.phone.deviceId, "15", true);
    resumePhone(f.ctx(), f.phone.deviceId, { kind: "parent", parentId: f.sam.parent.id });
    const alone = await pauseAs(care, f.phone.deviceId, "15", true);
    expect(underParent).toEqual(alone);
    expect(alone.saved).toBe("locked_any");
    // Each of those four counted, kept or not: two more, then the limit, as for any caregiver.
    for (let i = 0; i < 2; i++) await pauseAs(care, f.phone.deviceId, "15", false);
    const res = await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "15", lock: "0" });
    expect(res.status).toBe(429);
  });

  it("with Status, a pause that changed nothing still says so, and isn't counted", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    expect((await pauseAs(care, f.phone.deviceId, "240", false)).saved).toBe("paused");
    for (let i = 0; i < 8; i++) expect((await pauseAs(care, f.phone.deviceId, "15", false)).saved).toBe("kept");
  });
});

describe("J9: test notices are limited, a caregiver's and a parent's", () => {
  it("at most 5 an hour each, to their own browsers; then again an hour later", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    browserFor(f.t, f.sam.parent.id, () => f.fetch.mock.calls);
    for (let i = 0; i < 5; i++) {
      expect((await care.form("/care/push/test")).status).toBe(200);
      expect((await f.form("/settings/push/test")).status).toBe(200);
    }
    f.fetch.mockClear();
    const careLimited = await care.form("/care/push/test");
    expect(careLimited.status).toBe(429);
    expect(await careLimited.text()).toContain("You can send at most 5 test notices an hour. Try again in 60 minutes.");
    const parentLimited = await f.form("/settings/push/test");
    expect(parentLimited.status).toBe(429);
    expect(await parentLimited.text()).toContain("You can send at most 5 test notices an hour.");
    expect(f.fetch).not.toHaveBeenCalled();
    f.t.advance(HOUR);
    expect((await care.form("/care/push/test")).status).toBe(200);
    expect((await f.form("/settings/push/test")).status).toBe(200);
  });
});

describe("J1: the kid's phone is told which caregivers get the kid's phone number", () => {
  it("kid_number on a caregiver with help while a parent set the number, never the number itself; a new policy when it changes", async () => {
    const f = await family();
    const parent = { kind: "parent", parentId: f.sam.parent.id } as const;
    await add(f);
    await add(f, { name: "Coach Lee", can: ["status", "pause"] });
    expect(f.policy().caregivers.map((c) => c.kid_number)).toEqual([undefined, undefined]);
    const before = f.policy().version;
    setKidNumber(f.ctx(), f.phone.deviceId, "+15555550123", parent);
    const p = f.policy();
    expect(p.version).toBe(before + 1);
    expect(p.caregivers.map((c) => [c.name, c.kid_number])).toEqual([
      ["Coach Lee", undefined],
      ["Grandma", true],
    ]);
    expect(JSON.stringify(buildPolicy(f.t.deps.db, f.phone.deviceId, f.t.now()))).not.toContain("5555550123");
    // Another phone without a number: nothing there.
    await add(f, { name: "Aunt Robin", phone: [f.other.deviceId] });
    expect(f.policy(f.other.deviceId).caregivers[0]?.kid_number).toBeUndefined();
    setKidNumber(f.ctx(), f.phone.deviceId, null, parent);
    expect(f.policy().caregivers.map((c) => c.kid_number)).toEqual([undefined, undefined]);
  });
});
