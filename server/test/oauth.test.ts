import { describe, expect, it, vi } from "vitest";
import { createParent, createSession } from "../src/auth/parents.js";
import { pkceChallenge } from "../src/crypto.js";
import { listGrants } from "../src/oauth/store.js";
import { testServer, type TestServer } from "./helpers.js";

const ORIGIN = "https://belay.example.org";
const MCP = `${ORIGIN}/mcp`;
const CLAUDE_METADATA = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(20) + "-._~" + "w".repeat(30);
const PASSWORD = "correct horse battery staple";

function claudeMetadata(overrides: Record<string, unknown> = {}) {
  return {
    client_id: CLAUDE_METADATA,
    client_name: "Claude",
    redirect_uris: [CLAUDE_CALLBACK],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    ...overrides,
  };
}

function metadataFetch(body: unknown = claudeMetadata(), init: ResponseInit = { headers: { "content-type": "application/json", "cache-control": "max-age=300" } }) {
  return vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    if (href !== CLAUDE_METADATA) throw new Error(`unexpected fetch of ${href}`);
    return Promise.resolve(new Response(JSON.stringify(body), init));
  });
}

async function family(opts: Parameters<typeof testServer>[0] = {}) {
  const t = testServer({ fetch: metadataFetch(), ...opts });
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: PASSWORD });
  const session = createSession(t.deps.db, t.now(), parent.id);
  return { t, parent, cookie: `__Host-belay=${session.cookie}`, csrf: session.csrf };
}

function authorizeParams(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    client_id: CLAUDE_METADATA,
    redirect_uri: CLAUDE_CALLBACK,
    response_type: "code",
    state: "state-123",
    code_challenge: pkceChallenge(VERIFIER),
    code_challenge_method: "S256",
    resource: MCP,
    scope: "belay",
    ...overrides,
  };
}

function form(t: TestServer, path: string, fields: Record<string, string>, cookie?: string, headers: Record<string, string> = {}) {
  return t.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", origin: ORIGIN, "x-forwarded-for": "203.0.113.5", ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(fields),
  });
}

/** Approves a connection on the consent page and returns the redirect back to the app. */
async function approve(t: TestServer, cookie: string, csrf: string, params = authorizeParams()) {
  const res = await form(t, "/oauth/authorize", { ...params, _csrf: csrf, decision: "approve" }, cookie);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") ?? "");
}

function token(t: TestServer, fields: Record<string, string>, headers: Record<string, string> = {}) {
  return form(t, "/oauth/token", fields, undefined, headers);
}

async function connect(t: TestServer, cookie: string, csrf: string) {
  const back = await approve(t, cookie, csrf);
  const res = await token(t, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: CLAUDE_CALLBACK, client_id: CLAUDE_METADATA, code_verifier: VERIFIER, resource: MCP });
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number; token_type: string; scope: string };
}

function initialize(t: TestServer, accessToken?: string) {
  return t.app.request("/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
  });
}

