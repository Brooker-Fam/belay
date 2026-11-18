/**
 * The eighth security review's server probes (commit e4bdf70), turned to assert what holds now.
 * Made-up names, apps and phones only.
 * - K2: with every AI category off (Apps too), change_screen_time named each limit it added after
 *   the apps it listed, as the phone names them ("New limit: Secret Diary, Video Tube and 3 more
 *   apps"), and get_rules did too: one call could tell an AI app the names of up to 100 apps the
 *   phone has or had. Now, with the Apps category off, a change that names apps (a limit's, exempt,
 *   open during a schedule), or renames a limit on some apps, gets block_app's refusal word for
 *   word, the same for an app on the phone, one removed since and one never there, and the
 *   activity log keeps it; one that names no app works as before. sixth-review.test.ts's walk of
 *   the write tools calls it with apps too.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { listProposals } from "../src/family/proposals.js";
import { setPhoneRules } from "../src/family/screentime/changes.js";
import { NO_RULES } from "../src/family/screentime/rules.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { AI_SCOPES, type AiScope, updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, get, pkg, signIn, snapshot, testServer, T0 } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MIN = 60_000;
/** Every AI category off, those added later included. */
const NO_SCOPES = Object.fromEntries(Object.keys(AI_SCOPES).map((key) => [key, false])) as Record<AiScope, boolean>;
/** The names the phone gave its apps: no answer with Apps off says them. */
const LABELS = ["Video Tube", "Secret Diary"];
/** An app on the phone, one the kid removed since, and one never there. */
const APPS = ["com.example.video", "com.example.diary", "com.example.neverhere"];

/** One parent, one phone that reported two apps (one removed since), and an AI app with every category off. */
async function mcpFamily() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York", aiScopes: NO_SCOPES });
  const session = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" }), pkg("com.example.diary", { label: "Secret Diary" })], T0));
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" })], T0 + MIN));
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
  const sam = { kind: "parent", parentId: session.parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const screenTime = (change: Record<string, unknown>) => call("change_screen_time", { device: "Alex's phone", change, reason: "The parent asked." });
  return { t, session, phone, client, call, policy, sam, ctx, screenTime };
}

