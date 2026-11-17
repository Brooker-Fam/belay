import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy, currentDecision } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, event, pkg, snapshot, testServer, T0, type TestServer } from "./helpers.js";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const phone = await enrollPhone(t, "CI phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps"), pkg("com.android.settings", { system: true })], T0));
  return { t, phone };
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

const policy = (t: TestServer, deviceId: string) => Policy.parse(buildPolicy(t.deps.db, deviceId, t.now()));

describe("the CLI's policy commands", () => {
  it('protect "<phone>" turns protection on, logged as the server', async () => {
    const { t, phone } = await family();
    expect(await cli(t, "protect", "CI phone")).toEqual({ code: 0, out: "CI phone: protection is on (rules version 1). 1 app already on the phone is allowed.", err: "" });
    expect(policy(t, phone.deviceId)).toMatchObject({ version: 1, apps: { new_apps: "ask", decisions: [{ package: "com.example.maps", state: "allowed" }] } });
    expect((await cli(t, "protect", "ci PHONE")).out).toBe("CI phone: protection was already on (rules version 1).");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "policy.protected", deviceName: "CI phone" });
  });

  it('policy "<phone>" --new-apps ask|allow', async () => {
    const { t, phone } = await family();
    expect((await cli(t, "policy", "CI phone", "--new-apps", "ask")).out).toBe("CI phone: new apps wait for a parent's approval (rules version 1). 1 app already on the phone allowed.");
    expect((await cli(t, "policy", "CI phone", "--new-apps=allow")).out).toBe("CI phone: new apps run without asking (rules version 2).");
    expect(policy(t, phone.deviceId).apps.new_apps).toBe("allow");
    const bad = await cli(t, "policy", "CI phone", "--new-apps", "maybe");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain("--new-apps ask|allow");
  });

  it('decide "<phone>" <package> allow|block|undecided', async () => {
    const { t, phone } = await family();
    expect((await cli(t, "decide", "CI phone", "com.example.chat", "block")).out).toBe("CI phone: com.example.chat is blocked (rules version 1).");
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.chat")).toMatchObject({ state: "blocked", decidedBy: "server" });
    expect((await cli(t, "decide", "CI phone", "com.example.chat", "allow")).out).toBe("CI phone: com.example.chat is allowed (rules version 2).");
    expect((await cli(t, "decide", "CI phone", "com.example.chat", "undecided")).out).toBe("CI phone: com.example.chat is without a decision (rules version 3).");
    expect(policy(t, phone.deviceId).apps.decisions).toEqual([]);
    expect((await cli(t, "decide", "CI phone", "family.brooker.belay", "block")).code).toBe(1);
    expect((await cli(t, "decide", "CI phone", "not a package", "allow")).code).toBe(1);
    expect((await cli(t, "decide", "CI phone", "com.example.chat", "maybe")).code).toBe(1);
  });

  it("approves the kid's request when an app is allowed", async () => {
    const { t, phone } = await family();
    await cli(t, "protect", "CI phone");
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "app", package: "com.example.fixture", label: "Fixture", reason: "For the test", asked_at: T0 }] });
    await cli(t, "decide", "CI phone", "com.example.fixture", "allow");
    expect(policy(t, phone.deviceId).requests).toMatchObject([{ id: "request-0001", status: "approved", answered_by: null }]);
  });

  it('pause "<phone>" [--minutes N] and resume "<phone>"', async () => {
    const { t, phone } = await family();
    expect((await cli(t, "pause", "CI phone", "--minutes", "30")).out).toBe("CI phone: paused until 2026-11-16T10:30:00-05:00 (rules version 1).");
    expect(policy(t, phone.deviceId).pause).toEqual({ until: t.now() + 30 * 60_000, note: null });
    expect((await cli(t, "pause", "CI phone", "--note", "Dinner")).out).toBe("CI phone: paused until a parent resumes it (rules version 2).");
    expect(policy(t, phone.deviceId).pause).toEqual({ until: null, note: "Dinner" });
    expect((await cli(t, "resume", "CI phone")).out).toBe("CI phone: resumed (rules version 3).");
    expect((await cli(t, "resume", "CI phone")).out).toBe("CI phone wasn't paused.");
    expect((await cli(t, "pause", "CI phone", "--minutes", "0")).code).toBe(1);
    expect((await cli(t, "pause", "CI phone", "--minutes", "soon")).code).toBe(1);
  });

  it("names the phones when one isn't found, and lists the commands", async () => {
    const { t } = await family();
    const missing = await cli(t, "protect", "Nope");
    expect(missing).toMatchObject({ code: 1, err: 'No phone is called "Nope". The phones are: "CI phone".' });
    expect((await cli(t, "protect")).err).toContain("Name the phone first");
    const unknown = await cli(t, "frobnicate");
    expect(unknown.code).toBe(1);
    for (const command of ['protect "<phone>"', 'policy "<phone>" --new-apps ask|allow', 'decide "<phone>" <package> allow|block|undecided', 'pause "<phone>" [--minutes N]', 'resume "<phone>"']) {
      expect(unknown.err).toContain(command);
    }
  });

  it("status --json adds each phone's policy version, what it enforces, and the kid's requests", async () => {
    const { t, phone } = await family();
    let status = JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, unknown>[] };
    expect(status.phones[0]).toMatchObject({ name: "CI phone", policy_version: 0, enforcement: null, requests: [] });
    await cli(t, "protect", "CI phone");
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, applied_at: T0, suspended_count: 0, problems: [] } }) });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "app", package: "com.example.fixture", label: "Fixture", reason: "For the test", asked_at: T0 }] });
    status = JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, unknown>[] };
    expect(status.phones[0]).toMatchObject({
      policy_version: 1,
      enforcement: { policy_version: 1, applied_at: T0, suspended_count: 0, problems: [] },
      requests: [{ package: "com.example.fixture", status: "pending", reason: "For the test" }],
    });
    const text = (await cli(t, "status")).out;
    expect(text).toContain("1 request waiting");
    expect(text).toContain("rules version 1; the phone applied version 1");
  });

  it("reaches a waiting phone within a second or two, though it runs outside the server", async () => {
    const { t, phone } = await family();
    const waiting = t.app.request("/api/v1/policy?have=0&wait=10", { headers: { authorization: `Bearer ${phone.token}` } });
    await expect.poll(() => t.deps.waiters.size).toBe(1);
    const started = Date.now();
    // The CLI doesn't wake the server's waiters: the server notices the new version in the database.
    await cli(t, "decide", "CI phone", "com.example.maps", "block");
    const res = await waiting;
    expect(res.status).toBe(200);
    expect(Date.now() - started).toBeLessThan(3000);
    expect(((await res.json()) as { policy: Policy }).policy.apps.decisions).toEqual([{ package: "com.example.maps", state: "blocked" }]);
  });
});

