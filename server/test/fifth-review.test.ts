/**
 * The fifth security review's server probes, turned to assert what holds now. Made-up names,
 * made-up domains (helpline.example stands for a helpline's site) and 555-01xx numbers only.
 * - F2: a lock now's result told an AI app with every category off, and the parent, that the kid
 *   was on a call, and when (`waited_for_call`, and the phone's time beside "done"). The phone now
 *   reports one when it has it, during a call too, and nothing in the device API, the server's
 *   store, MCP, the parent page or the activity log says a call was on.
 * - F4 and F5, documented (threat-model.md): an AI app that read network activity before a website
 *   was made private sees that website's entries go, and get_policy's version moves; the parent
 *   page says to add private websites first. I3: a day's counted_until can be a private lookup's
 *   time. And a private website in another form never lands.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { listCommands } from "../src/family/commands.js";
import { setNetworkLog, setPrivateWebsite } from "../src/family/network/changes.js";
import { networkDays } from "../src/family/network/store.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, signIn, testServer, T0 } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MIN = 60_000;
const NO_SCOPES = { apps: false, device_status: false, requests: false, screen_time: false, agreement: false, location: false, calls: false, network: false };
const ALL_SCOPES = { apps: true, device_status: true, requests: true, screen_time: true, agreement: true, location: true, calls: true, network: true };

/** One parent, one phone, and an AI app on a personal access token, with the AI categories given. */
async function family(scopes: Record<keyof typeof ALL_SCOPES, boolean> = ALL_SCOPES) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York", aiScopes: scopes });
  const session = await signIn(t);
  const parent = session.parent;
  const phone = await enrollPhone(t, "Alex's phone");
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
  /** The phone's check-in with one command result. */
  const result = (id: string, outcome: "done" | "failed" | "expired", extra: Record<string, unknown> = {}) =>
    deviceCall(t, phone.token, "checkin", {
      status: device({ enforcement: { policy_version: policy().version, applied_at: t.now(), commands: [{ id, result: outcome, at: t.now(), ...extra }] } }),
    });
  const page = async (path: string) => (await get(t, path, session.cookie)).text();
  return { t, phone, sam, ctx, call, policy, result, page };
}

const TODAY = "2026-11-16";
const entry = (pkg: string, domain: string, lookups = 1) => ({ package: pkg, domain, lookups });
const day = (entries: unknown[], over: Record<string, unknown> = {}) => ({ day: TODAY, zone: "America/New_York", as_of: T0, entries, dropped: 0, ...over });

/** The days' entries an AI app reads, as "day package domain lookups". */
function domainsIn(json: Record<string, any>): string[] {
  return (json.days ?? []).flatMap((d: any) => (d.apps ?? []).flatMap((a: any) => (a.domains ?? []).map((x: any) => `${d.day} ${a.untrusted.package} ${x.untrusted.domain} ${x.lookups}`)));
}

/** With every category on and network logging on for the phone. */
async function withNetwork() {
  const f = await family(ALL_SCOPES);
  setNetworkLog(f.ctx(), f.phone.deviceId, true, f.sam);
  const network = (days: unknown[]) => deviceCall(f.t, f.phone.token, "network", { days });
  return { ...f, network };
}

