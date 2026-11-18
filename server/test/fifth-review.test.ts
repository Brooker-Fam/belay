/**
 * The fifth security review's server probes, turned to assert what holds now. Made-up names,
 * made-up domains and 555-01xx numbers only.
 * - F2: a lock now's result told an AI app with every category off, and the parent, that the kid
 *   was on a call, and when (`waited_for_call`, and the phone's time beside "done"). The phone now
 *   reports one when it has it, during a call too, and nothing in the device API, the server's
 *   store, MCP, the parent page or the activity log says a call was on.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { createParent } from "../src/auth/parents.js";
import { Policy } from "../src/device/schemas.js";
import { listCommands } from "../src/family/commands.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, testServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MIN = 60_000;
const NO_SCOPES = { apps: false, device_status: false, requests: false, screen_time: false, agreement: false, location: false, calls: false, network: false };
const ALL_SCOPES = { apps: true, device_status: true, requests: true, screen_time: true, agreement: true, location: true, calls: true, network: true };

/** One parent, one phone, and an AI app on a personal access token, with the AI categories given. */
async function family(scopes: Record<keyof typeof ALL_SCOPES, boolean> = ALL_SCOPES) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York", aiScopes: scopes });
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
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
  return { t, phone, sam, ctx, call, policy, result };
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
    const entry = listAudit(t.deps.db, { limit: 20, includeReads: false }).find((e) => e.action === "command.expired");
    expect(entry?.detail).toEqual({ kind: "lock_now", command: id, version: expect.any(Number) });
    const columns = (t.deps.db.prepare("PRAGMA table_info(commands)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).not.toContain("waited_for_call");
  });
});
