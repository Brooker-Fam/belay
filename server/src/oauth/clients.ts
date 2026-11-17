/**
 * Which app is asking to connect, and where it may send the parent back to.
 *
 * Adapted from Brooker-Fam/maple, src/lib/mcp/clients.ts and src/lib/mcp/auth.ts
 * (MIT License, Copyright (c) 2026 Matt Brooker; see NOTICE): the Client ID Metadata
 * Document allowlist and checks, the cache rules, and loopback redirect matching.
 * Belay adds registered clients (RFC 7591) kept in its database.
 */
import { newId } from "../crypto.js";
import type { DB } from "../db.js";

/**
 * Client ID Metadata Documents the server will read. It never fetches any other URL, so a
 * client_id can't make it request something on the family's network.
 */
export const METADATA_URLS = new Set(["https://claude.ai/oauth/mcp-oauth-client-metadata", "https://claude.ai/oauth/claude-code-client-metadata"]);

/** Claude's callbacks: trusted with refresh tokens. */
export const CLAUDE_CALLBACKS = new Set(["https://claude.ai/api/mcp/auth_callback", "https://claude.com/api/mcp/auth_callback"]);

const MAX_METADATA_BYTES = 5 * 1024;
const MAX_CACHE_SECONDS = 300;
const LOOPBACK_URI = /^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(\/[^#]*)?$/;

export class OAuthClientError extends Error {
  constructor(readonly code: "invalid_client" | "invalid_redirect" | "unavailable") {
    super(code);
    this.name = "OAuthClientError";
  }
}

export interface ClientInfo {
  clientId: string;
  /** What the consent screen calls the app. */
  name: string;
  /** Verified from a metadata document Belay fetched itself; otherwise the name is the app's own claim. */
  verified: boolean;
  /** Where the parent is sent back to, shown on the consent screen. */
  returnHost: string;
  /** Only Claude's callbacks and apps on the parent's own computer get refresh tokens. */
  refreshAllowed: boolean;
}

export function isLoopback(uri: string): boolean {
  return LOOPBACK_URI.test(uri);
}

/** A redirect Belay trusts with long-lived grants: Claude's callback, or an app on this computer (Claude Code). */
export function trustedRedirect(uri: string): boolean {
  return CLAUDE_CALLBACKS.has(uri) || isLoopback(uri);
}

/** Every redirect Belay allows: the trusted ones, plus any the server's owner listed (BELAY_EXTRA_REDIRECT_URIS). */
export function allowedRedirect(uri: string, extra: readonly string[]): boolean {
  return trustedRedirect(uri) || extra.includes(uri);
}

/** Registered and requested redirects match exactly, or are both loopback with the same host and path (any port). */
export function matchesRedirect(registered: string, requested: string): boolean {
  if (registered === requested) return true;
  const allowed = LOOPBACK_URI.exec(registered);
  const actual = LOOPBACK_URI.exec(requested);
  return !!allowed && !!actual && allowed[1] === actual[1] && (allowed[2] ?? "") === (actual[2] ?? "");
}

function validRedirect(uri: unknown): uri is string {
  if (typeof uri !== "string" || uri.includes("#") || uri.length > 2000) return false;
  try {
    const parsed = new URL(uri);
    if (parsed.username || parsed.password) return false;
    return parsed.protocol === "https:" || (parsed.protocol === "http:" && isLoopback(uri));
  } catch {
    return false;
  }
}

function isUrlClientId(clientId: string): boolean {
  return /^[a-z][a-z\d+.-]*:/i.test(clientId.trim()) || clientId.trim().startsWith("//");
}

function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return uri.slice(0, 80);
  }
}

/** Strips control characters and caps the length of a name an app chose for itself. */
export function cleanName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  // eslint-disable-next-line no-control-regex
  const name = value.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "").trim();
  return name ? name.slice(0, 60) : fallback;
}

// ── Client ID Metadata Documents ────────────────────────────────────────

interface Metadata {
  name: string;
  redirects: string[];
}

function includesCapability(value: unknown, required: string): boolean {
  return value === undefined || (Array.isArray(value) && value.includes(required) && value.every((item) => typeof item === "string" && item.trim().length > 0));
}

