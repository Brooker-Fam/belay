/**
 * What the kid reads on the phone from the family's side: the names of limits, schedules and
 * stages, a pause's note, the support message and a parent's answers. An AI app's own words never
 * get there (Belay names what it adds or renames, and its pause or lock carries no note), and
 * everyone's words get there tidied: without control, invisible or direction-changing characters,
 * and a name on one line. Made-up apps and names only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { createParent } from "../src/auth/parents.js";
import { Policy } from "../src/device/schemas.js";
import { markHelpSeen } from "../src/family/kidside-changes.js";
import { answerRequest, buildPolicy, pausePhone, setSupportMessage, type PolicyContext } from "../src/family/policy.js";
import { approveProposal, listProposals } from "../src/family/proposals.js";
import { moveToStage, saveStage, setPhoneRules } from "../src/family/screentime/changes.js";
import { limitName, type AppNames } from "../src/family/screentime/names.js";
import { NO_RULES, phoneRules } from "../src/family/screentime/rules.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, pkg, snapshot, testServer, T0, type TestServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
/** What hides or reorders text, and control characters (a new line aside). */
// eslint-disable-next-line no-control-regex
const HIDDEN = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/u;

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block Party" }), pkg("com.example.chat", { label: "Chatter" }), pkg("com.example.draw", { label: "Sketchbook" })], T0));
  const sam = { kind: "parent", parentId: parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const { token } = createPersonalToken(t.deps.db, t.now(), parent.id, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const call = async (name: string, args: Record<string, unknown>) => {
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
  return { t, phone, parent, sam, ctx, client, call, policy };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const code = await runCommand(argv, { db: t.deps.db, config: t.deps.config, now: t.now(), out: (l) => out.push(l), err: () => undefined, readSecret: () => Promise.resolve(""), interactive: false });
  return { code, out: out.join("\n") };
}

/** Every string in the policy, with where it is. */
function strings(value: unknown, path = "policy"): [string, string][] {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, `${path}[${i}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, `${path}.${k}`));
  return [];
}

describe("an AI app's words on the kid's phone", () => {
  it("never name a limit or schedule it adds, even one that limits nothing: Belay names them from what they are", async () => {
    const { call, policy } = await family();
    const words = "Mom says call 555-0100 NOW \u202eevil\u202c";
    // 1440 minutes a day limits nothing, and a one-minute schedule hardly more: both only tighten, so they apply at once.
    const limit = await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ name: words, packages: ["com.example.anything"], minutes: 1440 }] }, reason: "the parent asked" });
    const schedule = await call("change_screen_time", {
      device: "Sam's phone",
      change: { schedules: [{ name: "Your parents can read your texts", days: ["sun"], start: "03:00", end: "03:01", allow: [] }] },
      reason: "the parent asked",
    });
    expect(limit.json.status).toMatch(/^done/);
    expect(schedule.json.status).toMatch(/^done/);
    // An app the phone never reported is counted, never named: a package name is the AI app's choice too.
    expect(policy().screen_time?.limits.map((l) => l.name)).toEqual(["1 app"]);
    expect(policy().screen_time?.schedules.map((s) => s.name)).toEqual(["Schedule"]);
    // Apps the phone did report are named as it names them; a daily total and a bedtime by what they are.
    await call("change_screen_time", {
      device: "Sam's phone",
      change: { limits: [{ name: "x", packages: ["com.example.blocks", "com.example.chat"], minutes: 60 }, { name: "y", packages: ["*"], minutes: 180 }], schedules: [{ name: "z", kind: "bedtime", start: "21:00", end: "07:00" }] },
      reason: "the parent asked",
    });
    expect(policy().screen_time?.limits.map((l) => l.name)).toEqual(["1 app", "Block Party and Chatter", "Screen time"]);
    expect(policy().screen_time?.schedules.map((s) => s.name)).toEqual(["Schedule", "Bedtime"]);
    const tool = (await (await family()).client.listTools()).tools.find((x) => x.name === "change_screen_time");
    expect(tool?.description).toContain("never in your words");
  });

  it("asking to rename a limit or schedule only proposes Belay's name for it; the same name in another case is no rename", async () => {
    const { t, phone, parent, sam, ctx, call, policy } = await family();
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, sam);
    const same = await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ id: "l-games", name: "GAMES", minutes: 45 }] }, reason: "less" });
    expect(same.json.status).toMatch(/^done/);
    expect(policy().screen_time?.limits[0]).toMatchObject({ name: "Games", minutes: 45 });
    const renamed = await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ id: "l-games", name: "Your parents can read your texts", minutes: 30 }] }, reason: "rename" });
    expect(renamed.json.status).toMatch(/^proposed/);
    expect(JSON.stringify(renamed.json)).not.toContain("read your texts");
    expect(renamed.json.changes.map((c: { untrusted: { change: string } }) => c.untrusted.change)).toContain("The limit Games is now called Block Party");
    expect(policy().screen_time?.limits[0]?.name).toBe("Games");
    const [proposal] = listProposals(t.deps.db, { status: "pending" });
    expect(approveProposal(ctx(), proposal?.id ?? "", parent.id).ok).toBe(true);
    expect(policy().screen_time?.limits[0]).toMatchObject({ name: "Block Party", minutes: 30 });
  });

  it("names Belay wrote follow what they name, whoever changes it; a parent's name stays as they wrote it", async () => {
    const { phone, sam, ctx, call, policy } = await family();
    await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ packages: ["com.example.chat"], minutes: 30 }] }, reason: "chat" });
    const id = policy().screen_time?.limits[0]?.id ?? "";
    expect(policy().screen_time?.limits[0]?.name).toBe("Chatter");
    // More apps under it only tighten: it applies at once, and the name says what the limit counts now.
    const more = await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ id, packages: ["com.example.chat", "com.example.blocks"] }] }, reason: "games too" });
    expect(more.json.status).toMatch(/^done/);
    expect(policy().screen_time?.limits[0]?.name).toBe("Chatter and Block Party");
    // A parent's change follows too, unless they named it.
    const rules = phoneRules(ctx().db, phone.deviceId).rules;
    setPhoneRules(ctx(), phone.deviceId, { ...rules, limits: rules.limits.map((l) => ({ ...l, packages: [...l.packages, "com.example.draw"] })) }, sam);
    expect(policy().screen_time?.limits[0]?.name).toBe("Chatter, Block Party and Sketchbook");
    setPhoneRules(ctx(), phone.deviceId, { ...rules, limits: rules.limits.map((l) => ({ ...l, name: "Social" })) }, sam);
    await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ id, packages: ["com.example.chat", "com.example.blocks", "com.example.draw"] }] }, reason: "drawing too" });
    expect(policy().screen_time?.limits[0]?.name).toBe("Social");
  });

  it("limitName: the apps as the phone names them, counted when it doesn't know them, at most 60 characters", () => {
    const names: AppNames = (p) => ({ "a.one": "Chess Club", "a.two": "Puzzle Pop", "a.three": "Tower Rush", "a.long": "L".repeat(40), "a.longer": "Puzzle Pop: The Deluxe Edition" })[p] ?? null;
    expect(limitName(["a.one"], names)).toBe("Chess Club");
    expect(limitName(["a.one", "a.two"], names)).toBe("Chess Club and Puzzle Pop");
    expect(limitName(["a.one", "a.two", "a.three"], names)).toBe("Chess Club, Puzzle Pop and Tower Rush");
    expect(limitName(["a.one", "a.two", "a.three", "a.unknown"], names)).toBe("Chess Club, Puzzle Pop and 2 more apps");
    expect(limitName(["a.one", "a.unknown"], names)).toBe("Chess Club and 1 more app");
    expect(limitName(["a.unknown", "b.unknown", "c.unknown"], names)).toBe("3 apps");
    expect(limitName(["a.long", "a.one"], names)).toBe(`${"L".repeat(40)} and Chess Club`);
    expect(limitName(["a.long", "a.longer"], names)).toBe(`${"L".repeat(40)} and 1 more app`);
    expect(limitName(["a.long", "a.longer", "a.one", "a.two"], names)).toBe(`${"L".repeat(40)} and 3 more apps`);
    expect(limitName(["*"], names)).toBe("Screen time");
  });
});

describe("every name and note the kid sees", () => {
  it("is tidied whoever wrote it, and what was kept before Belay tidied it too", async () => {
    const { t, phone, parent, sam, ctx, policy } = await family();
    const dirty = (words: string) => `\u202e${words}\u200b\u0007\n `;
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-games", name: dirty("Games"), packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, sam);
    expect(policy().screen_time?.limits[0]?.name).toBe("Games");
    // The CLI's names.
    expect((await cli(t, "limit", "Sam's phone", "com.example.chat", "--minutes", "30", "--name", dirty("Chat"))).code).toBe(0);
    expect((await cli(t, "schedule", "Sam's phone", "--name", dirty("Homework"), "--start", "16:00", "--end", "18:00")).code).toBe(0);
    expect(policy().screen_time?.limits.map((l) => l.name)).toEqual(["Games", "Chat"]);
    expect(policy().screen_time?.schedules.map((s) => s.name)).toEqual(["Homework"]);
    // A stage's name, words and rules, and the phone on it.
    const stage = saveStage(ctx(), null, { name: dirty("Starter"), how: dirty("A month\nof kept limits"), rules: { ...NO_RULES, limits: [{ id: "l-stage", name: dirty("Drawing"), packages: ["com.example.draw"], minutes: 90, by_day: null }] } }, sam).stage;
    saveStage(ctx(), null, { name: "Explorer", how: dirty("Ask us"), rules: NO_RULES }, sam);
    moveToStage(ctx(), phone.deviceId, stage.id, sam);
    // A pause's note, the support message, an answer and a help request seen, with their notes.
    pausePhone(ctx(), phone.deviceId, { minutes: 30, note: dirty("Dinner") }, sam);
    setSupportMessage(ctx(), phone.deviceId, dirty("Ask Sam"), sam);
    await deviceCall(t, phone.token, "requests", {
      requests: [
        { id: "request-0001", kind: "app", package: "com.example.game", label: "Game", asked_at: t.now() },
        { id: "request-0002", kind: "help", asked_at: t.now() },
      ],
    });
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", sam, dirty("Not now"));
    markHelpSeen(ctx(), phone.deviceId, "request-0002", sam, dirty("Calling you"));
    // And a name written straight into the database, as an AI app's could have been before.
    t.deps.db.prepare("UPDATE stages SET name = ? WHERE id = ?").run(dirty("Starter"), stage.id);
    t.deps.db.prepare("UPDATE parents SET name = ? WHERE id = ?").run(dirty("Sam"), parent.id);
    const p = policy();
    const hidden = strings(p).filter(([, s]) => HIDDEN.test(s));
    expect(hidden).toEqual([]);
    expect(p.screen_time?.limits.map((l) => l.name)).toEqual(["Drawing"]);
    expect(p.stage).toMatchObject({ name: "Starter", next: { name: "Explorer", how: "Ask us" } });
    expect(p.pause?.note).toBe("Dinner");
    expect(p.support_message).toBe("Ask Sam");
    expect(p.requests.find((r) => r.id === "request-0001")).toMatchObject({ note: "Not now", answered_by: "Sam" });
    expect(p.help_seen[0]?.by).toBe("Sam");
    expect(p.requests.find((r) => r.id === "request-0002")?.note).toBe("Calling you");
  });

  it("a limit's name kept before Belay tidied names reaches the phone tidied, and the next change saves it so", async () => {
    const { t, phone, sam, ctx, call, policy } = await family();
    setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, sam);
    const stored = t.deps.db.prepare<[string], { limits: string }>("SELECT limits FROM screen_time_rules WHERE device_id = ?").get(phone.deviceId)?.limits ?? "";
    t.deps.db.prepare("UPDATE screen_time_rules SET limits = ? WHERE device_id = ?").run(stored.replace('"Games"', '"Mom says call 555-0100 \\u202eevil"'), phone.deviceId);
    expect(policy().screen_time?.limits[0]?.name).toBe("Mom says call 555-0100 evil");
    // An AI app's tightening still applies at once: tidying isn't a rename.
    expect((await call("change_screen_time", { device: "Sam's phone", change: { limits: [{ id: "l-games", minutes: 30 }] }, reason: "less" })).json.status).toMatch(/^done/);
    expect(t.deps.db.prepare<[string], { limits: string }>("SELECT limits FROM screen_time_rules WHERE device_id = ?").get(phone.deviceId)?.limits).not.toMatch(/\\u202e/i);
  });
});