describe("new apps asking again, from the CLI", () => {
  const MIN = 60_000;
  /** Ask, a game that waits, allow, a drawing app that runs: then the second ask. */
  async function askedThenAllowed() {
    const { t, phone } = await family();
    expect((await cli(t, "policy", "CI phone", "--new-apps", "ask")).out).toBe("CI phone: new apps wait for a parent's approval (rules version 1). 1 app already on the phone allowed.");
    const install = (name: string) => deviceCall(t, phone.token, "events", { events: [event("installed", name, { to: { code: 1 }, happened_at: t.now() - 1000, detected_at: t.now() })] });
    t.advance(MIN);
    await install("com.example.game");
    t.advance(MIN);
    expect((await cli(t, "policy", "CI phone", "--new-apps", "allow")).out).toBe("CI phone: new apps run without asking (rules version 2).");
    t.advance(MIN);
    await install("com.example.drawing");
    t.advance(MIN);
    const decisions = () => Object.fromEntries(policy(t, phone.deviceId).apps.decisions.map((d) => [d.package, d.state]));
    return { t, decisions };
  }

  it("by default allows the apps installed while new apps were allowed, and leaves the ones waiting before", async () => {
    const { t, decisions } = await askedThenAllowed();
    expect((await cli(t, "policy", "CI phone", "--new-apps", "ask")).out).toBe(
      "CI phone: new apps wait for a parent's approval (rules version 3). Of the apps without a decision, 1 is allowed and 1 waits for a parent.",
    );
    expect(decisions()).toEqual({ "com.example.maps": "allowed", "com.example.drawing": "allowed" });
  });

  it("--allow-waiting also allows the ones waiting before; --hold-new keeps the new ones waiting", async () => {
    let f = await askedThenAllowed();
    expect((await cli(f.t, "policy", "CI phone", "--new-apps", "ask", "--allow-waiting")).out).toContain("2 are allowed and 0 wait for a parent.");
    expect(f.decisions()).toMatchObject({ "com.example.game": "allowed", "com.example.drawing": "allowed" });
    f = await askedThenAllowed();
    expect((await cli(f.t, "policy", "CI phone", "--new-apps", "ask", "--hold-new")).out).toContain("0 are allowed and 2 wait for a parent.");
    expect(f.decisions()).toEqual({ "com.example.maps": "allowed" });
    f = await askedThenAllowed();
    expect((await cli(f.t, "policy", "CI phone", "--new-apps", "ask", "--hold-new", "--allow-waiting")).out).toContain("1 is allowed and 1 waits for a parent.");
    expect(f.decisions()).toEqual({ "com.example.maps": "allowed", "com.example.game": "allowed" });
  });

  it("protect after protection was off says what it allowed", async () => {
    const { t } = await askedThenAllowed();
    expect((await cli(t, "protect", "CI phone")).out).toBe(
      "CI phone: protection is on (rules version 3). Of the apps without a decision, 1 is allowed and 1 waits for a parent.",
    );
  });
});
