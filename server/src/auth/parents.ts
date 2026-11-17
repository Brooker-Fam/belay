/** Parent accounts: first-run setup, sign-in, invites for a second parent, sessions. */
import { hash, verify } from "@node-rs/argon2";
import { newId, randomToken, safeEqual, sha256 } from "../crypto.js";
import type { DB } from "../db.js";

/** OWASP's argon2id baseline: 19 MiB, 2 passes, 1 lane. (`algorithm: 2` is Algorithm.Argon2id, a const enum.) */
const ARGON2 = { algorithm: 2, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

export const PASSWORD_MIN = 15;
export const PASSWORD_MAX = 256;
export const SESSION_TTL_MS = 30 * 24 * 3_600_000;
export const INVITE_TTL_MS = 7 * 24 * 3_600_000;
export const SETUP_TTL_MS = 24 * 3_600_000;

export interface Parent {
  id: string;
  name: string;
  username: string;
  createdAt: number;
}

export interface Session {
  parent: Parent;
  csrf: string;
  idHash: string;
}

/** Why a new password won't do, or null. Long is what matters (NIST SP 800-63B): no composition rules. */
export function passwordProblem(password: string, repeat: string): string | null {
  if (password !== repeat) return "The two passwords don't match.";
  if (Array.from(password).length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters. A few words together works well.`;
  if (password.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  return null;
}

export function usernameProblem(username: string): string | null {
  if (!/^[A-Za-z0-9._@-]{1,64}$/.test(username)) return "Use 1 to 64 letters, digits, or . _ @ -";
  return null;
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2);
}

let dummyHash: Promise<string> | undefined;

/** Checks a password; for an unknown username it still does the work, so timing says nothing. */
export async function checkPassword(db: DB, username: string, password: string): Promise<Parent | null> {
  const row = db
    .prepare<[string], { id: string; name: string; username: string; password_hash: string; created_at: number }>(
      "SELECT id, name, username, password_hash, created_at FROM parents WHERE username = ?",
    )
    .get(username.trim());
  if (!row) {
    dummyHash ??= hashPassword(randomToken(16));
    await verify(await dummyHash, password).catch(() => false);
    return null;
  }
  const ok = await verify(row.password_hash, password).catch(() => false);
  return ok ? { id: row.id, name: row.name, username: row.username, createdAt: row.created_at } : null;
}

export function parentCount(db: DB): number {
  return (db.prepare("SELECT COUNT(*) AS n FROM parents").get() as { n: number }).n;
}

export function listParents(db: DB): Parent[] {
  return db
    .prepare<[], { id: string; name: string; username: string; created_at: number }>(
      "SELECT id, name, username, created_at FROM parents ORDER BY created_at",
    )
    .all()
    .map((r) => ({ id: r.id, name: r.name, username: r.username, createdAt: r.created_at }));
}

export function getParent(db: DB, id: string): Parent | null {
  const r = db
    .prepare<[string], { id: string; name: string; username: string; created_at: number }>("SELECT id, name, username, created_at FROM parents WHERE id = ?")
    .get(id);
  return r ? { id: r.id, name: r.name, username: r.username, createdAt: r.created_at } : null;
}

export function usernameTaken(db: DB, username: string): boolean {
  return !!db.prepare("SELECT 1 FROM parents WHERE username = ?").get(username.trim());
}

export async function createParent(db: DB, now: number, input: { name: string; username: string; password: string }): Promise<Parent> {
  const passwordHash = await hashPassword(input.password);
  const parent = { id: newId(), name: input.name.trim(), username: input.username.trim(), createdAt: now };
  db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(
    parent.id,
    parent.name,
    parent.username,
    passwordHash,
    now,
  );
  return parent;
}

export async function setPassword(db: DB, parentId: string, password: string): Promise<void> {
  db.prepare("UPDATE parents SET password_hash = ? WHERE id = ?").run(await hashPassword(password), parentId);
}

/** Removes a parent, their sessions and their AI connections. Refuses to remove the last one. */
export function removeParent(db: DB, parentId: string): boolean {
  return db.transaction(() => {
    if (parentCount(db) <= 1) return false;
    return db.prepare("DELETE FROM parents WHERE id = ?").run(parentId).changes === 1;
  })();
}

// ── First-run setup ─────────────────────────────────────────────────────

/**
 * While there is no parent, the first one is created with a one-time link printed in the
 * server's log (or by `belay-server setup-link`). There is no default password, and someone
 * who finds a new server on the internet can't claim it.
 */
export function newSetupToken(db: DB, now: number): string {
  const token = randomToken(32);
  db.prepare("INSERT INTO settings (key, value) VALUES ('setup_token', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
    JSON.stringify({ hash: sha256(token), expires_at: now + SETUP_TTL_MS }),
  );
  return token;
}

export function setupTokenValid(db: DB, token: string, now: number): boolean {
  if (parentCount(db) > 0 || !token) return false;
  const row = db.prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'setup_token'").get();
  if (!row) return false;
  const saved = JSON.parse(row.value) as { hash: string; expires_at: number };
  return saved.expires_at > now && safeEqual(saved.hash, sha256(token));
}

export function clearSetupToken(db: DB): void {
  db.prepare("DELETE FROM settings WHERE key = 'setup_token'").run();
}

// ── Invites ─────────────────────────────────────────────────────────────

export function createInvite(db: DB, now: number, createdBy: string): string {
  const token = randomToken(32);
  db.prepare("INSERT INTO invites (token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)").run(sha256(token), createdBy, now, now + INVITE_TTL_MS);
  return token;
}

export function inviteValid(db: DB, token: string, now: number): boolean {
  return !!db.prepare("SELECT 1 FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").get(sha256(token), now);
}

export function useInvite(db: DB, token: string, now: number): boolean {
  return db.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?").run(now, sha256(token), now).changes === 1;
}

// ── Sessions ────────────────────────────────────────────────────────────

/** A new session: the cookie value goes to the browser; only its hash is kept. */
export function createSession(db: DB, now: number, parentId: string): { cookie: string; csrf: string } {
  const cookie = randomToken(32);
  const csrf = randomToken(32);
  db.prepare("INSERT INTO sessions (id_hash, parent_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(cookie),
    parentId,
    csrf,
    now,
    now + SESSION_TTL_MS,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { cookie, csrf };
}

export function loadSession(db: DB, cookie: string | undefined, now: number): Session | null {
  if (!cookie || cookie.length > 100) return null;
  const idHash = sha256(cookie);
  const row = db
    .prepare<[string, number], { csrf: string; id: string; name: string; username: string; created_at: number }>(
      `SELECT s.csrf, p.id, p.name, p.username, p.created_at FROM sessions s JOIN parents p ON p.id = s.parent_id
       WHERE s.id_hash = ? AND s.expires_at > ?`,
    )
    .get(idHash, now);
  if (!row) return null;
  return { parent: { id: row.id, name: row.name, username: row.username, createdAt: row.created_at }, csrf: row.csrf, idHash };
}

export function endSession(db: DB, idHash: string): void {
  db.prepare("DELETE FROM sessions WHERE id_hash = ?").run(idHash);
}

/** Signs a parent out on every browser, except `keep` when given. */
export function endAllSessions(db: DB, parentId: string, keep?: string): number {
  return db.prepare("DELETE FROM sessions WHERE parent_id = ? AND id_hash != ?").run(parentId, keep ?? "").changes;
}