function supportsPublicAuthentication(data: Record<string, unknown>): boolean {
  const methods = data.token_endpoint_auth_methods_supported;
  if (methods === undefined) return data.token_endpoint_auth_method === undefined || data.token_endpoint_auth_method === "none";
  return Array.isArray(methods) && methods.includes("none") && methods.every((m) => typeof m === "string" && m.trim().length > 0);
}

function validateMetadata(value: unknown, clientId: string): Metadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new OAuthClientError("invalid_client");
  const data = value as Record<string, unknown>;
  const redirects = data.redirect_uris;
  if (data.client_id !== clientId || !Array.isArray(redirects) || !redirects.length || !redirects.every(validRedirect)) {
    throw new OAuthClientError("invalid_client");
  }
  if (!supportsPublicAuthentication(data)) throw new OAuthClientError("invalid_client");
  if (!includesCapability(data.grant_types, "authorization_code") || !includesCapability(data.response_types, "code")) {
    throw new OAuthClientError("invalid_client");
  }
  const host = new URL(clientId).host;
  if (data.client_name !== undefined && (typeof data.client_name !== "string" || !data.client_name.trim() || data.client_name.length > 200)) {
    throw new OAuthClientError("invalid_client");
  }
  return { name: cleanName(data.client_name, host), redirects };
}

function cacheSeconds(headers: Headers): number {
  const directives = (headers.get("cache-control") ?? "")
    .toLowerCase()
    .split(",")
    .map((v) => v.trim());
  if (directives.some((v) => /^(no-store|no-cache)(?:\s*=|$)/.test(v))) return 0;
  const ages = directives.filter((v) => /^max-age\s*=/.test(v));
  if (ages.length > 1) return 0;
  const maxAge = ages[0];
  const match = maxAge ? /^max-age\s*=\s*(?:"(\d+)"|(\d+))$/.exec(maxAge) : null;
  const seconds = match?.[1] ?? match?.[2];
  if (maxAge && seconds === undefined) return 0;
  const age = Number(headers.get("age") ?? 0);
  if (!Number.isFinite(age) || age < 0) return 0;
  return Math.max(0, Math.min(Number(seconds ?? MAX_CACHE_SECONDS), MAX_CACHE_SECONDS) - age);
}

async function readDocument(response: Response): Promise<unknown> {
  const isJson = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
  if (!isJson || Number(response.headers.get("content-length")) > MAX_METADATA_BYTES || !response.body) {
    void response.body?.cancel().catch(() => undefined);
    throw new OAuthClientError("invalid_client");
  }
  const reader = response.body.getReader();
  const bytes = new Uint8Array(MAX_METADATA_BYTES);
  let size = 0;
  try {
    for (;;) {
      const chunk = (await reader.read()) as { done: boolean; value: Uint8Array | undefined };
      const value = chunk.value;
      if (chunk.done || !value) break;
      if (size + value.byteLength > MAX_METADATA_BYTES) throw new OAuthClientError("invalid_client");
      bytes.set(value, size);
      size += value.byteLength;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)));
  } catch {
    throw new OAuthClientError("invalid_client");
  }
}

async function fetchMetadata(clientId: string, fetcher: typeof fetch, timeoutMs: number): Promise<{ metadata: Metadata; seconds: number }> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new OAuthClientError("unavailable"));
      controller.abort();
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      timeout,
      (async () => {
        const response = await fetcher(clientId, {
          headers: { accept: "application/json" },
          credentials: "omit",
          redirect: "error",
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) {
          void response.body?.cancel().catch(() => undefined);
          throw new OAuthClientError("unavailable");
        }
        return { metadata: validateMetadata(await readDocument(response), clientId), seconds: cacheSeconds(response.headers) };
      })(),
    ]);
  } catch (error) {
    if (error instanceof OAuthClientError) throw error;
    throw new OAuthClientError("unavailable");
  } finally {
    clearTimeout(timer);
  }
}

// ── Resolving a client ──────────────────────────────────────────────────

export interface ClientResolver {
  resolve(clientId: string, redirectUri: string): Promise<ClientInfo>;
}

