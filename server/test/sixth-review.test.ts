/**
 * The sixth security review's server probes (commit 4528f67), turned to assert what holds now.
 * Made-up names and 555-01xx numbers only.
 * - G4: with every AI category off, an AI app still reads a phone's status and problems (the
 *   restart note among them), when it last checked in, its rules and how the last lock now went;
 *   the kid's phone said it read "none of this". The phone now lists what an AI app always reads
 *   (core's AiAlways), one line per item of docs/mcp.md's "Always included": this test holds that
 *   list to what the tools answer with every category off, key by key.
 * - G2's server half: a phone that can't lock fails every lock now, call or not, and the server
 *   words those the same (the phone's half is core's SixthReviewTest).
 * - I4 and I5, documented (threat-model.md): migration 013 left `waited_for_call` in old activity
 *   log entries, and a phone still on the build that sent it had its check-ins refused until it
 *   updated; only CI phones ever ran that build.
 */
import Database from "better-sqlite3";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { loadMigrations, migrate } from "../src/db.js";
import { Policy } from "../src/device/schemas.js";
import { setCalls } from "../src/family/calls/changes.js";
import { buildPolicy } from "../src/family/policy.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { AI_SCOPES, type AiScope, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, pkg, signIn, snapshot, testServer, T0 } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MIN = 60_000;
/** Every AI category off, those added later included (Phase 13's mobile data starts on). */
const NO_SCOPES = Object.fromEntries(Object.keys(AI_SCOPES).map((key) => [key, false])) as Record<AiScope, boolean>;
/** ScreenLock.NEEDS_RESTART on the phone, word for word: platform notes S5. */
const NEEDS_RESTART = "Android lets Belay lock the screen only after the phone restarts once with this version of Belay.";
const RESTART_NOTE =
  "The phone restarted and stayed locked for about 8 hours. Until it's unlocked after a restart, Belay can't decide calls: they ring in the phone's own app, whatever the rules.";

/** One parent, one phone, and an AI app on a personal access token with every category off. */
async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York", aiScopes: NO_SCOPES });
  const session = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const { token } = createPersonalToken(t.deps.db, t.now(), session.parent.id, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    let json: Record<string, any> = {};
    try {
      json = JSON.parse(text) as Record<string, any>;
    } catch {
      // A refusal is words.
    }
    return { json, text, isError: res.isError === true };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  /** A check-in with these lock_now results (an older phone's fields too) and the phone's own calls report. */
  const checkin = (commands: unknown[], calls?: unknown) => {
    const base = device({ enforcement: { policy_version: policy().version, applied_at: t.now(), commands: [] } });
    return deviceCall(t, phone.token, "checkin", { status: { ...base, enforcement: { ...base.enforcement, commands, ...(calls ? { calls } : {}) } } });
  };
  return { t, phone, client, call, policy, checkin };
}

/** docs/mcp.md's "Always included" list: its bold labels, which core's AiAlways (the kid's phone) has in the same order. */
function alwaysIncluded(): string[] {
  const lines = readFileSync(new URL("../../docs/mcp.md", import.meta.url), "utf8").split("\n");
  const start = lines.findIndex((l) => l.startsWith("**Always included**"));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = lines.slice(start + 1);
  const list = rest.slice(rest.findIndex((l) => l.startsWith("- ")));
  const end = list.findIndex((l) => l.trim() === "");
  return list
    .slice(0, end < 0 ? undefined : end)
    .filter((l) => l.startsWith("- **"))
    .map((l) => l.slice(4, l.indexOf("**", 4)).replace(/:$/, ""));
}

/**
 * Where each key an AI app reads with every category off belongs: one of docs/mcp.md's
 * "Always included" items, or words that say something is hidden ("hidden"), or the answer's own
 * time and zone ("about the answer"). A key that isn't here is something AI apps always read that
 * the kid's phone doesn't say: add it to docs/mcp.md's list and core's AiAlways (or gate it).
 */
