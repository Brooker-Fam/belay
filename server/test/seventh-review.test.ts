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
import { wifiOnlyApps } from "../src/family/mobiledata/store.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
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
  return { t, phone, client, call };
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
