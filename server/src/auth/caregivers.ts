/**
 * Phase 12: a caregiver's sign-in: the one-time link a parent makes, their password, and their
 * sessions (docs/design/phase12-caregivers.md). With a parent's rules (at least 15 characters,
 * argon2id, sign-in limited per address and per username), but never a parent's: their sessions
 * are in `caregiver_sessions`, behind the cookie `belay_care`, and only the caregiver pages (care/)
 * read them. A parent page reads `sessions` joined to `parents` (parents.ts), so a caregiver's
 * session is no session there, whichever cookie carries it. A session lasts 7 days, and no longer
 * than the caregiver's access: loading one whose access ended deletes it.
 */
import { verify } from "@node-rs/argon2";
import { randomToken, sha256 } from "../crypto.js";
import type { DB } from "../db.js";
import { type Caregiver, LINK_TTL_MS, accessCurrent, getCaregiver } from "../family/caregivers/store.js";
import { hashPassword } from "./parents.js";

export const CARE_SESSION_TTL_MS = 7 * 86_400_000;

export interface CareSession {
  caregiver: Caregiver;
  csrf: string;
  idHash: string;
}

// ── One-time links ─────────────────────────────────────────────────────

/**
 * A new one-time link for a caregiver: it works once, for 7 days, and never after their access
 * ends. It replaces any link of theirs not used yet. Only its hash is kept.
 */
export function createCareLink(db: DB, now: number, caregiverId: string, endsAt: number, createdBy: string | null): string {
  const token = randomToken(32);
  db.prepare("DELETE FROM caregiver_links WHERE caregiver_id = ? AND used_at IS NULL").run(caregiverId);
  db.prepare("INSERT INTO caregiver_links (token_hash, caregiver_id, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(token),
    caregiverId,
    createdBy,
    now,
    Math.min(now + LINK_TTL_MS, endsAt),
  );
  return token;
}

/** The caregiver a link is for, while it works: not used, not expired, and their access current. */
export function careLinkCaregiver(db: DB, token: string, now: number): Caregiver | null {
  if (!token || token.length > 100) return null;
  const row = db
    .prepare<[string, number], { caregiver_id: string }>("SELECT caregiver_id FROM caregiver_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .get(sha256(token), now);
  const caregiver = row ? getCaregiver(db, row.caregiver_id) : null;
  return caregiver && accessCurrent(caregiver, now) ? caregiver : null;
}

/** Whether another caregiver chose this username already. */
export function careUsernameTaken(db: DB, username: string, exceptId: string): boolean {
  return !!db.prepare("SELECT 1 FROM caregivers WHERE username = ? COLLATE NOCASE AND id != ?").get(username.trim(), exceptId);
}

export type JoinResult = { ok: true; caregiver: Caregiver; cookie: string; csrf: string } | { ok: false; why: "link" | "username" };

/**
 * Sets a caregiver's username and password with their link, which it uses up, signs them out
 * everywhere else, and signs them in here. The password is hashed before the transaction.
 */
export async function joinWithLink(db: DB, now: number, token: string, username: string, password: string): Promise<JoinResult> {
  const passwordHash = await hashPassword(password);
  return db.transaction((): JoinResult => {
    const caregiver = careLinkCaregiver(db, token, now);
    if (!caregiver) return { ok: false, why: "link" };
    if (careUsernameTaken(db, username, caregiver.id)) return { ok: false, why: "username" };
    db.prepare("UPDATE caregiver_links SET used_at = ? WHERE token_hash = ?").run(now, sha256(token));
    db.prepare("UPDATE caregivers SET username = ?, password_hash = ?, joined_at = COALESCE(joined_at, ?), last_signed_in_at = ?, updated_at = ? WHERE id = ?").run(
      username.trim(),
      passwordHash,
      now,
      now,
      now,
      caregiver.id,
    );
    endCaregiverSessions(db, caregiver.id);
    const session = createCareSession(db, now, caregiver.id);
    const joined = getCaregiver(db, caregiver.id);
    if (!joined) throw new Error("caregiver vanished");
    return { ok: true, caregiver: joined, ...session };
  }).immediate();
}

// ── Passwords ──────────────────────────────────────────────────────────

let dummyHash: Promise<string> | undefined;

/**
 * Checks a caregiver's password; for an unknown username it still does the work, so timing says
 * nothing. Only a caregiver who joined has one. Whether their access lasts is the caller's to ask.
 */
export async function checkCaregiverPassword(db: DB, username: string, password: string): Promise<Caregiver | null> {
  const row = db
    .prepare<[string], { id: string; password_hash: string }>("SELECT id, password_hash FROM caregivers WHERE username = ? COLLATE NOCASE AND password_hash IS NOT NULL")
    .get(username.trim());
  if (!row) {
    dummyHash ??= hashPassword(randomToken(16));
    await verify(await dummyHash, password).catch(() => false);
    return null;
  }
  const ok = await verify(row.password_hash, password).catch(() => false);
  return ok ? getCaregiver(db, row.id) : null;
}

// ── Sessions ───────────────────────────────────────────────────────────

/** A new caregiver session: the cookie value goes to the browser; only its hash is kept. */
export function createCareSession(db: DB, now: number, caregiverId: string): { cookie: string; csrf: string } {
  const cookie = randomToken(32);
  const csrf = randomToken(32);
  db.prepare("INSERT INTO caregiver_sessions (id_hash, caregiver_id, csrf, created_at, expires_at) VALUES (?, ?, ?, ?, ?)").run(
    sha256(cookie),
    caregiverId,
    csrf,
    now,
    now + CARE_SESSION_TTL_MS,
  );
  db.prepare("DELETE FROM caregiver_sessions WHERE expires_at <= ?").run(now);
  return { cookie, csrf };
}

/** The caregiver session for this cookie, while it lasts and so does their access; one whose access ended is deleted. */
export function loadCareSession(db: DB, cookie: string | undefined, now: number): CareSession | null {
  if (!cookie || cookie.length > 100) return null;
  const idHash = sha256(cookie);
  const row = db
    .prepare<[string, number], { caregiver_id: string; csrf: string }>("SELECT caregiver_id, csrf FROM caregiver_sessions WHERE id_hash = ? AND expires_at > ?")
    .get(idHash, now);
  if (!row) return null;
  const caregiver = getCaregiver(db, row.caregiver_id);
  if (!caregiver || !accessCurrent(caregiver, now)) {
    endCareSession(db, idHash);
    return null;
  }
  return { caregiver, csrf: row.csrf, idHash };
}

export function endCareSession(db: DB, idHash: string): void {
  db.prepare("DELETE FROM caregiver_sessions WHERE id_hash = ?").run(idHash);
}

/** Signs a caregiver out everywhere. */
export function endCaregiverSessions(db: DB, caregiverId: string): number {
  return db.prepare("DELETE FROM caregiver_sessions WHERE caregiver_id = ?").run(caregiverId).changes;
}

/** Records a sign-in, for the parents' Caregivers page. */
export function careSignedIn(db: DB, now: number, caregiverId: string): void {
  db.prepare("UPDATE caregivers SET last_signed_in_at = ? WHERE id = ?").run(now, caregiverId);
}