describe("K2: with the Apps category off, change_screen_time takes no apps, so no answer names one", () => {
  it("block_app's refusal word for word, for an app on the phone, one removed since and one never there, however a change names it", async () => {
    const { t, session, phone, call, policy, screenTime } = await mcpFamily();
    expect((await call("get_installed_apps", { device: "Alex's phone" })).text).toMatch(/^A parent turned off AI access to apps/);
    const blocked = await call("block_app", { device: "Alex's phone", package: "com.example.video" });
    expect(blocked.text).toBe("A parent turned off AI access to apps in Belay's settings, so this isn't available.");
    const before = policy().version;
    const changes = (app: string) => [
      // The probe's limit, a day long, named after the app if the phone ever reported it.
      { limits: [{ packages: [app], minutes: 1440 }] },
      // Several candidates in one limit: the first two the phone reported were named.
      { limits: [{ packages: ["com.example.a", app, "com.example.b", "com.example.c"], minutes: 1440 }] },
      // "*" with an app: a daily total, but it names one.
      { limits: [{ packages: ["*", app], minutes: 600 }] },
      // Mixed with a loosening, it was only a proposal, and still named the app.
      { limits: [{ packages: [app], minutes: 60 }], self_serve: { minutes: 30, times: 3 } },
      // Exempt, and open during a schedule: counted in the answer, but whether it changed anything said whether the app was there already.
      { exempt_add: [app] },
      { exempt_remove: [app] },
      { schedules: [{ kind: "bedtime", start: "21:00", end: "07:00", allow: [app] }] },
    ];
    for (const app of APPS) {
      for (const change of changes(app)) expect(await screenTime(change), JSON.stringify(change)).toEqual({ json: {}, text: blocked.text, isError: true });
    }
    // Nothing reached the phone, nothing waits for a parent, and get_rules names nothing.
    expect(policy().version).toBe(before);
    expect(policy().screen_time?.limits ?? []).toEqual([]);
    expect(listProposals(t.deps.db, { deviceId: phone.deviceId, status: "pending" })).toEqual([]);
    const rules = await call("get_rules", { device: "Alex's phone" });
    for (const label of LABELS) expect(rules.text).not.toContain(label);
    // The activity log keeps it once an hour, naming no app; the parent's Activity page says what it tried.
    const refused = listAudit(t.deps.db, { limit: 50, includeReads: false }).filter((e) => e.action === "ai.refused");
    expect(refused).toHaveLength(1);
    expect(refused[0]).toMatchObject({ actor: "ai", clientName: "Claude", deviceName: "Alex's phone", detail: { tool: "change_screen_time", why: "apps" } });
    expect(JSON.stringify(refused.map((e) => e.detail))).not.toMatch(/example|Video|Diary/);
    expect(await (await get(t, "/activity", session.cookie)).text()).toContain("was refused: it tried to change screen time with apps while AI access to apps is off (Alex");
  });

  it("a parent's limit on some apps: its minutes change, but not its apps, nor its name (Belay's would be after them)", async () => {
    const { ctx, sam, phone, call, screenTime } = await mcpFamily();
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-homework", name: "Homework", packages: ["com.example.video"], minutes: 60, by_day: null }] }, sam);
    const blocked = (await call("block_app", { device: "Alex's phone", package: "com.example.video" })).text;
    for (const change of [{ limits: [{ id: "l-homework", name: "Anything" }] }, { limits: [{ id: "l-homework", packages: ["com.example.video", "com.example.diary"] }] }]) {
      expect((await screenTime(change)).text, JSON.stringify(change)).toBe(blocked);
    }
    const shorter = await screenTime({ limits: [{ id: "l-homework", minutes: 30 }] });
    expect(shorter.json).toMatchObject({ status: "done: it only tightens, so it applies at once", changes: [{ untrusted: { change: "Homework: 30 min a day instead of 1 h, every day" } }] });
    const rules = (await call("get_rules", { device: "Alex's phone" })).json;
    expect(rules.limits).toEqual([{ id: "l-homework", apps: 1, minutes_a_day: 30, untrusted: { name: "Homework" } }]);
    for (const label of LABELS) expect(JSON.stringify(rules)).not.toContain(label);
  });

  it("a daily total, and any change that names no app, as before, in words that name none", async () => {
    const { policy, screenTime } = await mcpFamily();
    const total = await screenTime({ limits: [{ packages: ["*"], minutes: 180 }] });
    expect(total.json).toMatchObject({ status: "done: it only tightens, so it applies at once", changes: [{ untrusted: { change: "New daily screen time limit: 3 h, every day" } }] });
    expect(policy().screen_time?.limits.map((l) => l.name)).toEqual(["Screen time"]);
    const bedtime = await screenTime({ schedules: [{ kind: "bedtime", start: "21:00", end: "07:00" }] });
    expect(bedtime.json.status).toBe("done: it only tightens, so it applies at once");
    const more = await screenTime({ self_serve: { minutes: 30, times: 3 } });
    expect(more.json.status).toBe("proposed: waiting for a parent to approve or reject it");
    for (const answer of [total, bedtime, more]) for (const label of LABELS) expect(answer.text).not.toContain(label);
  });

  it("with the Apps category on, a limit it adds is named after its apps, as the kid sees it", async () => {
    const { t, screenTime } = await mcpFamily();
    updateSettings(t.deps.db, { aiScopes: { ...NO_SCOPES, apps: true } });
    expect((await screenTime({ limits: [{ packages: ["com.example.diary"], minutes: 1440 }] })).json.changes).toEqual([
      { effect: "tightens", untrusted: { change: "New limit: Secret Diary, 24 h a day, every day" } },
    ]);
  });
});
