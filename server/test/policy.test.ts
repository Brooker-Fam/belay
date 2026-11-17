import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import {
  DNS_FILTERS,
  SAFE_CHROME,
  answerRequest,
  buildPolicy,
  currentDecision,
  decideApp,
  decisionHistory,
  getRules,
  pausePhone,
  policyVersion,
  protect,
  resumePhone,
  setHardening,
  setMaintenance,
  setNewApps,
  setRestrictions,
  setSupportMessage,
  setWeb,
  unprotect,
  type PolicyContext,
} from "../src/family/policy.js";
import { getRequest, saveRequests } from "../src/family/requests.js";
import { deviceCall, enrollPhone, event, pkg, snapshot, testServer, T0 } from "./helpers.js";

const MIN = 60_000;
const DAY = 86_400_000;

async function setup() {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(
    t,
    phone.token,
    "inventory",
    snapshot([pkg("com.example.maps", { label: "Trail Maps" }), pkg("com.example.chat", { label: "Chatter Box" }), pkg("com.android.settings", { system: true, source: "preinstalled" })], T0),
  );
  const woke: string[] = [];
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now(), changed: (id) => woke.push(id) });
  const sam = { kind: "parent", parentId: parent.id } as const;
  const claude = { kind: "ai", parentId: parent.id, clientName: "Claude" } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const decisions = () => Object.fromEntries(policy().apps.decisions.map((d) => [d.package, d.state]));
  /** A new app arrives after the rules were set, so it has no decision. */
  const install = async (name: string) => {
    await deviceCall(t, phone.token, "events", { events: [event("installed", name, { to: { code: 1 }, happened_at: t.now() - 1000, detected_at: t.now() })] });
  };
  const ask = (id: string, name: string, reason: string | null = null) =>
    saveRequests(t.deps.db, phone.deviceId, [{ id, kind: "app", package: name, label: name.split(".").at(-1) ?? name, reason, asked_at: t.now() }], t.now());
  return { t, parent, phone, ctx, sam, claude, woke, policy, decisions, install, ask };
}

describe("the policy", () => {
  it("is version 0, enforcing nothing, for a phone without rules", async () => {
    const { policy } = await setup();
    expect(policy()).toMatchObject({
      version: 0,
      apps: { new_apps: "allow", decisions: [] },
      pause: null,
      web: { private_dns: null, chrome: null, hide_browsers: false },
      maintenance_until: null,
      frp_accounts: [],
      support_message: null,
      requests: [],
    });
    expect(Object.values(policy().restrictions).every((locked) => !locked)).toBe(true);
  });

  it("goes up one version with each change, and only when something changed", async () => {
    const { t, phone, ctx, sam, woke, policy } = await setup();
    expect(setSupportMessage(ctx(), phone.deviceId, "Ask Mom or Dad", sam)).toMatchObject({ version: 1, changed: true });
    expect(setSupportMessage(ctx(), phone.deviceId, " Ask Mom or Dad ", sam)).toMatchObject({ version: 1, changed: false });
    t.advance(MIN);
    expect(setNewApps(ctx(), phone.deviceId, "ask", sam).version).toBe(2);
    expect(policy()).toMatchObject({ version: 2, issued_at: t.now(), support_message: "Ask Mom or Dad" });
    expect(policyVersion(t.deps.db, phone.deviceId)).toBe(2);
    expect(woke).toEqual([phone.deviceId, phone.deviceId]);
  });

  it("logs each change with who made it", async () => {
    const { t, phone, ctx, sam, claude } = await setup();
    protect(ctx(), phone.deviceId, sam);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude, { note: "Strangers can message" });
    const log = listAudit(t.deps.db, { limit: 10, includeReads: false });
    expect(log[0]).toMatchObject({ actor: "ai", clientName: "Claude", parentName: "Sam", action: "app.blocked", detail: { package: "com.example.chat", label: "Chatter Box", version: 2 } });
    expect(log[1]).toMatchObject({ actor: "parent", parentName: "Sam", action: "policy.protected", detail: { grandfathered: 2, version: 1 } });
  });
});