describe("F2: no lock now's result tells of a call", () => {
  it("with every AI category off, get_rules says the same of every lock, with no time of the phone's", async () => {
    const { t, call, policy, result } = await family(NO_SCOPES);
    const sent = "2026-11-16T10:00:00-05:00";
    expect((await call("lock_phone", { device: "Alex's phone", minutes: 5 })).isError).toBe(false);
    // The phone reports it when it has it, a call on or not: done.
    expect((await result(policy().commands[0]?.id ?? "", "done")).status).toBe(200);
    expect((await call("get_rules", { device: "Alex's phone" })).json.last_lock).toEqual({
      sent,
      state: "done: the phone has it, and locks its screen at once, or as soon as a call ends",
    });
    // A phone that got it too late: expired, in the one set of words, whatever it was doing.
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    const late = policy().commands[0]?.id ?? "";
    t.advance(11 * MIN);
    expect((await result(late, "expired")).status).toBe(200);
    const rules = await call("get_rules", { device: "Alex's phone" });
    expect(rules.json.last_lock).toEqual({ sent, state: "not done: the phone got it too late, so it didn't lock" });
    expect(rules.text).not.toMatch(/a call was on|waited|phone_said_at/);
    // The calls themselves stay where the Calls category is: off.
    expect((await call("get_calls", { device: "Alex's phone" })).isError).toBe(true);
  });

  it("a lock the phone reports after a wait carries no time that says when a call ended", async () => {
    const { t, call, policy, result } = await family(NO_SCOPES);
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    // The review's phone said "done" 7 minutes after it was sent; today's says so at once, but the
    // server shows no time of the phone's either way.
    t.advance(7 * MIN);
    expect((await result(policy().commands[0]?.id ?? "", "done")).status).toBe(200);
    const lock = (await call("get_rules", { device: "Alex's phone" })).json.last_lock;
    expect(Object.keys(lock as object).sort()).toEqual(["sent", "state"]);
    expect(lock.sent).toBe("2026-11-16T10:00:00-05:00");
  });

  it("the device API has no waited_for_call: a phone that sends one is refused whole, and nothing is kept", async () => {
    const { t, phone, call, policy, result } = await family(NO_SCOPES);
    await call("lock_phone", { device: "Alex's phone", minutes: 5 });
    const id = policy().commands[0]?.id ?? "";
    t.advance(11 * MIN);
    expect((await result(id, "expired", { waited_for_call: true })).status).toBe(400);
    expect(listCommands(t.deps.db, phone.deviceId, t.now(), { kind: "lock_now" })[0]).toMatchObject({ id, result: null, state: "not_done" });
    expect(Object.keys(listCommands(t.deps.db, phone.deviceId, t.now())[0] ?? {})).not.toContain("waitedForCall");
    // Sent as the phone sends it now, it's kept, and the activity log has only the kind and the id.
    expect((await result(id, "expired")).status).toBe(200);
    const logged = listAudit(t.deps.db, { limit: 20, includeReads: false }).find((e) => e.action === "command.expired");
    expect(logged?.detail).toEqual({ kind: "lock_now", command: id, version: expect.any(Number) });
    const columns = (t.deps.db.prepare("PRAGMA table_info(commands)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("waited_for_call");
  });
});

describe("F4, documented: an AI app that read before can see a private website go", () => {
  it("two reads differ in exactly that website's entries, and the parent page says to add them first", async () => {
    const { t, network, call, ctx, phone, sam, page } = await withNetwork();
    const lastLookup = T0 + 5 * MIN;
    const res = await network([
      day([entry("com.example.browser", "helpline.example", 9), entry("com.example.browser", "news.example", 4), entry("com.example.chat", "chat.example", 12)], { as_of: lastLookup }),
      day([entry("com.example.browser", "helpline.example", 3), entry("com.example.chat", "chat.example", 2)], { day: "2026-11-15", as_of: T0 - 86_400_000 }),
    ]);
    expect(res.status).toBe(200);
    const before = await call("get_network_activity", { device: "Alex's phone" });
    t.advance(MIN);
    setPrivateWebsite(ctx(), phone.deviceId, "https://www.helpline.example/chat", true, sam);
    const after = await call("get_network_activity", { device: "Alex's phone" });
    // Inherent to deleting them (threat-model.md): what went is that website's, and nothing came.
    const gone = domainsIn(before.json).filter((x) => !domainsIn(after.json).includes(x));
    expect(gone).toEqual(["2026-11-16 com.example.browser helpline.example 9", "2026-11-15 com.example.browser helpline.example 3"]);
    expect(domainsIn(after.json).filter((x) => !domainsIn(before.json).includes(x))).toEqual([]);
    expect(after.text).not.toContain("helpline");
    // I3: the day's counted_until is still the time of a lookup counted before (here, the private one's): a time, never a name.
    expect(Date.parse(after.json.days.find((d: any) => d.day === TODAY).counted_until)).toBe(lastLookup);
    // The parent page says it, where private websites are added.
    const html = await page(`/devices/${phone.deviceId}`);
    expect(html).toContain("An AI app that read this phone&#39;s network activity before you add one can see that website go from what");
    expect(html).toContain("so add them before you turn logging, or AI apps&#39; Network category, on.");
  });
});

describe("F5, kept: get_policy's version moves when a website is made private", () => {
  it("version and changed move, and nothing an AI app reads names the website", async () => {
    const { t, call, ctx, phone, sam } = await withNetwork();
    const before = await call("get_policy", { device: "Alex's phone" });
    t.advance(5 * MIN);
    setPrivateWebsite(ctx(), phone.deviceId, "helpline.example", true, sam);
    const after = await call("get_policy", { device: "Alex's phone" });
    expect(after.json.version).toBe(Number(before.json.version) + 1);
    expect(after.json.changed).not.toBe(before.json.changed);
    const rest = (j: Record<string, any>) => Object.fromEntries(Object.entries(j).filter(([k]) => !["version", "changed", "applied_by_the_phone"].includes(k)));
    expect(rest(after.json)).toEqual(rest(before.json));
    for (const [tool, args] of [["get_policy", { device: "Alex's phone" }], ["get_rules", { device: "Alex's phone" }], ["get_contacts", { device: "Alex's phone" }], ["get_device_status", { device: "Alex's phone" }], ["list_devices", {}]] as const) {
      expect((await call(tool, args)).text, tool).not.toContain("helpline");
    }
  });
});

describe("sound: a private website in another form never lands", () => {
  it("case, a trailing dot, a name under it and whitespace are dropped; a Unicode or doubled-dot form is refused whole", async () => {
    const { t, network, ctx, phone, sam } = await withNetwork();
    setPrivateWebsite(ctx(), phone.deviceId, "helpline.example", true, sam);
    const ok = await network([day([entry("com.example.browser", "HELPLINE.example."), entry("com.example.browser", "chat.helpline.example"), entry("com.example.browser", " helpline.example "), entry("com.example.chat", "chat.example")])]);
    expect(ok.status).toBe(200);
    expect(networkDays(t.deps.db, phone.deviceId).flatMap((d) => d.entries.map((e) => e.domain))).toEqual(["chat.example"]);
    for (const odd of ["helpline.example..", "hélpline.example"]) {
      expect((await network([day([entry("com.example.browser", odd), entry("com.example.chat", "chat.example", 2)])])).status, odd).toBe(400);
    }
  });
});
