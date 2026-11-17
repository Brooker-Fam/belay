/**
 * Phase 11's last stage (docs/design/phase11-off-belay.md): every family's stage list ends with
 * Off belay, which blocks nothing, keeps its name and place, and can't be deleted; the family's
 * words for when it comes are in every phone's policy from the first day; only a parent moves a
 * phone there, and an AI app can't even propose it. Made-up names only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type DB, loadMigrations, migrate } from "../src/db.js";
import { Policy } from "../src/device/schemas.js";
import { RuleRefused, buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { createProposal, listProposals } from "../src/family/proposals.js";
import { deleteStage, moveToStage, saveStage } from "../src/family/screentime/changes.js";
import { NO_RULES, listStages, offBelayStage, type Limit } from "../src/family/screentime/rules.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { enrollPhone, get, postForm, signIn, testServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const games: Limit = { id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null };

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const other = await enrollPhone(t, "Kim's phone");
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => { t.deps.waiters.changed(id); } });
  const policy = (id = phone.deviceId) => Policy.parse(buildPolicy(t.deps.db, id, t.now()));
  const form = (path: string, fields: Record<string, string>) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => (await get(t, path, sam.cookie)).text();
  return { t, sam, phone, other, parent, ctx, policy, form, page };
}

describe("Off belay, every family's last stage", () => {
  it("is there from the start: named Off belay, last, and blocking nothing", async () => {
    const { t, policy } = await family();
    const stage = offBelayStage(t.deps.db);
    expect(stage).toMatchObject({ id: "off-belay", number: 1, name: "Off belay", how: null, offBelay: true, rules: NO_RULES });
    expect(listStages(t.deps.db).map((s) => s.name)).toEqual(["Off belay"]);
    // A phone on no stage gets it from the first day, for the kid's My stage.
    expect(policy().off_belay).toEqual({ how: null, position: "later" });
    expect(policy().stage).toBeNull();
  });

  it("a new stage goes in before it; none goes after it", async () => {
    const { t, ctx, parent } = await family();
    const starter = saveStage(ctx(), null, { name: "Starter", how: null, rules: { ...NO_RULES, limits: [games] } }, parent).stage;
    const explorer = saveStage(ctx(), null, { name: "Explorer", how: null, rules: NO_RULES }, parent).stage;
    expect(listStages(t.deps.db).map((s) => [s.number, s.name])).toEqual([
      [1, "Starter"],
      [2, "Explorer"],
      [3, "Off belay"],
    ]);
    // At Off belay's number, a new stage goes in before it.
    saveStage(ctx(), null, { name: "Middle", number: 3, how: null, rules: NO_RULES }, parent);
    expect(listStages(t.deps.db).map((s) => s.name)).toEqual(["Starter", "Explorer", "Middle", "Off belay"]);
    expect(() => saveStage(ctx(), null, { name: "After", number: 5, how: null, rules: NO_RULES }, parent)).toThrow(/always the last stage/);
    expect(() => saveStage(ctx(), starter.id, { name: "Starter", number: 4, how: null, rules: starter.rules }, parent)).toThrow(/always the last stage/);
    // No other stage takes its name.
    expect(() => saveStage(ctx(), explorer.id, { name: "off belay", how: null, rules: NO_RULES }, parent)).toThrow(/already called/);
  });

  it("keeps its name, place and empty rules, and can't be deleted; the family's words are its own", async () => {
    const { t, ctx, parent, phone, other, policy } = await family();
    const off = offBelayStage(t.deps.db);
    if (!off) throw new Error("no Off belay");
    const refuse = (input: Partial<Parameters<typeof saveStage>[2]>, why: RegExp) => {
      expect(() => saveStage(ctx(), off.id, { name: off.name, how: null, rules: NO_RULES, ...input }, parent)).toThrow(why);
    };
    refuse({ name: "Freedom" }, /keeps its name/);
    refuse({ number: 7 }, /always the last stage/);
    refuse({ rules: { ...NO_RULES, limits: [games] } }, /blocks nothing/);
    refuse({ rules: { ...NO_RULES, exempt: ["com.example.blocks"] } }, /blocks nothing/);
    expect(() => {
      deleteStage(ctx(), off.id, parent);
    }).toThrow(RuleRefused);
    expect(() => {
      deleteStage(ctx(), off.id, parent);
    }).toThrow(/can't be deleted/);
    // The words reach every phone, on a stage or not, in a new rules version.
    const before = { mine: policy().version, theirs: policy(other.deviceId).version };
    const saved = saveStage(ctx(), off.id, { name: "Off belay", how: "  When you turn 16  ", rules: NO_RULES }, parent);
    expect(saved.phonesChanged).toBe(2);
    expect(policy().off_belay).toEqual({ how: "When you turn 16", position: "later" });
    expect({ mine: policy().version, theirs: policy(other.deviceId).version }).toEqual({ mine: before.mine + 1, theirs: before.theirs + 1 });
    expect(phone.deviceId).not.toBe(other.deviceId);
  });

  it("the policy says whether the phone is on it, it comes next, or later", async () => {
    const { t, ctx, parent, phone, policy } = await family();
    const off = offBelayStage(t.deps.db);
    if (!off) throw new Error("no Off belay");
    saveStage(ctx(), off.id, { name: off.name, how: "When you've kept the agreement for a year", rules: NO_RULES }, parent);
    const starter = saveStage(ctx(), null, { name: "Starter", how: null, rules: { ...NO_RULES, limits: [games] } }, parent).stage;
    const explorer = saveStage(ctx(), null, { name: "Explorer", how: "A month of kept limits", rules: NO_RULES }, parent).stage;
    moveToStage(ctx(), phone.deviceId, starter.id, parent);
    expect(policy().off_belay).toEqual({ how: "When you've kept the agreement for a year", position: "later" });
    moveToStage(ctx(), phone.deviceId, explorer.id, parent);
    expect(policy().off_belay?.position).toBe("next");
    // The stage before it names it as the next one, with the family's words as how to get there.
    expect(policy().stage?.next).toMatchObject({ name: "Off belay", how: "When you've kept the agreement for a year" });
    // A parent moves the phone there: no limits, no schedules, and the phone knows it's there.
    moveToStage(ctx(), phone.deviceId, off.id, parent);
    expect(policy().off_belay?.position).toBe("on");
    expect(policy().stage).toMatchObject({ name: "Off belay", next: null });
    expect(policy().screen_time).toBeNull();
  });

  it("an AI app can't propose moving a phone to it, though it may propose other stages", async () => {
    const { t, ctx, parent, phone, sam } = await family();
    const off = offBelayStage(t.deps.db);
    if (!off) throw new Error("no Off belay");
    const starter = saveStage(ctx(), null, { name: "Starter", how: null, rules: NO_RULES }, parent).stage;
    expect(() =>
      createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "move_stage", stageId: off.id, stageName: off.name }, "They're ready", { parentId: sam.parent.id, clientName: "Claude" }),
    ).toThrow(/can't propose it/);
    // Over MCP, with words the AI app can pass on.
    const { token } = createPersonalToken(t.deps.db, t.now(), sam.parent.id, "Claude", MCP);
    const client = new Client({ name: "belay-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP), {
        fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const refused = await client.callTool({ name: "change_screen_time", arguments: { device: "Alex's phone", change: { stage: "off belay" }, reason: "They asked me to" } });
    expect(refused.isError).toBe(true);
    expect((refused.content as { text: string }[])[0]?.text).toBe("Only a parent moves Alex's phone to Off belay, on the parent page: an AI app can't propose it.");
    expect(listProposals(t.deps.db, { deviceId: phone.deviceId })).toEqual([]);
    const proposed = await client.callTool({ name: "change_screen_time", arguments: { device: "Alex's phone", change: { stage: "Starter" }, reason: "A first stage" } });
    expect(proposed.isError).not.toBe(true);
    expect(listProposals(t.deps.db, { deviceId: phone.deviceId }).map((p) => p.change)).toEqual([{ kind: "move_stage", stageId: starter.id, stageName: "Starter" }]);
    await client.close();
  });

  it("the Stages pages show it last; its page takes only the family's words", async () => {
    const { t, phone, form, page, policy } = await family();
    expect(await page("/stages")).toContain("The last stage: it blocks nothing");
    const html = await page("/stages/off-belay");
    expect(html).toContain("When it comes, in your words");
    expect(html).not.toContain("Delete this stage");
    expect(html).not.toContain('name="number"');
    const saved = await form("/stages/off-belay", { how: "When you turn 16", name: "Something else", number: "9" });
    expect(saved.status).toBe(302);
    expect(offBelayStage(t.deps.db)).toMatchObject({ name: "Off belay", number: 1, how: "When you turn 16" });
    expect(policy().off_belay?.how).toBe("When you turn 16");
    // Rules can't be added to it, from its own forms either.
    expect((await form("/stages/off-belay/limits", { scope: "apps", app_more: "com.example.blocks", minutes: "30" })).status).toBe(400);
    expect((await form("/stages/off-belay/delete", {})).status).toBe(400);
    // The phone's stage picker says what it is.
    expect(await page(`/devices/${phone.deviceId}/screen-time/rules`)).toContain("Off belay (the last stage: it blocks nothing)");
  });
});

describe("migration 8 (off belay)", () => {
  /** A database as a Phase 3 to 7 server left it, with a family's stages. */
  function before(): DB {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(
      db,
      loadMigrations().filter((m) => m.version <= 6),
    );
    const stage = db.prepare("INSERT INTO stages (id, number, name, how, rules, created_at, updated_at) VALUES (?, ?, ?, NULL, '{}', 0, 0)");
    stage.run("s-1", 1, "Starter");
    stage.run("s-2", 4, "Off Belay");
    stage.run("s-3", 2, "Explorer");
    return db;
  }

  it("adds Off belay after the family's stages, and renames a stage of theirs with its name", () => {
    const db = before();
    migrate(db);
    expect(db.prepare("SELECT id, number, name, off_belay FROM stages ORDER BY number").all()).toEqual([
      { id: "s-1", number: 1, name: "Starter", off_belay: 0 },
      { id: "s-3", number: 2, name: "Explorer", off_belay: 0 },
      { id: "s-2", number: 4, name: "Off Belay (before Off belay)", off_belay: 0 },
      { id: "off-belay", number: 5, name: "Off belay", off_belay: 1 },
    ]);
    // There's only ever one, and a hand-over goes with its phone.
    expect(() => db.prepare("UPDATE stages SET off_belay = 1 WHERE id = 's-1'").run()).toThrow(/UNIQUE/);
    db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'A phone', 'h', 0)").run();
    db.prepare("INSERT INTO handovers (device_id, at, by_parent, version) VALUES ('phone-1', 1, NULL, 3)").run();
    db.prepare("DELETE FROM devices WHERE id = 'phone-1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM handovers").get()).toEqual({ n: 0 });
  });

  it("on a fresh database, Off belay is stage 1", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(db.prepare("SELECT id, number, name, how, off_belay FROM stages").all()).toEqual([{ id: "off-belay", number: 1, name: "Off belay", how: null, off_belay: 1 }]);
    expect(JSON.parse((db.prepare("SELECT rules FROM stages").get() as { rules: string }).rules)).toEqual(NO_RULES);
  });
});
