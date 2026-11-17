/**
 * What can pile up in a phone's policy is bounded: decisions about apps the phone never reported,
 * the policy's size, and how many MCP messages one request carries (the security review's
 * finding 1: thousands of made-up blocks made the policy too large for the phone to take).
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import {
  LIMITS,
  RuleRefused,
  SAFE_CHROME,
  TOO_LARGE,
  buildPolicy,
  clearPreDecisions,
  currentDecision,
  decideApp,
  decisionHistory,
  preDecisions,
  setWeb,
  type PolicyContext,
} from "../src/family/policy.js";
import { RateLimiter } from "../src/ratelimit.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, testServer, T0, type TestServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
/** android/app/.../sync/DeviceApi.kt MAX_POLICY_BYTES: the phone refuses a larger answer. */
const PHONE_MAX_POLICY_BYTES = 1024 * 1024;

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps", { label: "Trail Maps" }), pkg("com.example.chat", { label: "Chatter Box" })], T0));
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const claude = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const size = () => Buffer.byteLength(JSON.stringify(buildPolicy(t.deps.db, phone.deviceId, t.now())));
  return { t, sam, phone, ctx, parent, claude, policy, size };
}

/** Decisions made straight in the database, to set up a phone that already has many. */
function seedDecisions(t: TestServer, deviceId: string, packages: string[], by: "parent" | "ai", parentId: string) {
  const insert = t.deps.db.prepare(
    "INSERT INTO app_decisions (device_id, package, state, decided_by, parent_id, client_name, decided_at) VALUES (?, ?, 'blocked', ?, ?, ?, ?)",
  );
  for (const name of packages) insert.run(deviceId, name, by, parentId, by === "ai" ? "Claude" : null, t.now());
}

const madeUp = (n: number, from = 0, pad = "") => Array.from({ length: n }, (_, i) => `com.made.up${pad}.app${from + i}`);

describe("decisions about apps the phone never reported", () => {
  it("an AI app may add at most 50; apps on the phone can still be blocked", async () => {
    const { t, phone, ctx, claude, policy } = await family();
    for (const name of madeUp(LIMITS.maxPreBlocksByAi)) decideApp(ctx(), phone.deviceId, name, "blocked", claude);
    const more = () => decideApp(ctx(), phone.deviceId, "com.made.up.one.more", "blocked", claude);
    expect(more).toThrow(RuleRefused);
    expect(more).toThrow(/AI apps have already blocked 50 apps that aren't on this phone/);
    expect(currentDecision(t.deps.db, phone.deviceId, "com.made.up.one.more")).toBeNull();
    expect(policy().version).toBe(50);
    // An app the phone reported isn't one of them.
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude);
    expect(policy().apps.decisions).toContainEqual({ package: "com.example.chat", state: "blocked" });
  });

  it("parents and the CLI may have 500 in all; changing one already there is fine", async () => {
    const { t, sam, phone, ctx, parent, claude, policy } = await family();
    seedDecisions(t, phone.deviceId, madeUp(LIMITS.maxPreDecisions - 1), "parent", sam.parent.id);
    decideApp(ctx(), phone.deviceId, "com.made.up.last", "blocked", parent);
    expect(preDecisions(t.deps.db, phone.deviceId)).toHaveLength(500);
    expect(() => decideApp(ctx(), phone.deviceId, "com.made.up.too.many", "blocked", parent)).toThrow(/already has 500 apps blocked or allowed before they were installed/);
    expect(() => decideApp(ctx(), phone.deviceId, "com.made.up.too.many", "blocked", { kind: "server" })).toThrow(RuleRefused);
    expect(() => decideApp(ctx(), phone.deviceId, "com.made.up.too.many", "blocked", claude)).toThrow(RuleRefused);
    // Allowing one that's there, or clearing one, adds nothing.
    decideApp(ctx(), phone.deviceId, "com.made.up.last", "allowed", parent);
    decideApp(ctx(), phone.deviceId, "com.made.up.app0", "undecided", parent);
    expect(policy().apps.decisions).toHaveLength(499);
    decideApp(ctx(), phone.deviceId, "com.made.up.too.many", "blocked", parent);
    expect(policy().apps.decisions).toHaveLength(500);
  });

  it("the CLI says why it refused", async () => {
    const { t, sam, phone } = await family();
    seedDecisions(t, phone.deviceId, madeUp(LIMITS.maxPreDecisions), "parent", sam.parent.id);
    const out = await runCommandIn(t, "decide", "Sam's phone", "com.made.up.no.room", "block");
    expect(out.code).toBe(1);
    expect(out.err).toContain("already has 500 apps blocked or allowed before they were installed");
  });
});

