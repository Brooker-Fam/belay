/**
 * AI access: OAuth grants (a connected app) and personal access tokens. Tokens are opaque,
 * random and stored only as SHA-256 hashes, so a parent can revoke any of them at once.
 */
import { newId, randomToken, sha256 } from "../crypto.js";
import type { DB } from "../db.js";

export const ACCESS_TTL_MS = 3_600_000;
/** For redirects outside the built-in allowlist, which get no refresh token. */
export const ACCESS_TTL_NO_REFRESH_MS = 24 * 3_600_000;
export const REFRESH_TTL_MS = 90 * 24 * 3_600_000;
export const CODE_TTL_MS = 10 * 60_000;
export const SCOPE = "belay";

export interface Grant {
  id: string;
  kind: "oauth" | "pat";
  parentId: string;
  parentName: string;
  clientId: string | null;
  /** What the parent saw on the consent screen ("Claude"), or the token's name. */
  clientName: string;
  clientHost: string | null;
  redirectUri: string | null;
  resource: string;
  scope: string;
  refreshAllowed: boolean;
  createdAt: number;
  lastUsedAt: number | null;
}

interface GrantRow {
  id: string;
  kind: "oauth" | "pat";
  parent_id: string;
  parent_name: string;
  client_id: string | null;
  client_name: string;
  client_host: string | null;
  redirect_uri: string | null;
  resource: string;
  scope: string;
  refresh_allowed: number;
  created_at: number;
  last_used_at: number | null;
}

const GRANT_SELECT = `SELECT g.id, g.kind, g.parent_id, p.name AS parent_name, g.client_id, g.client_name, g.client_host, g.redirect_uri,
  g.resource, g.scope, g.refresh_allowed, g.created_at, g.last_used_at
  FROM oauth_grants g JOIN parents p ON p.id = g.parent_id`;

function toGrant(r: GrantRow): Grant {
  return {
    id: r.id,
    kind: r.kind,
    parentId: r.parent_id,
    parentName: r.parent_name,
    clientId: r.client_id,
    clientName: r.client_name,
    clientHost: r.client_host,
    redirectUri: r.redirect_uri,
    resource: r.resource,
    scope: r.scope,
    refreshAllowed: r.refresh_allowed === 1,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
  };
}

export function listGrants(db: DB): Grant[] {
  return db.prepare<[], GrantRow>(`${GRANT_SELECT} WHERE g.revoked_at IS NULL ORDER BY g.created_at DESC`).all().map(toGrant);
}

export function getGrant(db: DB, id: string): Grant | null {
  const row = db.prepare<[string], GrantRow>(`${GRANT_SELECT} WHERE g.id = ? AND g.revoked_at IS NULL`).get(id);
  return row ? toGrant(row) : null;
}