const ALWAYS_KEYS: Record<string, Record<string, string>> = {
  list_devices: {
    now: "about the answer",
    timezone: "about the answer",
    phones: "The phone",
    waiting_to_enroll: "The phone",
    note: "hidden",
    note_device_status: "hidden",
  },
  "list_devices phone": {
    name: "The phone",
    status: "The phone",
    problems: "The phone",
    untrusted: "The phone",
    last_heard_from: "The phone",
    last_check_in: "The phone",
    protection: "Its rules",
    paused_until: "Its rules",
    location: "Location's",
    calls: "Calls'",
  },
  get_policy: {
    phone: "The phone",
    version: "Its rules",
    changed: "Its rules",
    applied_by_the_phone: "Its rules",
    summary: "Its rules",
    new_apps: "Its rules",
    paused: "Its rules",
    locked_settings: "Its rules",
    web: "Its rules",
    maintenance_until: "Its rules",
    only_a_parent_on_the_parent_page_changes: "Its rules",
    apps: "hidden",
    proposals_waiting: "Its rules",
  },
  get_rules: {
    phone: "The phone",
    day_on_the_phone: "Screen time's rules",
    which_apps: "hidden",
    measuring: "Screen time's rules",
    days: "Screen time's rules",
    limits: "Screen time's rules",
    schedules: "Screen time's rules",
    exempt: "Screen time's rules",
    self_serve: "Screen time's rules",
    when_belay_cant_count: "Screen time's rules",
    warning: "Screen time's rules",
    extra_time_today: "Screen time's rules",
    today: "hidden",
    stage: "hidden",
    agreement: "hidden",
    last_lock: "Screen time's rules",
    proposals_waiting: "Screen time's rules",
    how_to_change: "Screen time's rules",
  },
  get_contacts: {
    phone: "The phone",
    calls: "Calls'",
    rules: "Calls'",
    always: "Calls'",
    texts: "Calls'",
    contacts: "Calls'",
    note: "hidden",
    blocked_numbers: "Calls'",
    private_numbers: "Calls'",
    proposals_waiting: "Calls'",
    how_to_change: "Calls'",
  },
};

/**
 * The write tools (the seventh review's M1: change_wifi_only's refusals told an AI app with every
 * category off which apps the phone has or had). Each is called as a parent might ask, with every
 * category off. One that answers is held key by key to the list, like the read tools above (`keys`);
 * one without `keys` must refuse in a category's words, the same for an app on the phone, one
 * removed since and one never on it. Every write tool is here, so a new one is held to this too.
 * A limit change_screen_time adds is named as the kid sees it: after its apps, as the phone names
 * them (get_rules' which_apps says so), on the kid's rules screen and in the activity log.
 */
const WRITE_CALLS: { tool: string; args: (app: string) => Record<string, unknown>; keys?: Record<string, string> }[] = [
  { tool: "block_app", args: (app) => ({ package: app }) },
  { tool: "mark_apps_reviewed", args: (app) => ({ packages: [app] }) },
  { tool: "change_wifi_only", args: (app) => ({ change: { add: [app, "zzzz.not.an.app"] }, reason: "It uses most of the plan." }) },
  { tool: "propose_change", args: (app) => ({ change: { kind: "allow_app", package: app }, reason: "They asked for it." }) },
  { tool: "locate_now", args: () => ({}) },
  {
    tool: "pause_phone",
    args: () => ({ minutes: 30 }),
    keys: { phone: "The phone", paused_until: "Its rules", note: "Its rules", version: "Its rules", still_works: "about the answer", reminder: "about the answer" },
  },
  {
    tool: "lock_phone",
    args: () => ({ minutes: 60 }),
    keys: { phone: "The phone", paused_until: "Its rules", note: "Its rules", locks: "about the answer", version: "Its rules", still_works: "about the answer", reminder: "about the answer" },
  },
  {
    tool: "propose_change",
    args: () => ({ change: { kind: "resume" }, reason: "Homework's done." }),
    keys: { phone: "The phone", proposed: "Its rules", status: "Its rules", note: "Its rules", where: "about the answer", reminder: "about the answer" },
  },
  {
    tool: "change_screen_time",
    args: () => ({ change: { limits: [{ packages: ["*"], minutes: 180 }] }, reason: "A daily total." }),
    keys: { phone: "The phone", status: "Screen time's rules", changes: "Screen time's rules", version: "Its rules", what_happens: "about the answer", reminder: "about the answer" },
  },
  {
    tool: "change_calls",
    args: () => ({ change: { quiet: true }, reason: "Quiet at bedtime." }),
    keys: { phone: "The phone", status: "Calls'", changes: "Calls'", version: "Its rules", what_happens: "about the answer", always: "Calls'", reminder: "about the answer" },
  },
];