describe("the policy's size", () => {
  it("a change that would make it larger than 256 KB is refused, and nothing of it is kept", async () => {
    const { t, phone, ctx, parent, policy, size } = await family();
    const sites = (prefix: string) => Array.from({ length: LIMITS.maxUrlPatterns }, (_, i) => `${prefix}${i}.example.org/${"x".repeat(470)}`);
    setWeb(ctx(), phone.deviceId, { chrome: { ...SAFE_CHROME, url_allowlist: sites("allow"), url_blocklist: sites("block") } }, parent);
    expect(size()).toBeGreaterThan(190 * 1024);
    const long = "a".repeat(200);
    let refused: unknown = null;
    let at = 0;
    for (; at < 400 && refused === null; at++) {
      try {
        decideApp(ctx(), phone.deviceId, `com.made.up.app${at}.${long}`, "blocked", parent);
      } catch (error) {
        refused = error;
      }
    }
    expect(refused).toBeInstanceOf(RuleRefused);
    expect((refused as Error).message).toBe(TOO_LARGE);
    expect(size()).toBeLessThanOrEqual(LIMITS.maxPolicyBytes);
    const version = policy().version;
    expect(currentDecision(t.deps.db, phone.deviceId, `com.made.up.app${at - 1}.${long}`)).toBeNull();
    expect(listAudit(t.deps.db, { limit: 1000, includeReads: false }).filter((e) => e.action === "app.blocked")).toHaveLength(version - 1);
    // Making it smaller always works.
    decideApp(ctx(), phone.deviceId, `com.made.up.app0.${long}`, "undecided", parent);
    expect(policy().version).toBe(version + 1);
  });

  it("a phone whose policy is already too large can still be cleaned up", async () => {
    const { t, sam, phone, ctx, parent, claude, policy, size } = await family();
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", parent);
    // What an AI app could do before there were limits: thousands of long made-up blocks.
    seedDecisions(t, phone.deviceId, madeUp(4000, 0, "a".repeat(230)), "ai", sam.parent.id);
    expect(size()).toBeGreaterThan(PHONE_MAX_POLICY_BYTES);
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.maps", "blocked", parent)).toThrow(TOO_LARGE);
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.maps", "blocked", claude)).toThrow(RuleRefused);
    const done = clearPreDecisions(ctx(), phone.deviceId, { byAi: true }, parent);
    expect(done.result.cleared).toHaveLength(4000);
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "blocked" }]);
    expect(size()).toBeLessThan(4096);
  });
});

describe("MCP batches", () => {
  async function connect() {
    const f = await family();
    const { token } = createPersonalToken(f.t.deps.db, f.t.now(), f.sam.parent.id, "Claude", MCP);
    const send = (messages: unknown) =>
      f.t.app.request(MCP, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
        body: typeof messages === "string" ? messages : JSON.stringify(messages),
      });
    return { ...f, send };
  }
  const ping = (id: number) => ({ jsonrpc: "2.0", id, method: "ping" });
  const block = (id: number, name: string) => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "block_app", arguments: { device: "Sam's phone", package: name } } });

  it("count every message toward the grant's limit, and can't carry more than 20", async () => {
    const { send } = await connect();
    const tooBig = await send(Array.from({ length: 21 }, (_, i) => ping(i)));
    expect(tooBig.status).toBe(400);
    expect(await tooBig.json()).toMatchObject({ error: { code: -32600, message: "Invalid Request: at most 20 messages in one batch" } });
    // 300 messages a minute: 14 more batches of 20 fit after the one refused above.
    for (let i = 0; i < 14; i++) expect((await send(Array.from({ length: 20 }, (_, j) => ping(j)))).status).toBe(200);
    const limited = await send(ping(1));
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("an AI app flooding blocks can't make a policy the phone refuses", async () => {
    const { t, phone, send, size } = await connect();
    const long = "a".repeat(200);
    let accepted = 0;
    let refusals = "";
    for (let batch = 0; batch < 5; batch++) {
      const res = await send(Array.from({ length: 20 }, (_, i) => block(batch * 20 + i, `x${batch * 20 + i}.${long}`)));
      expect(res.status).toBe(200);
      for (const r of (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } }[]) {
        if (r.result.isError) refusals = r.result.content[0]?.text ?? "";
        else accepted++;
      }
    }
    expect(accepted).toBe(LIMITS.maxPreBlocksByAi);
    expect(refusals).toContain(`A parent can clear them on the phone's page, under "Blocked before install"`);
    expect(size()).toBeLessThan(LIMITS.maxPolicyBytes);
    expect(preDecisions(t.deps.db, phone.deviceId)).toHaveLength(50);
  });

  it("a body that isn't JSON is refused as before, and still counts", async () => {
    const { send } = await connect();
    const res = await send("{not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: -32700 } });
  });
});