/** Ends a connection: every token it issued stops working at once. */
export function revokeGrant(db: DB, id: string, now: number): boolean {
  return db.transaction(() => {
    const changed = db.prepare("UPDATE oauth_grants SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes === 1;
    db.prepare("DELETE FROM access_tokens WHERE grant_id = ?").run(id);
    return changed;
  }).immediate();
}

export function revokeAllGrants(db: DB, parentId: string, now: number): number {
  const ids = db.prepare<[string], { id: string }>("SELECT id FROM oauth_grants WHERE parent_id = ? AND revoked_at IS NULL").all(parentId);
  for (const { id } of ids) revokeGrant(db, id, now);
  return ids.length;
}

function storeToken(db: DB, grantId: string, kind: "access" | "refresh" | "pat", now: number, ttl: number | null): string {
  const prefix = { access: "belay_at_", refresh: "belay_rt_", pat: "belay_pat_" }[kind];
  const token = prefix + randomToken(32);
  db.prepare("INSERT INTO access_tokens (token_hash, grant_id, kind, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(token),
    grantId,
    kind,
    now,
    ttl === null ? null : now + ttl,
  );
  return token;
}

export interface IssuedTokens {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token?: string;
  scope: string;
}

export function issueTokens(db: DB, now: number, grant: Pick<Grant, "id" | "refreshAllowed" | "scope">): IssuedTokens {
  const ttl = grant.refreshAllowed ? ACCESS_TTL_MS : ACCESS_TTL_NO_REFRESH_MS;
  db.prepare("DELETE FROM access_tokens WHERE grant_id = ? AND expires_at IS NOT NULL AND expires_at <= ?").run(grant.id, now);
  const tokens: IssuedTokens = { access_token: storeToken(db, grant.id, "access", now, ttl), token_type: "Bearer", expires_in: ttl / 1000, scope: grant.scope };
  if (grant.refreshAllowed) tokens.refresh_token = storeToken(db, grant.id, "refresh", now, REFRESH_TTL_MS);
  return tokens;
}

export function createGrant(
  db: DB,
  now: number,
  input: { kind: "oauth" | "pat"; parentId: string; clientId: string | null; clientName: string; clientHost: string | null; redirectUri: string | null; resource: string; refreshAllowed: boolean },
): string {
  const id = newId();
  db.prepare(
    `INSERT INTO oauth_grants (id, kind, parent_id, client_id, client_name, client_host, redirect_uri, resource, scope, refresh_allowed, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, input.kind, input.parentId, input.clientId, input.clientName, input.clientHost, input.redirectUri, input.resource, SCOPE, input.refreshAllowed ? 1 : 0, now);
  return id;
}

/** A personal access token for Claude Code and other clients. Shown once. */
export function createPersonalToken(db: DB, now: number, parentId: string, name: string, resource: string): { token: string; grantId: string } {
  return db.transaction(() => {
    const grantId = createGrant(db, now, { kind: "pat", parentId, clientId: null, clientName: name, clientHost: null, redirectUri: null, resource, refreshAllowed: false });
    return { token: storeToken(db, grantId, "pat", now, null), grantId };
  }).immediate();
}

/** The grant behind a valid access token or personal access token, or null. */
export function grantForAccessToken(db: DB, token: string, now: number): Grant | null {
  const row = db
    .prepare<[string, number], GrantRow>(
      `${GRANT_SELECT} JOIN access_tokens t ON t.grant_id = g.id
       WHERE t.token_hash = ? AND t.kind IN ('access', 'pat') AND (t.expires_at IS NULL OR t.expires_at > ?) AND g.revoked_at IS NULL`,
    )
    .get(sha256(token), now);
  return row ? toGrant(row) : null;
}

export function touchGrant(db: DB, id: string, now: number): void {
  db.prepare("UPDATE oauth_grants SET last_used_at = ? WHERE id = ?").run(now, id);
}

export type RefreshResult = { ok: true; grant: Grant; tokens: IssuedTokens } | { ok: false; reused: boolean };

/**
 * Exchanges a refresh token for new tokens, and rotates it. A refresh token used twice means
 * it leaked: the whole grant is revoked (OAuth 2.1, section 4.3.1).
 */
export function exchangeRefreshToken(db: DB, token: string, now: number, clientId: string | null): RefreshResult {
  return db.transaction((): RefreshResult => {
    const row = db
      .prepare<[string], { grant_id: string; expires_at: number | null; used_at: number | null }>(
        "SELECT grant_id, expires_at, used_at FROM access_tokens WHERE token_hash = ? AND kind = 'refresh'",
      )
      .get(sha256(token));
    if (!row) return { ok: false, reused: false };
    if (row.used_at !== null) {
      revokeGrant(db, row.grant_id, now);
      return { ok: false, reused: true };
    }
    const grant = getGrant(db, row.grant_id);
    if (!grant || (row.expires_at !== null && row.expires_at <= now) || !grant.refreshAllowed) return { ok: false, reused: false };
    if (clientId !== null && clientId !== grant.clientId) return { ok: false, reused: false };
    db.prepare("UPDATE access_tokens SET used_at = ? WHERE token_hash = ?").run(now, sha256(token));
    return { ok: true, grant, tokens: issueTokens(db, now, grant) };
  }).immediate();
}