describe("G4: what an AI app reads with every category off is what the kid's phone says it always reads", () => {
  it("docs/mcp.md's list is the one this test (and core's AiAlwaysTest, for the phone) holds the tools to", () => {
    expect(alwaysIncluded()).toEqual(["The phone", "Its rules", "Screen time's rules", "Location's", "Calls'"]);
    const labels = new Set([...Object.values(ALWAYS_KEYS), ...WRITE_CALLS.map((w) => w.keys ?? {})].flatMap((keys) => Object.values(keys)));
    for (const label of labels) expect(["about the answer", "hidden", ...alwaysIncluded()]).toContain(label);
  });

  it("every write tool too: what it answers is one of those items, and one that takes an app refuses alike for any app", async () => {
    const { t, phone, client, call } = await family();
    // An app on the phone, and one the kid installed and removed since (the phone reported it once).
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" }), pkg("com.example.diary", { label: "Secret Diary" })], T0));
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" })], T0 + MIN));
    const parentId = (t.deps.db.prepare("SELECT id FROM parents").get() as { id: string }).id;
    setCalls({ db: t.deps.db, now: t.now() }, phone.deviceId, { enabled: true }, { kind: "parent", parentId });
    const writes = (await client.listTools()).tools.filter((tool) => tool.annotations?.readOnlyHint !== true).map((tool) => tool.name);
    expect([...new Set(WRITE_CALLS.map((w) => w.tool))].sort()).toEqual(writes.sort());
    for (const w of WRITE_CALLS) {
      const at = (app: string) => call(w.tool, { device: "Alex's phone", ...w.args(app) });
      const answer = await at("com.example.video");
      if (!w.keys) {
        expect(answer.isError, w.tool).toBe(true);
        expect(answer.text, w.tool).toMatch(/^A parent turned off AI access to [a-z ]+ in Belay's settings[ (),a-z]*, so this isn't available\./);
        for (const app of ["com.example.diary", "com.example.neverhere"]) expect((await at(app)).text, `${w.tool} ${app}`).toBe(answer.text);
        continue;
      }
      expect(answer.isError, `${w.tool}: ${answer.text}`).toBe(false);
      expect(Object.keys(answer.json).filter((k) => !(k in (w.keys ?? {}))), w.tool).toEqual([]);
    }
  });

  it("every key of every tool that answers with every category off is one of those items", async () => {
    const { t, phone, client, call, policy, checkin } = await family();
    // Calls on, a lock now the phone had, and the restart note among its problems (the review's probe).
    const parentId = (t.deps.db.prepare("SELECT id FROM parents").get() as { id: string }).id;
    setCalls({ db: t.deps.db, now: t.now() }, phone.deviceId, { enabled: true }, { kind: "parent", parentId });
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    const id = policy().commands[0]?.id ?? "";
    expect((await checkin([{ id, result: "done", at: t.now() }], { dialer: true, problem: RESTART_NOTE })).status).toBe(200);
    // The tools that answer: the server's own health names no phone ("Also always included").
    const answering: string[] = [];
    for (const tool of (await client.listTools()).tools) {
      if (tool.annotations?.readOnlyHint !== true) continue;
      const props = Object.keys((tool.inputSchema as { properties?: Record<string, unknown> }).properties ?? {});
      if (!(await call(tool.name, props.includes("device") ? { device: "Alex's phone" } : {})).isError) answering.push(tool.name);
    }
    expect(answering.sort()).toEqual(["get_contacts", "get_policy", "get_rules", "get_server_health", "list_devices"]);
    const unmapped = (tool: string, json: Record<string, unknown>) => Object.keys(json).filter((k) => !(k in (ALWAYS_KEYS[tool] ?? {})));
    const listed = (await call("list_devices")).json;
    expect(unmapped("list_devices", listed)).toEqual([]);
    const phoneEntry = listed.phones[0] as Record<string, unknown>;
    expect(unmapped("list_devices phone", phoneEntry)).toEqual([]);
    for (const tool of ["get_policy", "get_rules", "get_contacts"]) {
      expect(unmapped(tool, (await call(tool, { device: "Alex's phone" })).json), tool).toEqual([]);
    }
    // What the review saw, now on the kid's list: the restart note, the check-in, the lock's result.
    expect(phoneEntry.untrusted).toEqual({ problems_belay_on_the_phone_reported: [RESTART_NOTE] });
    expect(phoneEntry.last_check_in).toBe("2026-11-16T10:00:00-05:00");
    expect((await call("get_rules", { device: "Alex's phone" })).json.last_lock.state).toBe(
      "done: the phone has it, and locks its screen at once, or about 2 minutes after a call ends",
    );
    // The categories' own tools stay refused.
    expect((await call("get_device_status", { device: "Alex's phone" })).isError).toBe(true);
  });
});