export function createClientResolver(opts: { db: DB; fetch: typeof fetch; now: () => number; extraRedirects: readonly string[]; timeoutMs?: number }): ClientResolver {
  const cache = new Map<string, { metadata: Metadata; expiresAt: number }>();

  const legacyName = (redirectUri: string): string => {
    if (CLAUDE_CALLBACKS.has(redirectUri)) return "Claude";
    if (isLoopback(redirectUri)) return "an app on your computer";
    return hostOf(redirectUri);
  };

  return {
    async resolve(clientId, redirectUri) {
      if (!clientId.trim() || clientId.length > 500) throw new OAuthClientError("invalid_client");
      if (!validRedirect(redirectUri) || !allowedRedirect(redirectUri, opts.extraRedirects)) throw new OAuthClientError("invalid_redirect");
      const base = { clientId, returnHost: hostOf(redirectUri), refreshAllowed: trustedRedirect(redirectUri) };

      if (METADATA_URLS.has(clientId)) {
        let cached = cache.get(clientId);
        if (!cached || cached.expiresAt <= opts.now()) {
          cache.delete(clientId);
          const { metadata, seconds } = await fetchMetadata(clientId, opts.fetch, opts.timeoutMs ?? 5_000);
          cached = { metadata, expiresAt: opts.now() + seconds * 1000 };
          if (seconds > 0) cache.set(clientId, cached);
        }
        if (!cached.metadata.redirects.some((registered) => matchesRedirect(registered, redirectUri))) throw new OAuthClientError("invalid_redirect");
        return { ...base, name: cached.metadata.name, verified: true };
      }
      // Belay reads no other metadata documents.
      if (isUrlClientId(clientId)) throw new OAuthClientError("invalid_client");

      const registered = opts.db
        .prepare<[string], { client_name: string; redirect_uris: string }>("SELECT client_name, redirect_uris FROM oauth_clients WHERE client_id = ?")
        .get(clientId);
      if (registered) {
        const redirects = JSON.parse(registered.redirect_uris) as string[];
        if (!redirects.some((r) => matchesRedirect(r, redirectUri))) throw new OAuthClientError("invalid_redirect");
        return { ...base, name: registered.client_name, verified: false };
      }
      // An unknown client id with a redirect Belay allows: named by where it returns to.
      return { ...base, name: legacyName(redirectUri), verified: CLAUDE_CALLBACKS.has(redirectUri) };
    },
  };
}

// ── Dynamic Client Registration (RFC 7591) ──────────────────────────────

export type Registration = { ok: true; body: Record<string, unknown> } | { ok: false; error: string; description: string };

const MAX_CLIENTS = 100;

export function registerClient(db: DB, now: number, metadata: unknown, extraRedirects: readonly string[]): Registration {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return { ok: false, error: "invalid_client_metadata", description: "Send a JSON object" };
  const data = metadata as Record<string, unknown>;
  const redirects = data.redirect_uris;
  if (!Array.isArray(redirects) || redirects.length === 0 || redirects.length > 10) {
    return { ok: false, error: "invalid_redirect_uri", description: "redirect_uris must list 1 to 10 URIs" };
  }
  if (!redirects.every((uri) => validRedirect(uri) && allowedRedirect(uri, extraRedirects))) {
    return { ok: false, error: "invalid_redirect_uri", description: "This server only returns to Claude's callback, an app on this computer (loopback), or redirects its owner allowed" };
  }
  const method = data.token_endpoint_auth_method;
  if (method !== undefined && method !== "none") return { ok: false, error: "invalid_client_metadata", description: "Only public clients (token_endpoint_auth_method none)" };
  const grants = data.grant_types;
  if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => g === "authorization_code" || g === "refresh_token"))) {
    return { ok: false, error: "invalid_client_metadata", description: "grant_types may be authorization_code and refresh_token" };
  }
  const responses = data.response_types;
  if (responses !== undefined && (!Array.isArray(responses) || !responses.every((r) => r === "code"))) {
    return { ok: false, error: "invalid_client_metadata", description: "response_types may only be code" };
  }
  const clientId = `belay-client-${newId()}`;
  const name = cleanName(data.client_name, "An MCP client");
  db.transaction(() => {
    const count = (db.prepare("SELECT COUNT(*) AS n FROM oauth_clients").get() as { n: number }).n;
    if (count >= MAX_CLIENTS) {
      db.prepare(
        `DELETE FROM oauth_clients WHERE client_id IN (SELECT client_id FROM oauth_clients
           WHERE client_id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL) ORDER BY created_at LIMIT ?)`,
      ).run(count - MAX_CLIENTS + 1);
    }
    db.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)").run(clientId, name, JSON.stringify(redirects), now);
  })();
  return {
    ok: true,
    body: {
      client_id: clientId,
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}