describe("discovery", () => {
  it("publishes RFC 8414 and RFC 9728 metadata", async () => {
    const { t } = await family();
    const as = (await (await t.app.request("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: ORIGIN,
      authorization_endpoint: `${ORIGIN}/oauth/authorize`,
      token_endpoint: `${ORIGIN}/oauth/token`,
      registration_endpoint: `${ORIGIN}/oauth/register`,
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    const pr = await t.app.request("/.well-known/oauth-protected-resource/mcp");
    expect(pr.headers.get("access-control-allow-origin")).toBe("*");
    expect(await pr.json()).toMatchObject({ resource: MCP, authorization_servers: [ORIGIN] });
  });

  it("answers an MCP request without a token with 401 pointing at the metadata", async () => {
    const { t } = await family();
    const res = await initialize(t);
    expect(res.status).toBe(401);
    const challenge = res.headers.get("www-authenticate") ?? "";
    expect(challenge).toContain(`resource_metadata="${ORIGIN}/.well-known/oauth-protected-resource/mcp"`);
    expect(challenge).not.toContain("error=");
    expect((await initialize(t, "belay_at_wrong")).headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
});

describe("authorize", () => {
  it("asks a signed-out parent to sign in, naming the app from its metadata document", async () => {
    const { t } = await family();
    const page = await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams()).toString()}`);
    expect(page.status).toBe(200);
    const body = await page.text();
    expect(body).toContain("Sign in to connect");
    expect(body).toContain("<strong>Claude</strong>");
    expect(page.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai");
    expect(page.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
  });

  it("signs in on the same page, then shows the consent screen", async () => {
    const { t } = await family();
    const res = await form(t, "/oauth/authorize", { ...authorizeParams(), username: "sam", password: PASSWORD });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connect to Belay?");
    expect(res.headers.get("set-cookie")).toContain("__Host-belay=");
    const wrong = await form(t, "/oauth/authorize", { ...authorizeParams(), username: "sam", password: "not the password at all" });
    expect(wrong.status).toBe(401);
  });

  it("returns a code with the state and the issuer", async () => {
    const { t, cookie, csrf } = await family();
    const back = await approve(t, cookie, csrf);
    expect(`${back.origin}${back.pathname}`).toBe(CLAUDE_CALLBACK);
    expect(back.searchParams.get("code")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(back.searchParams.get("state")).toBe("state-123");
    expect(back.searchParams.get("iss")).toBe(ORIGIN);
  });

  it("needs the session's CSRF token and a same-origin form to approve", async () => {
    const { t, cookie } = await family();
    const res = await form(t, "/oauth/authorize", { ...authorizeParams(), _csrf: "x".repeat(43), decision: "approve" }, cookie);
    expect(res.status).toBe(200);
    expect(res.headers.get("location")).toBeNull();
    const cross = await form(t, "/oauth/authorize", { ...authorizeParams(), decision: "approve" }, cookie, { origin: "https://evil.example" });
    expect(cross.status).toBe(403);
  });

  it("sends a denial back to the app", async () => {
    const { t, cookie, csrf } = await family();
    const res = await form(t, "/oauth/authorize", { ...authorizeParams(), _csrf: csrf, decision: "deny" }, cookie);
    expect(new URL(res.headers.get("location") ?? "").searchParams.get("error")).toBe("access_denied");
  });

  it("requires PKCE with S256", async () => {
    const { t, cookie, csrf } = await family();
    const bads: Record<string, string>[] = [{ code_challenge_method: "plain" }, { code_challenge: "" }, { code_challenge: "short" }];
    for (const bad of bads) {
      const back = await approve(t, cookie, csrf, authorizeParams(bad));
      expect(back.searchParams.get("error")).toBe("invalid_request");
      expect(back.searchParams.get("code")).toBeNull();
    }
  });

  it("binds the code to this server's MCP URL (RFC 8707)", async () => {
    const { t, cookie, csrf } = await family();
    const back = await approve(t, cookie, csrf, authorizeParams({ resource: "https://other.example/mcp" }));
    expect(back.searchParams.get("error")).toBe("invalid_target");
    const ok = await approve(t, cookie, csrf, authorizeParams({ resource: "https://BELAY.example.org/mcp/" }));
    expect(ok.searchParams.get("code")).toBeTruthy();
  });

  it("only returns to allowlisted redirects", async () => {
    const { t } = await family();
    const evil = await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams({ client_id: "some-client", redirect_uri: "https://evil.example/cb" })).toString()}`);
    expect(evil.status).toBe(400);
    // Claude's metadata document doesn't list this redirect.
    const notListed = await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams({ redirect_uri: "http://localhost:3333/callback" })).toString()}`);
    expect(notListed.status).toBe(400);
    // Belay fetches no other metadata documents.
    const otherDoc = await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams({ client_id: "https://evil.example/client.json" })).toString()}`);
    expect(otherDoc.status).toBe(400);
  });
});