describe("G2: on a phone that can't lock, every lock now reads the same, call or not", () => {
  it("with every AI category off, the phone's failed results look alike whatever the kid was doing", async () => {
    const { t, call, policy, checkin } = await family();
    const lastLock = async () => {
      const { sent: _sent, ...rest } = (await call("get_rules", { device: "Alex's phone" })).json.last_lock as Record<string, unknown>;
      return rest;
    };
    // 10:00, no call, and 10:20, a call on: the phone fails both in the same words, without a try.
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    expect((await checkin([{ id: policy().commands[0]?.id, result: "failed", at: t.now(), problem: NEEDS_RESTART }])).status).toBe(200);
    const quiet = await lastLock();
    t.advance(20 * MIN);
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    expect((await checkin([{ id: policy().commands[0]?.id, result: "failed", at: t.now(), problem: NEEDS_RESTART }])).status).toBe(200);
    expect(await lastLock()).toEqual(quiet);
    expect(quiet).toEqual({ state: "the phone couldn't lock its screen", untrusted: { why_belay_on_the_phone_says: NEEDS_RESTART } });
    expect((await call("get_calls", { device: "Alex's phone" })).isError).toBe(true);
  });
});

describe("INFO, documented: what migration 013 left", () => {
  it("I4: an old command.expired entry in the activity log keeps waited_for_call until the log's retention", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(
      db,
      loadMigrations().filter((m) => m.version <= 12),
    );
    db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'Alex''s phone', 'h', ?)").run(T0);
    db.prepare("INSERT INTO audit_log (at, actor, device_id, action, detail) VALUES (?, 'phone', 'phone-1', 'command.expired', ?)").run(
      T0,
      JSON.stringify({ kind: "lock_now", command: "c-1", waited_for_call: true, version: 3 }),
    );
    migrate(db);
    const entry = listAudit(db, { limit: 10, includeReads: false }).find((e) => e.action === "command.expired");
    expect(entry?.detail).toMatchObject({ waited_for_call: true });
  });

  it("I5: a phone on the build that sent waited_for_call has its check-ins refused until it updates", async () => {
    const { t, call, policy, checkin } = await family();
    expect((await checkin([])).status).toBe(200);
    const was = (await call("list_devices")).json.phones[0].last_check_in;
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    t.advance(11 * MIN);
    expect((await checkin([{ id: policy().commands[0]?.id, result: "expired", at: t.now(), waited_for_call: true }])).status).toBe(400);
    expect((await call("list_devices")).json.phones[0].last_check_in).toBe(was);
  });
});