describe("the rate limiter", () => {
  it("counts several hits at once, all or none", () => {
    let now = 0;
    const limiter = new RateLimiter(5, 60_000, () => now);
    expect(limiter.hit("k", 3).ok).toBe(true);
    now += 10_000;
    expect(limiter.hit("k", 3)).toEqual({ ok: false, retryAfterSeconds: 50 });
    expect(limiter.hit("k", 2).ok).toBe(true);
    expect(limiter.check("k").ok).toBe(false);
    expect(limiter.hit("k", 6)).toEqual({ ok: false, retryAfterSeconds: 60 });
  });
});

describe("the phone's page", () => {
  it("lists apps blocked before install, and clears one, or all the AI apps' at once", async () => {
    const { t, sam, phone, ctx, parent, claude, policy } = await family();
    for (const name of ["com.made.up.one", "com.made.up.two", "com.made.up.three"]) decideApp(ctx(), phone.deviceId, name, "blocked", claude);
    decideApp(ctx(), phone.deviceId, "com.example.gone", "blocked", parent, { note: "Not until high school" });
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude);
    let html = await (await get(t, `/devices/${phone.deviceId}`, sam.cookie)).text();
    expect(html).toContain('<h3 id="before-install">Blocked before install</h3>');
    expect(html).toContain("Clear the ones AI apps added (3)");
    expect(html).toContain("blocked by Claude, through Sam&#39;s connection");
    expect(html).toContain("<blockquote>Not until high school</blockquote>");
    const listed = html.slice(html.indexOf('id="before-install"'));
    for (const name of ["com.made.up.one", "com.made.up.two", "com.made.up.three", "com.example.gone"]) expect(listed).toContain(name);
    expect(listed).not.toContain("com.example.chat");

    const send = (fields: Record<string, string>) => postForm(t, `/devices/${phone.deviceId}/before-install/clear`, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
    const all = await send({ ai: "1" });
    expect(all.headers.get("location")).toBe(`/devices/${phone.deviceId}?saved=cleared#before-install`);
    expect(policy().apps.decisions).toEqual([
      { package: "com.example.chat", state: "blocked" },
      { package: "com.example.gone", state: "blocked" },
    ]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "apps.pre_blocks_cleared", detail: { count: 3 } });
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("cleared 3 apps AI apps blocked before install (Sam&#39;s phone)");

    // One at a time: the decision goes, rather than staying as "allowed".
    await send({ package: "com.example.gone" });
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "blocked" }]);
    expect(decisionHistory(t.deps.db, phone.deviceId, "com.example.gone").map((d) => [d.state, d.decidedBy])).toEqual([
      ["undecided", "parent"],
      ["blocked", "parent"],
    ]);
    html = await (await get(t, `/devices/${phone.deviceId}`, sam.cookie)).text();
    expect(html).not.toContain("Blocked before install");
    // An app the phone reported isn't cleared this way.
    await send({ package: "com.example.chat" });
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "blocked" }]);
    expect((await send({ package: "not a package" })).status).toBe(400);
  });

  it("needs the session's CSRF token to clear them", async () => {
    const { t, sam, phone, ctx, claude, policy } = await family();
    decideApp(ctx(), phone.deviceId, "com.made.up.one", "blocked", claude);
    const path = `/devices/${phone.deviceId}/before-install/clear`;
    expect((await postForm(t, path, { ai: "1" }, { cookie: sam.cookie })).status).toBe(403);
    expect((await postForm(t, path, { ai: "1", _csrf: sam.csrf }, { cookie: sam.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(policy().apps.decisions).toHaveLength(1);
  });

  it("shows why a change was refused, and saves nothing", async () => {
    const { t, sam, phone, policy } = await family();
    seedDecisions(t, phone.deviceId, madeUp(LIMITS.maxPreDecisions), "parent", sam.parent.id);
    const version = policy().version;
    const res = await postForm(t, `/devices/${phone.deviceId}/decide`, { _csrf: sam.csrf, block: "com.made.up.no.room" }, { cookie: sam.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("already has 500 apps blocked or allowed before they were installed");
    expect(policy().version).toBe(version);
  });
});

async function runCommandIn(t: TestServer, ...argv: string[]) {
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