describe("client metadata documents", () => {
  it("are fetched once, cached, and checked", async () => {
    const fetcher = metadataFetch();
    const { t } = await family({ fetch: fetcher });
    const url = `/oauth/authorize?${new URLSearchParams(authorizeParams()).toString()}`;
    await t.app.request(url);
    await t.app.request(url);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: "error", credentials: "omit" });
  });

  it("must name themselves and be JSON", async () => {
    for (const bad of [
      metadataFetch(claudeMetadata({ client_id: "https://claude.ai/other" })),
      metadataFetch(claudeMetadata({ token_endpoint_auth_method: "client_secret_basic" })),
      metadataFetch(claudeMetadata(), { headers: { "content-type": "text/html" } }),
      metadataFetch({ ...claudeMetadata(), padding: "x".repeat(6000) }),
    ]) {
      const { t } = await family({ fetch: bad });
      expect((await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams()).toString()}`)).status).toBe(400);
    }
  });

  it("that can't be loaded give a try-again page", async () => {
    const { t } = await family({ fetch: vi.fn(() => Promise.reject(new Error("offline"))) });
    expect((await t.app.request(`/oauth/authorize?${new URLSearchParams(authorizeParams()).toString()}`)).status).toBe(503);
  });
});

describe("dynamic client registration", () => {
  it("registers a client with a loopback redirect, and refuses others", async () => {
    const { t, cookie, csrf } = await family();
    const reg = (body: unknown) => t.app.request("/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const bad = await reg({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"] });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: "invalid_redirect_uri" });

    const res = await reg({ client_name: "Inspector‮", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" });
    expect(res.status).toBe(201);
    const client = (await res.json()) as { client_id: string; client_name: string };
    expect(client.client_name).toBe("Inspector");

    // Any loopback port, same path.
    const params = authorizeParams({ client_id: client.client_id, redirect_uri: "http://localhost:51234/oauth/callback" });
    const page = await t.app.request(`/oauth/authorize?${new URLSearchParams(params).toString()}`, { headers: { cookie } });
    expect(await page.text()).toContain("an app that calls itself");
    const back = await approve(t, cookie, csrf, params);
    const exchanged = await token(t, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: params.redirect_uri ?? "", client_id: client.client_id, code_verifier: VERIFIER });
    const tokens = (await exchanged.json()) as { refresh_token?: string };
    expect(tokens.refresh_token).toMatch(/^belay_rt_/);
  });
});

describe("token endpoint", () => {
  it("exchanges a code once, checking PKCE, client and redirect", async () => {
    const { t, cookie, csrf } = await family();
    const back = await approve(t, cookie, csrf);
    const code = back.searchParams.get("code") ?? "";
    const base = { grant_type: "authorization_code", code, redirect_uri: CLAUDE_CALLBACK, client_id: CLAUDE_METADATA, code_verifier: VERIFIER };
    expect(await (await token(t, { ...base, code_verifier: "x".repeat(43) })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await token(t, { ...base, client_id: "someone-else" })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await token(t, { ...base, redirect_uri: "https://claude.com/api/mcp/auth_callback" })).json()).toMatchObject({ error: "invalid_grant" });
    expect(await (await token(t, { ...base, resource: "https://other.example/mcp" })).json()).toMatchObject({ error: "invalid_target" });

    const ok = await token(t, base);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const tokens = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.expires_in).toBe(3600);
    expect(tokens.access_token).toMatch(/^belay_at_[A-Za-z0-9_-]{43}$/);
    expect((await initialize(t, tokens.access_token)).status).toBe(200);

    // A second use of the code means it leaked: what it started is revoked.
    expect(await (await token(t, base)).json()).toMatchObject({ error: "invalid_grant" });
    expect((await initialize(t, tokens.access_token)).status).toBe(401);
  });

  it("expires codes after 10 minutes", async () => {
    const { t, cookie, csrf } = await family();
    const back = await approve(t, cookie, csrf);
    t.advance(10 * 60_000);
    const res = await token(t, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: CLAUDE_CALLBACK, client_id: CLAUDE_METADATA, code_verifier: VERIFIER });
    expect(await res.json()).toMatchObject({ error: "invalid_grant" });
  });

  it("refuses client secrets: Belay's clients are public", async () => {
    const { t } = await family();
    const res = await token(t, { grant_type: "authorization_code", code: "x", client_secret: "s" });
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: "invalid_client" });
    expect((await token(t, { grant_type: "authorization_code" }, { authorization: "Basic eDp5" })).status).toBe(401);
  });

  it("rotates refresh tokens, and revokes the connection when one is reused", async () => {
    const { t, cookie, csrf } = await family();
    const first = await connect(t, cookie, csrf);
    t.advance(3_600_000);
    expect((await initialize(t, first.access_token)).status).toBe(401);
    const refreshed = await token(t, { grant_type: "refresh_token", refresh_token: first.refresh_token ?? "", client_id: CLAUDE_METADATA, resource: MCP });
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect((await initialize(t, second.access_token)).status).toBe(200);

    const replay = await token(t, { grant_type: "refresh_token", refresh_token: first.refresh_token ?? "" });
    expect(await replay.json()).toMatchObject({ error: "invalid_grant" });
    expect((await initialize(t, second.access_token)).status).toBe(401);
    expect(listGrants(t.deps.db)).toHaveLength(0);
  });

  it("gives no refresh token to a redirect outside the built-in allowlist", async () => {
    const extra = "https://assistant.example/callback";
    const t = testServer({ config: { extraRedirectUris: [extra] } });
    const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: PASSWORD });
    const session = createSession(t.deps.db, t.now(), parent.id);
    const cookie = `__Host-belay=${session.cookie}`;
    const params = authorizeParams({ client_id: "assistant", redirect_uri: extra });
    const back = await approve(t, cookie, session.csrf, params);
    const res = await token(t, { grant_type: "authorization_code", code: back.searchParams.get("code") ?? "", redirect_uri: extra, client_id: "assistant", code_verifier: VERIFIER });
    const tokens = (await res.json()) as { refresh_token?: string; expires_in: number };
    expect(tokens.refresh_token).toBeUndefined();
    expect(tokens.expires_in).toBe(24 * 3600);
  });
});

describe("AI access in Settings", () => {
  it("lists the connection, and disconnecting it stops its tokens", async () => {
    const { t, cookie, csrf } = await family();
    const tokens = await connect(t, cookie, csrf);
    const settings = await (await t.app.request("/settings", { headers: { cookie } })).text();
    expect(settings).toContain("<strong>Claude</strong>");
    const grant = listGrants(t.deps.db)[0];
    await form(t, `/settings/ai/${grant?.id ?? ""}/revoke`, { _csrf: csrf }, cookie);
    expect((await initialize(t, tokens.access_token)).status).toBe(401);
    expect(await (await token(t, { grant_type: "refresh_token", refresh_token: tokens.refresh_token ?? "" })).json()).toMatchObject({ error: "invalid_grant" });
  });

  it("makes personal access tokens, shown once and revocable", async () => {
    const { t, cookie, csrf } = await family();
    const page = await (await form(t, "/settings/tokens", { _csrf: csrf, name: "Claude Code" }, cookie)).text();
    const pat = /belay_pat_[A-Za-z0-9_-]{43}/.exec(page)?.[0] ?? "";
    expect(page).toContain(`claude mcp add --transport http belay ${MCP} --header &quot;Authorization: Bearer ${pat}&quot;`);
    expect((await initialize(t, pat)).status).toBe(200);
    const grant = listGrants(t.deps.db)[0];
    await form(t, `/settings/ai/${grant?.id ?? ""}/revoke`, { _csrf: csrf }, cookie);
    expect((await initialize(t, pat)).status).toBe(401);
  });
});
