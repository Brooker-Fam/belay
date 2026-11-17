/**
 * OAuth 2.1 for MCP clients: RFC 8414 and RFC 9728 metadata, Dynamic Client Registration,
 * the authorize page (the parent's sign-in, then a consent screen naming the app) and the
 * token endpoint. PKCE S256 only; tokens are bound to the MCP URL (RFC 8707).
 *
 * The flow follows Brooker-Fam/maple's src/app/oauth/{authorize,register,token}/route.ts and
 * src/app/.well-known/* (MIT License, Copyright (c) 2026 Matt Brooker; see NOTICE).
 */
import { type Context, Hono } from "hono";
import { cors } from "hono/cors";
import type { FC } from "hono/jsx";
import { audit } from "../audit.js";
import { checkPassword, createSession, loadSession } from "../auth/parents.js";
import { pkceChallenge, randomToken, safeEqual, sha256 } from "../crypto.js";
import type { Deps } from "../deps.js";
import { clientAddress, type Bindings } from "../http.js";
import { AI_SCOPES, getSettings } from "../settings.js";
import { Csrf, Layout, Notice, type View } from "../web/ui.js";
import { first, pageHeaders, render, sameOrigin, sessionCookie } from "../web/routes.js";
import type { Assets } from "../web/assets.js";
import { type ClientInfo, OAuthClientError, createClientResolver, registerClient, trustedRedirect } from "./clients.js";
import { CODE_TTL_MS, SCOPE, createGrant, exchangeRefreshToken, issueTokens } from "./store.js";

const PKCE = /^[A-Za-z0-9\-._~]{43,128}$/;

export function mcpUrl(publicUrl: string): string {
  return `${publicUrl}/mcp`;
}

export function resourceMetadataUrl(publicUrl: string): string {
  return `${publicUrl}/.well-known/oauth-protected-resource/mcp`;
}

/** "https://Belay.example.org/mcp/" and "…/mcp" are the same resource. */
export function canonicalResource(r: string): string {
  try {
    const u = new URL(r);
    return `${u.protocol}//${u.host.toLowerCase()}${u.pathname.replace(/\/+$/, "")}`;
  } catch {
    return r.replace(/\/+$/, "");
  }
}

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  response_type: string;
  state: string;
  code_challenge: string;
  code_challenge_method: string;
  resource: string;
  scope: string;
}

const PARAM_NAMES = ["client_id", "redirect_uri", "response_type", "state", "code_challenge", "code_challenge_method", "resource", "scope"] as const;

function readParams(get: (name: string) => string): AuthorizeParams {
  const p = Object.fromEntries(PARAM_NAMES.map((n) => [n, get(n).slice(0, 2000)])) as unknown as AuthorizeParams;
  return p;
}

const Hidden: FC<{ params: AuthorizeParams }> = ({ params }) => (
  <>
    {PARAM_NAMES.map((name) => (
      <input type="hidden" name={name} value={params[name]} />
    ))}
  </>
);

const ClientLine: FC<{ client: ClientInfo }> = ({ client }) =>
  client.verified ? (
    <>
      <strong>{client.name}</strong> <span class="muted">({client.returnHost})</span>
    </>
  ) : (
    <>
      an app that calls itself <strong>“{client.name}”</strong> <span class="muted">(it returns to {client.returnHost})</span>
    </>
  );

