/**
 * Phase 11's hand-over (docs/protocol.md, "Off belay"): a parent hands the phone over to the kid.
 * It lifts factory reset, debugging and the accounts lock and empties reset protection, sets the
 * policy's `handover` and nothing else, in a new rules version; it's a parent's on the parent page
 * (after typing the phone's name) or the CLI's, never an AI app's, and nothing can lock again
 * while it lasts. Made-up names and account ids only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { revokeDevice } from "../src/family/devices.js";
import { setCalls } from "../src/family/calls/changes.js";
import { cancelHandover, handOver } from "../src/family/offbelay/changes.js";
import { RuleRefused, buildPolicy, decideApp, getRules, protect, setHardening, setRestrictions, type PolicyContext } from "../src/family/policy.js";
import { listGrants } from "../src/oauth/store.js";
import { device, deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, testServer, type TestServer } from "./helpers.js";

const ACCOUNT = "112233445566778899000";

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => { t.deps.waiters.changed(id); } });
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const form = (path: string, fields: Record<string, string>) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => (await get(t, path, sam.cookie)).text();
  // A phone a parent protected and hardened, with its accounts locked: the usual state before a hand-over.
  protect(ctx(), phone.deviceId, parent);
  setRestrictions(ctx(), phone.deviceId, { modify_accounts: true }, parent);
  setHardening(ctx(), phone.deviceId, { factoryReset: true, debugging: true, frpAccounts: [ACCOUNT] }, parent);
  return { t, sam, phone, parent, ctx, policy, form, page };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(""),
    interactive: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("handing a phone over", () => {
  it("changes exactly the locks, reset protection and handover, in one new rules version", async () => {
    const { t, phone, parent, ctx, policy } = await family();
    const before = policy();
    expect(before.restrictions).toMatchObject({ factory_reset: true, debugging: true, modify_accounts: true });
    expect(before.frp_accounts).toEqual([ACCOUNT]);
    expect(before.handover).toBeNull();
    t.advance(60_000);
    const done = handOver(ctx(), phone.deviceId, parent);
    expect(done.result).toMatchObject({ already: false, lifted: ["factory_reset", "debugging", "modify_accounts"], frpAccounts: 1 });
    expect(done.result.handover).toMatchObject({ at: t.now(), byName: "Sam", version: before.version + 1 });
    const after = policy();
    expect(after.version).toBe(before.version + 1);
    expect(after.issued_at).toBe(t.now());
    const { version: _v, issued_at: _i, ...rest } = after;
    const { version: _bv, issued_at: _bi, ...was } = before;
    expect(rest).toEqual({
      ...was,
      restrictions: { ...was.restrictions, factory_reset: false, debugging: false, modify_accounts: false },
      frp_accounts: [],
      handover: { at: t.now(), by: "Sam" },
    });
    // The parent page's protection is otherwise as it was: the safe locks, the filter, new apps asking.
    expect(getRules(t.deps.db, phone.deviceId)).toMatchObject({ newApps: "ask", restrictions: { safe_boot: true, add_user: true, config_private_dns: true } });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({
      actor: "parent",
      action: "policy.handover",
      deviceName: "Alex's phone",
      detail: { lifted: ["factory_reset", "debugging", "modify_accounts"], frp_accounts_removed: 1, version: before.version + 1 },
    });
    // Again: nothing more changes.
    const again = handOver(ctx(), phone.deviceId, parent);
    expect(again).toMatchObject({ changed: false, version: before.version + 1, result: { already: true } });
    expect(policy().version).toBe(before.version + 1);
  });

  it("is a person's only, and needs a connected phone", async () => {
    const { t, phone, sam, ctx } = await family();
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
    // The types already refuse it; this is the run-time check.
    expect(() => handOver(ctx(), phone.deviceId, ai as unknown as Parameters<typeof handOver>[2])).toThrow(/an AI app can't/);
    expect(() => cancelHandover(ctx(), phone.deviceId, ai as unknown as Parameters<typeof cancelHandover>[2])).toThrow(/an AI app can't/);
    revokeDevice(t.deps.db, phone.deviceId, t.now());
    expect(() => handOver(ctx(), phone.deviceId, { kind: "server" })).toThrow(/disconnected/);
    // No MCP tool or proposal kind is about it, and connecting an AI app grants none.
    expect(listGrants(t.deps.db)).toEqual([]);
  });

  it("while it lasts, nothing it lifted locks again; taken back, the phone stops showing it and the locks stay lifted", async () => {
    const { t, phone, parent, ctx, policy } = await family();
    handOver(ctx(), phone.deviceId, parent);
    expect(() => setHardening(ctx(), phone.deviceId, { factoryReset: true, debugging: false, frpAccounts: [] }, parent)).toThrow(RuleRefused);
    expect(() => setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [ACCOUNT] }, parent)).toThrow(/Cancel the hand-over first/);
    expect(() => setRestrictions(ctx(), phone.deviceId, { modify_accounts: true }, parent)).toThrow(/Cancel the hand-over first/);
    // Other locks can still change, and turning hardening off is fine.
    setRestrictions(ctx(), phone.deviceId, { safe_boot: false }, parent);
    setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [] }, parent);
    expect(policy().restrictions).toMatchObject({ safe_boot: false, factory_reset: false, modify_accounts: false });
    const version = policy().version;
    expect(cancelHandover(ctx(), phone.deviceId, parent)).toMatchObject({ changed: true, version: version + 1, result: { was: true } });
    expect(policy().handover).toBeNull();
    expect(policy().restrictions).toMatchObject({ factory_reset: false, debugging: false, modify_accounts: false });
    expect(policy().frp_accounts).toEqual([]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "policy.handover_cancelled" });
    // Now hardening can go back on.
    setHardening(ctx(), phone.deviceId, { factoryReset: true, debugging: true, frpAccounts: [ACCOUNT] }, parent);
    expect(policy().restrictions).toMatchObject({ factory_reset: true, debugging: true });
  });

  it("on the phone's page: only after the parent types the phone's name; then what's next, and taking it back", async () => {
    const { t, phone, parent, ctx, form, page, policy } = await family();
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.racer", { label: "Racer" })], t.now()));
    decideApp(ctx(), phone.deviceId, "com.example.racer", "blocked", parent);
    setCalls(ctx(), phone.deviceId, { enabled: true, mode: "contacts" }, parent);
    const before = await page(`/devices/${phone.deviceId}`);
    expect(before).toContain("Hand this phone over");
    expect(before).toContain("isn&#39;t on Off belay yet");
    expect(before).toContain("Belay still holds new apps for you, hides an app you blocked, filters the web, decides who can call and be called on this phone");
    const wrong = await form(`/devices/${phone.deviceId}/handover`, { confirm: "Alex" });
    expect(wrong.status).toBe(400);
    expect(await wrong.text()).toContain("type the phone&#39;s name, Alex&#39;s phone, in the box");
    expect(policy().handover).toBeNull();
    // A phone's keyboard types a curly apostrophe, and extra spaces and capitals don't count either.
    const done = await form(`/devices/${phone.deviceId}/handover`, { confirm: " alex\u2019s  PHONE " });
    expect(done.status).toBe(302);
    expect(done.headers.get("location")).toBe(`/devices/${phone.deviceId}?saved=handed_over#handover`);
    expect(policy().handover).toEqual({ at: t.now(), by: "Sam" });
    const waiting = await page(`/devices/${phone.deviceId}?saved=handed_over`);
    expect(waiting).toContain("Handed over. The phone shows the kid what happens next");
    expect(waiting).toContain(`Waiting for the phone to get it (rules version ${policy().version})`);
    // The phone reports it applied that version.
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: policy().version } }) });
    const has = await page(`/devices/${phone.deviceId}`);
    expect(has).toContain(`The phone has it (it applied rules version ${policy().version})`);
    expect(has).toContain("Disconnect it below, then delete everything about it");
    expect((await form(`/devices/${phone.deviceId}/handover/cancel`, {})).headers.get("location")).toBe(`/devices/${phone.deviceId}?saved=handover_cancelled#handover`);
    expect(policy().handover).toBeNull();
  });

  it('the CLI: handover "<phone>" prints one sentence, and status --json shows it', async () => {
    const { t, phone, policy } = await family();
    const status = async () => (JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, unknown>[] }).phones[0] ?? {};
    expect((await status()).handover).toBeNull();
    const version = policy().version;
    const done = await cli(t, "handover", "alex's phone");
    expect(done).toEqual({
      code: 0,
      out: `Alex's phone is handed over (rules version ${version + 1}): factory reset, debugging and accounts are unlocked, reset protection is cleared and Play may use any account, and the phone tells the kid to back up and reset it from Settings.`,
      err: "",
    });
    expect(policy()).toMatchObject({ handover: { at: t.now(), by: null }, frp_accounts: [], restrictions: { factory_reset: false, debugging: false, modify_accounts: false } });
    expect((await status()).handover).toEqual({ at: t.now(), by: null, version: version + 1 });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "policy.handover", deviceName: "Alex's phone" });
    expect((await cli(t, "handover", "Alex's phone")).out).toBe(`Alex's phone was already handed over (rules version ${version + 1}).`);
    expect(await cli(t, "handover", "Nobody's phone")).toMatchObject({ code: 1, err: 'No phone is called "Nobody\'s phone". The phones are: "Alex\'s phone".' });
    expect(phone.deviceId).toBeTruthy();
  });
});