describe("turning protection on", () => {
  it("asks about new apps, allows every user app already on the phone, and locks the safe settings", async () => {
    const { t, phone, ctx, sam, policy, decisions } = await setup();
    expect(protect(ctx(), phone.deviceId, sam)).toMatchObject({ version: 1, result: { grandfathered: 2, alreadyOn: false } });
    expect(decisions()).toEqual({ "com.example.chat": "allowed", "com.example.maps": "allowed" });
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.maps")).toMatchObject({ decidedBy: "grandfathered", parentName: "Sam" });
    const p = policy();
    expect(p.apps.new_apps).toBe("ask");
    expect(p.restrictions).toEqual({
      safe_boot: true,
      add_user: true,
      unknown_sources: true,
      config_vpn: true,
      config_private_dns: true,
      config_date_time: true,
      config_default_apps: true,
      modify_accounts: false,
      sim: false,
      factory_reset: false,
      debugging: false,
    });
    expect(p.web).toEqual({ private_dns: "family-filter-dns.cleanbrowsing.org", chrome: SAFE_CHROME, hide_browsers: false });
    expect(p.frp_accounts).toEqual([]);
    expect(getRules(t.deps.db, phone.deviceId).protectedAt).toBe(t.now());
  });

  it("is one step: doing it again changes nothing", async () => {
    const { phone, ctx, sam } = await setup();
    protect(ctx(), phone.deviceId, sam);
    expect(protect(ctx(), phone.deviceId, sam)).toMatchObject({ version: 1, changed: false, result: { alreadyOn: true } });
  });

  it("keeps a web filter the parent already chose, and existing blocks", async () => {
    const { phone, ctx, sam, policy, decisions } = await setup();
    setWeb(ctx(), phone.deviceId, { privateDns: DNS_FILTERS.adguard.host }, sam);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", sam);
    protect(ctx(), phone.deviceId, sam);
    expect(policy().web.private_dns).toBe("family.adguard-dns.com");
    expect(decisions()).toEqual({ "com.example.chat": "blocked", "com.example.maps": "allowed" });
  });

  it("then each piece changes on its own", async () => {
    const { phone, ctx, sam, policy } = await setup();
    protect(ctx(), phone.deviceId, sam);
    setRestrictions(ctx(), phone.deviceId, { config_vpn: false, sim: true }, sam);
    setWeb(ctx(), phone.deviceId, { chrome: { ...SAFE_CHROME, youtube_restrict: "moderate" }, hideBrowsers: true }, sam);
    const p = policy();
    expect(p.restrictions).toMatchObject({ config_vpn: false, sim: true, safe_boot: true });
    expect(p.web).toMatchObject({ private_dns: "family-filter-dns.cleanbrowsing.org", chrome: { youtube_restrict: "moderate" }, hide_browsers: true });
  });

  it("turning it off lifts the rules but keeps what was blocked", async () => {
    const { phone, ctx, sam, policy, decisions } = await setup();
    protect(ctx(), phone.deviceId, sam);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", sam);
    pausePhone(ctx(), phone.deviceId, { minutes: null }, sam);
    unprotect(ctx(), phone.deviceId, sam);
    const p = policy();
    expect(p).toMatchObject({ apps: { new_apps: "allow" }, pause: null, web: { private_dns: null, chrome: null, hide_browsers: false } });
    expect(Object.values(p.restrictions).every((locked) => !locked)).toBe(true);
    expect(decisions()["com.example.chat"]).toBe("blocked");
  });
});

describe("new apps", () => {
  it("turning ask on grandfathers every user app without a decision, each time", async () => {
    const { phone, ctx, sam, decisions, install } = await setup();
    setNewApps(ctx(), phone.deviceId, "ask", sam);
    await install("com.example.game");
    expect(decisions()["com.example.game"]).toBeUndefined();
    setNewApps(ctx(), phone.deviceId, "allow", sam);
    await install("com.example.drawing");
    expect(setNewApps(ctx(), phone.deviceId, "ask", sam).result.grandfathered).toBe(2);
    expect(decisions()).toMatchObject({ "com.example.game": "allowed", "com.example.drawing": "allowed" });
  });

  it("keeps every decision, so the history says why", async () => {
    const { t, phone, ctx, sam, claude } = await setup();
    protect(ctx(), phone.deviceId, sam);
    t.advance(MIN);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude, { note: "Strangers can message" });
    t.advance(MIN);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "undecided", { kind: "server" });
    expect(decisionHistory(t.deps.db, phone.deviceId, "com.example.chat").map((d) => [d.state, d.decidedBy, d.clientName, d.note])).toEqual([
      ["undecided", "server", null, null],
      ["blocked", "ai", "Claude", "Strangers can message"],
      ["allowed", "grandfathered", null, null],
    ]);
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.chat")).toBeNull();
  });
});