export function oauthRoutes(deps: Deps, assets: Assets): Hono<{ Bindings: Bindings }> {
  const { db, config } = deps;
  const app = new Hono<{ Bindings: Bindings }>();
  const resolver = createClientResolver({ db, fetch: deps.fetch, now: deps.now, extraRedirects: config.extraRedirectUris });
  const cookie = sessionCookie(deps);
  const resource = mcpUrl(config.publicUrl);
  const issuer = config.publicUrl;

  const publicCors = cors({ origin: "*", allowMethods: ["GET", "POST", "OPTIONS"], allowHeaders: ["Content-Type", "Authorization", "MCP-Protocol-Version"], maxAge: 86400 });

  // ── Metadata ───────────────────────────────────────────────────────

  const asMetadata = {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/oauth/token`,
    registration_endpoint: `${issuer}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: [SCOPE],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: true,
    service_documentation: "https://github.com/brooker-fam/belay/blob/main/docs/mcp.md",
  };
  const prMetadata = {
    resource,
    authorization_servers: [issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ["header"],
    resource_name: "Belay",
    resource_documentation: "https://github.com/brooker-fam/belay/blob/main/docs/mcp.md",
  };
  for (const path of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp"]) {
    app.use(path, publicCors);
    app.get(path, (c) => {
      c.header("Cache-Control", "public, max-age=3600");
      return c.json(asMetadata);
    });
  }
  for (const path of ["/.well-known/oauth-protected-resource/mcp", "/.well-known/oauth-protected-resource"]) {
    app.use(path, publicCors);
    app.get(path, (c) => {
      c.header("Cache-Control", "public, max-age=3600");
      return c.json(prMetadata);
    });
  }

  // ── Dynamic Client Registration ────────────────────────────────────

  app.use("/oauth/register", publicCors);
  app.post("/oauth/register", async (c) => {
    c.header("Cache-Control", "no-store");
    const verdict = deps.limits.registerPerClient.hit(clientAddress(c, config.trustProxy));
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return c.json({ error: "rate_limited", error_description: "Too many registrations" }, 429);
    }
    const text = await c.req.text();
    if (text.length > 16 * 1024) return c.json({ error: "invalid_client_metadata", error_description: "Too large" }, 400);
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid_client_metadata", error_description: "Send JSON" }, 400);
    }
    const result = registerClient(db, deps.now(), body, config.extraRedirectUris);
    if (!result.ok) return c.json({ error: result.error, error_description: result.description }, 400);
    return c.json(result.body, 201);
  });

  // ── Authorize: sign in, then consent ───────────────────────────────

  const view = (c: Context, csrf = ""): View => ({ parentName: null, csrf, tz: getSettings(db).timezone, now: deps.now(), path: c.req.path, assets: assets.urls });

  const errorPage = (c: Context, status: 400 | 403 | 503, title: string, text: string) =>
    render(
      c,
      <Layout view={view(c)} title={title} narrow>
        <h1>{title}</h1>
        <p>{text}</p>
      </Layout>,
      status,
    );

  const callback = (p: AuthorizeParams, values: Record<string, string>): string => {
    const to = new URL(p.redirect_uri);
    for (const [key, value] of Object.entries(values)) to.searchParams.set(key, value);
    if (p.state) to.searchParams.set("state", p.state);
    to.searchParams.set("iss", issuer);
    return to.toString();
  };
  const redirectTo = (c: Context, url: string) => {
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    return c.redirect(url, 302);
  };

  const scopeList = () => {
    const scopes = getSettings(db).aiScopes;
    return Object.entries(AI_SCOPES).filter(([k]) => scopes[k as keyof typeof AI_SCOPES]);
  };

  const signInPage = (c: Context, p: AuthorizeParams, client: ClientInfo, error?: string, status: 200 | 401 | 429 = 200) => {
    pageHeaders(c, `'self' ${new URL(p.redirect_uri).origin}`);
    return render(
      c,
      <Layout view={view(c)} title="Connect an AI app" narrow>
        <h1>Connect to Belay</h1>
        <p>
          Sign in to connect <ClientLine client={client} />.
        </p>
        {error && <Notice kind="error">{error}</Notice>}
        <form class="stack" method="post" action="/oauth/authorize">
          <Hidden params={p} />
          <label for="username">Username</label>
          <input id="username" type="text" name="username" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck={false} required />
          <label for="password">Password</label>
          <input id="password" type="password" name="password" autocomplete="current-password" required />
          <button type="submit">Sign in</button>
        </form>
      </Layout>,
      status,
    );
  };

  const consentPage = (c: Context, p: AuthorizeParams, client: ClientInfo, parentName: string, csrf: string) => {
    pageHeaders(c, `'self' ${new URL(p.redirect_uri).origin}`);
    const scopes = scopeList();
    return render(
      c,
      <Layout view={view(c, csrf)} title="Connect an AI app" narrow>
        <h1>Connect to Belay?</h1>
        <p>
          <ClientLine client={client} /> wants to connect to your family's Belay as {parentName}.
        </p>
        <div class="card">
          <p>It will be able to:</p>
          <ul>
            {scopes.length ? (
              scopes.map(([, label]) => <li>Read {label.charAt(0).toLowerCase() + label.slice(1)}</li>)
            ) : (
              <li>See only the phones' names: you turned off AI access to app data and device status in Settings.</li>
            )}
            <li>Mark apps as reviewed, with a note, in your name.</li>
            <li>Block an app or pause a phone at once, in your name.</li>
            <li>Propose loosening a rule, like allowing an app. Nothing loosens until a parent approves it on the parent page.</li>
          </ul>
          <p class="muted small">
            It can't answer your kid's requests, or change factory reset, debugging or maintenance mode. What it reads goes to the app's provider.
            You can disconnect it any time in Settings, and the Activity page shows what it did.
          </p>
        </div>
        <form method="post" action="/oauth/authorize" class="row">
          <Hidden params={p} />
          <Csrf view={view(c, csrf)} />
          <button type="submit" name="decision" value="approve">
            Connect
          </button>
          <button type="submit" name="decision" value="deny" class="quiet">
            Cancel
          </button>
        </form>
        <p class="muted small">After this you go back to {client.returnHost}.</p>
      </Layout>,
    );
  };

  const authorize = async (c: Context<{ Bindings: Bindings }>, p: AuthorizeParams, form: Record<string, string | File | (string | File)[]> | null) => {
    if (!p.client_id || !p.redirect_uri) {
      return errorPage(c, 400, "Something's missing", "This link is missing the app's details. Start connecting again from the app.");
    }
    let client: ClientInfo;
    try {
      client = await resolver.resolve(p.client_id, p.redirect_uri);
    } catch (error) {
      if (error instanceof OAuthClientError && error.code === "unavailable") {
        return errorPage(c, 503, "Couldn't check the app", "The app's details couldn't be loaded. Try connecting again in a minute.");
      }
      return errorPage(c, 400, "Couldn't verify the app", "The app's identity or return address isn't one Belay accepts. Start a new connection from the app.");
    }
    // From here on, errors go back to the app.
    if (p.response_type !== "code") return redirectTo(c, callback(p, { error: "unsupported_response_type", error_description: "Only response_type=code" }));
    if (p.code_challenge_method !== "S256" || !PKCE.test(p.code_challenge)) {
      return redirectTo(c, callback(p, { error: "invalid_request", error_description: "PKCE with code_challenge_method=S256 is required" }));
    }
    if (p.resource && canonicalResource(p.resource) !== canonicalResource(resource)) {
      return redirectTo(c, callback(p, { error: "invalid_target", error_description: `resource must be ${resource}` }));
    }

    let session = loadSession(db, cookie.get(c), deps.now());
    if (form && c.req.method === "POST") {
      if (!sameOrigin(c, config.publicUrl)) return errorPage(c, 403, "That didn't come from here", "For safety, approve the connection on this page.");
      const decision = first(form, "decision");
      if (decision) {
        if (!session) return signInPage(c, p, client, "Sign in again to approve.");
        if (!safeEqual(first(form, "_csrf"), session.csrf)) return consentPage(c, p, client, session.parent.name, session.csrf);
        if (decision !== "approve") return redirectTo(c, callback(p, { error: "access_denied", error_description: "The parent didn't approve the connection" }));
        const code = randomToken(32);
        const now = deps.now();
        db.prepare(
          `INSERT INTO oauth_codes (code_hash, client_id, client_name, redirect_uri, code_challenge, resource, scope, parent_id, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(sha256(code), client.clientId, client.name, p.redirect_uri, p.code_challenge, resource, SCOPE, session.parent.id, now, now + CODE_TTL_MS);
        return redirectTo(c, callback(p, { code }));
      }
      if (typeof form.username === "string") {
        const ip = clientAddress(c, config.trustProxy);
        const username = first(form, "username");
        const password = typeof form.password === "string" ? form.password : "";
        const limited = [deps.limits.loginPerClient.check(ip), deps.limits.loginPerUser.check(username.toLowerCase())].some((v) => !v.ok);
        if (limited) return signInPage(c, p, client, "Too many tries. Wait 15 minutes, then try again.", 429);
        const parent = await checkPassword(db, username, password);
        if (!parent) {
          deps.limits.loginPerClient.hit(ip);
          deps.limits.loginPerUser.hit(username.toLowerCase());
          return signInPage(c, p, client, "That username and password don't match.", 401);
        }
        const made = createSession(db, deps.now(), parent.id);
        cookie.set(c, made.cookie);
        audit(db, deps.now(), { kind: "parent", parentId: parent.id }, "parent.signed_in");
        session = { parent, csrf: made.csrf, idHash: sha256(made.cookie) };
      }
    }
    if (!session) return signInPage(c, p, client);
    return consentPage(c, p, client, session.parent.name, session.csrf);
  };

  app.get("/oauth/authorize", (c) => authorize(c, readParams((n) => c.req.query(n) ?? ""), null));
  app.post("/oauth/authorize", async (c) => {
    const form = await c.req.parseBody({ all: true });
    return authorize(c, readParams((n) => first(form, n)), form);
  });

  // ── Token ──────────────────────────────────────────────────────────

  app.use("/oauth/token", publicCors);
  app.post("/oauth/token", async (c) => {
    c.header("Cache-Control", "no-store");
    c.header("Pragma", "no-cache");
    const fail = (error: string, description: string, status: 400 | 401 | 429 = 400) => c.json({ error, error_description: description }, status);
    const verdict = deps.limits.tokenPerClient.hit(clientAddress(c, config.trustProxy));
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return fail("rate_limited", "Too many requests", 429);
    }
    const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
    const text = await c.req.text();
    if (text.length > 16 * 1024) return fail("invalid_request", "Too large");
    let params: URLSearchParams;
    if (type === "application/json") {
      try {
        const json = JSON.parse(text) as unknown;
        if (!json || typeof json !== "object") return fail("invalid_request", "Send form fields");
        params = new URLSearchParams(Object.entries(json).filter((e): e is [string, string] => typeof e[1] === "string"));
      } catch {
        return fail("invalid_request", "Send form fields");
      }
    } else {
      params = new URLSearchParams(text);
    }
    if (c.req.header("authorization")?.trim() || params.has("client_assertion") || params.getAll("client_secret").some((s) => s !== "")) {
      return fail("invalid_client", "This server only takes public clients, without a secret", 401);
    }
    const now = deps.now();
    const grantType = params.get("grant_type");

    if (grantType === "refresh_token") {
      const token = params.get("refresh_token");
      if (!token) return fail("invalid_request", "refresh_token is required");
      const asked = params.get("resource");
      if (asked && canonicalResource(asked) !== canonicalResource(resource)) return fail("invalid_target", `resource must be ${resource}`);
      const result = exchangeRefreshToken(db, token, now, params.get("client_id"));
      if (!result.ok) {
        if (result.reused) deps.log("A refresh token was used twice: its connection was revoked.");
        return fail("invalid_grant", "The refresh token is invalid, expired or revoked");
      }
      return c.json(result.tokens);
    }
    if (grantType !== "authorization_code") return fail("unsupported_grant_type", "Use authorization_code or refresh_token");

    const code = params.get("code");
    const redirectUri = params.get("redirect_uri");
    const clientId = params.get("client_id");
    const verifier = params.get("code_verifier");
    if (!code || !redirectUri || !clientId || !verifier) return fail("invalid_request", "code, redirect_uri, client_id and code_verifier are required");
    if (!PKCE.test(verifier)) return fail("invalid_grant", "The code_verifier isn't valid");

    return db.transaction(() => {
      const row = db
        .prepare<
          [string],
          {
            client_id: string;
            client_name: string;
            redirect_uri: string;
            code_challenge: string;
            resource: string;
            parent_id: string;
            expires_at: number;
            used_at: number | null;
            grant_id: string | null;
          }
        >("SELECT client_id, client_name, redirect_uri, code_challenge, resource, parent_id, expires_at, used_at, grant_id FROM oauth_codes WHERE code_hash = ?")
        .get(sha256(code));
      if (!row || row.expires_at <= now) return fail("invalid_grant", "The code is invalid or expired");
      if (row.used_at !== null) {
        // A code used twice was stolen or replayed: end what it started.
        if (row.grant_id) db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, row.grant_id);
        if (row.grant_id) db.prepare("DELETE FROM access_tokens WHERE grant_id = ?").run(row.grant_id);
        return fail("invalid_grant", "The code was already used");
      }
      if (row.client_id !== clientId) return fail("invalid_grant", "client_id doesn't match");
      if (row.redirect_uri !== redirectUri) return fail("invalid_grant", "redirect_uri doesn't match");
      if (!safeEqual(pkceChallenge(verifier), row.code_challenge)) return fail("invalid_grant", "PKCE verification failed");
      const asked = params.get("resource");
      if (asked && canonicalResource(asked) !== canonicalResource(row.resource)) return fail("invalid_target", "resource doesn't match the authorization");

      const refreshAllowed = trustedRedirect(row.redirect_uri);
      const grantId = createGrant(db, now, {
        kind: "oauth",
        parentId: row.parent_id,
        clientId: row.client_id,
        clientName: row.client_name,
        clientHost: URL.canParse(row.redirect_uri) ? new URL(row.redirect_uri).host : null,
        redirectUri: row.redirect_uri,
        resource: row.resource,
        refreshAllowed,
      });
      db.prepare("UPDATE oauth_codes SET used_at = ?, grant_id = ? WHERE code_hash = ?").run(now, grantId, sha256(code));
      audit(db, now, { kind: "parent", parentId: row.parent_id }, "ai.connected", { detail: { client: row.client_name } });
      return c.json(issueTokens(db, now, { id: grantId, refreshAllowed, scope: SCOPE }));
    }).immediate();
  });

  return app;
}