describe("who may change what", () => {
  it("an AI app may block apps, never allow one or clear a decision", async () => {
    const { phone, ctx, claude, decisions } = await setup();
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.chat", "allowed", claude)).toThrow(/only block/);
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.chat", "undecided", claude)).toThrow(/only block/);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude);
    expect(decisions()).toEqual({ "com.example.chat": "blocked" });
  });

  it("nobody blocks the apps 911 and 988 need, or Belay", async () => {
    const { phone, ctx, sam } = await setup();
    for (const name of ["family.brooker.belay", "com.android.phone", "com.google.android.apps.messaging"]) {
      expect(() => decideApp(ctx(), phone.deviceId, name, "blocked", sam)).toThrow(/never blocks/);
    }
  });

  it("an AI app's pause only ever makes a pause longer", async () => {
    const { t, phone, ctx, sam, claude, policy } = await setup();
    pausePhone(ctx(), phone.deviceId, { minutes: 60, note: "Homework first" }, sam);
    expect(pausePhone(ctx(), phone.deviceId, { minutes: 30 }, claude).result).toEqual({ until: t.now() + 60 * MIN, kept: true });
    expect(policy().pause).toEqual({ until: t.now() + 60 * MIN, note: "Homework first" });
    pausePhone(ctx(), phone.deviceId, { minutes: 120, note: "Bedtime" }, claude);
    expect(policy().pause).toEqual({ until: t.now() + 120 * MIN, note: "Bedtime" });
    pausePhone(ctx(), phone.deviceId, { minutes: null }, sam);
    expect(pausePhone(ctx(), phone.deviceId, { minutes: 10 }, claude).result.until).toBeNull();
  });

  it("an AI app's note only goes with a pause it sets or lengthens", async () => {
    const { t, phone, ctx, sam, claude, policy } = await setup();
    pausePhone(ctx(), phone.deviceId, { minutes: 240, note: "Homework first" }, sam);
    const version = policy().version;
    const shorter = pausePhone(ctx(), phone.deviceId, { minutes: 1, note: "Your parent says you can have everything back." }, claude);
    expect(shorter).toMatchObject({ changed: false, result: { kept: true, until: t.now() + 240 * MIN } });
    expect(policy()).toMatchObject({ version, pause: { until: t.now() + 240 * MIN, note: "Homework first" } });
    // Exactly as long isn't longer either.
    expect(pausePhone(ctx(), phone.deviceId, { minutes: 240, note: "Same length" }, claude).result.kept).toBe(true);
    expect(policy().pause?.note).toBe("Homework first");
    // Longer: its note goes with it; without one, the note there stays.
    pausePhone(ctx(), phone.deviceId, { minutes: 300 }, claude);
    expect(policy().pause).toEqual({ until: t.now() + 300 * MIN, note: "Homework first" });
    pausePhone(ctx(), phone.deviceId, { minutes: 360, note: "Bedtime" }, claude);
    expect(policy().pause).toEqual({ until: t.now() + 360 * MIN, note: "Bedtime" });
    // Until a parent resumes it, nothing an AI app says changes the note.
    pausePhone(ctx(), phone.deviceId, { minutes: null, note: "Until we talk" }, sam);
    pausePhone(ctx(), phone.deviceId, { minutes: null, note: "Never mind" }, claude);
    expect(policy().pause).toEqual({ until: null, note: "Until we talk" });
    // A parent's change always applies, shorter or not.
    pausePhone(ctx(), phone.deviceId, { minutes: 30, note: "Half an hour" }, sam);
    expect(policy().pause).toEqual({ until: t.now() + 30 * MIN, note: "Half an hour" });
    // With no pause running, an AI app's pause and note apply.
    t.advance(31 * MIN);
    pausePhone(ctx(), phone.deviceId, { minutes: 15, note: "Dinner" }, claude);
    expect(policy().pause).toEqual({ until: t.now() + 15 * MIN, note: "Dinner" });
  });

  it("checks who may loosen at run time too, not only in the types", async () => {
    const { phone, ctx, claude } = await setup();
    type Parent = { kind: "parent"; parentId: string };
    const ai = claude as unknown as Parent;
    for (const change of [
      () => protect(ctx(), phone.deviceId, ai),
      () => unprotect(ctx(), phone.deviceId, ai),
      () => setNewApps(ctx(), phone.deviceId, "allow", ai),
      () => resumePhone(ctx(), phone.deviceId, ai),
      () => setRestrictions(ctx(), phone.deviceId, { safe_boot: false }, ai),
      () => setWeb(ctx(), phone.deviceId, { privateDns: null }, ai),
      () => setSupportMessage(ctx(), phone.deviceId, "x", ai),
      () => answerRequest(ctx(), phone.deviceId, "request-0001", "approved", ai, null),
    ]) {
      expect(change).toThrow(/AI app can't loosen/);
    }
    const server = { kind: "server" } as unknown as Parent;
    expect(() => setHardening(ctx(), phone.deviceId, { factoryReset: true, debugging: true, frpAccounts: [] }, server)).toThrow(/Only a parent/);
    expect(() => setMaintenance(ctx(), phone.deviceId, null, ai)).toThrow(/Only a parent/);
  });

  it("general restriction changes can't touch hardening", async () => {
    const { phone, ctx, sam, policy } = await setup();
    expect(() => setRestrictions(ctx(), phone.deviceId, { factory_reset: true } as never, sam)).toThrow(/Not an ordinary restriction/);
    expect(() => setRestrictions(ctx(), phone.deviceId, { debugging: true } as never, sam)).toThrow(/Not an ordinary restriction/);
    expect(policy().restrictions.factory_reset).toBe(false);
    setHardening(ctx(), phone.deviceId, { factoryReset: true, debugging: true, frpAccounts: ["112233445566778899000"] }, sam);
    expect(policy()).toMatchObject({ restrictions: { factory_reset: true, debugging: true }, frp_accounts: ["112233445566778899000"] });
  });
});

describe("pause and maintenance", () => {
  it("a pause lasts until its time, or until a parent resumes", async () => {
    const { t, phone, ctx, sam, policy } = await setup();
    pausePhone(ctx(), phone.deviceId, { minutes: 30, note: "Dinner" }, sam);
    expect(policy().pause).toEqual({ until: t.now() + 30 * MIN, note: "Dinner" });
    t.advance(31 * MIN);
    expect(policy().pause).toBeNull();
    pausePhone(ctx(), phone.deviceId, { minutes: null }, sam);
    expect(policy().pause).toEqual({ until: null, note: null });
    expect(resumePhone(ctx(), phone.deviceId, sam).result.wasPaused).toBe(true);
    expect(policy().pause).toBeNull();
  });

  it("maintenance mode ends on its own", async () => {
    const { t, phone, ctx, sam, policy } = await setup();
    setMaintenance(ctx(), phone.deviceId, t.now() + 60 * MIN, sam);
    expect(policy().maintenance_until).toBe(t.now() + 60 * MIN);
    t.advance(61 * MIN);
    expect(policy().maintenance_until).toBeNull();
  });
});

describe("the kid's requests in the policy", () => {
  it("cover the last 30 days, newest first, and any still waiting", async () => {
    const { t, phone, ctx, sam, policy, ask } = await setup();
    ask("request-0001", "com.example.old");
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", sam, "Not this one");
    ask("request-0002", "com.example.waiting");
    t.advance(20 * DAY);
    ask("request-0003", "com.example.newer");
    expect(policy().requests.map((r) => r.id)).toEqual(["request-0003", "request-0002", "request-0001"]);
    t.advance(11 * DAY);
    expect(policy().requests.map((r) => [r.id, r.status])).toEqual([
      ["request-0003", "pending"],
      ["request-0002", "pending"],
    ]);
  });

  it("approving one allows the app, answers in the parent's name, and bumps the version once", async () => {
    const { t, phone, ctx, sam, policy, decisions, install, ask } = await setup();
    protect(ctx(), phone.deviceId, sam);
    await install("com.example.game");
    ask("request-0001", "com.example.game", "My friends play it");
    t.advance(MIN);
    const answered = answerRequest(ctx(), phone.deviceId, "request-0001", "approved", sam, "OK, on weekends");
    expect(answered).toMatchObject({ version: 2, changed: true });
    expect(decisions()["com.example.game"]).toBe("allowed");
    expect(policy().requests).toEqual([{ id: "request-0001", status: "approved", note: "OK, on weekends", answered_at: t.now(), answered_by: "Sam" }]);
  });

  it("declining or 'let's talk' leaves the app waiting", async () => {
    const { phone, ctx, sam, decisions, install, ask } = await setup();
    protect(ctx(), phone.deviceId, sam);
    await install("com.example.game");
    ask("request-0001", "com.example.game");
    answerRequest(ctx(), phone.deviceId, "request-0001", "talk", sam, "Let's talk at dinner");
    expect(decisions()["com.example.game"]).toBeUndefined();
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", sam, null);
    expect(decisions()["com.example.game"]).toBeUndefined();
  });

  it("allowing an app answers the kid's open requests for it", async () => {
    const { t, phone, ctx, sam, install, ask } = await setup();
    protect(ctx(), phone.deviceId, sam);
    await install("com.example.game");
    ask("request-0001", "com.example.game");
    decideApp(ctx(), phone.deviceId, "com.example.game", "allowed", sam);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "approved", answeredBy: "Sam" });
  });

  it("don't change the version when they arrive: the phone knows its own", async () => {
    const { phone, ctx, sam, policy, ask } = await setup();
    protect(ctx(), phone.deviceId, sam);
    ask("request-0001", "com.example.game");
    expect(policy()).toMatchObject({ version: 1, requests: [{ id: "request-0001", status: "pending" }] });
  });
});
