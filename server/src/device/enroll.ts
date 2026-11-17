import { formatCode, newEnrollmentCode, newId, randomToken, sha256 } from "../crypto.js";
import type { DB } from "../db.js";
import type { Device } from "./schemas.js";

export const CODE_TTL_MS = 30 * 60_000;

export interface PendingCode {
  codeHash: string;
  deviceName: string;
  deviceId: string | null;
  createdAt: number;
  expiresAt: number;
}

/**
 * A new one-time code for adding a phone (or, with `deviceId`, reconnecting one, which keeps
 * its history). Only the hash is stored: the code is shown once, on the Add a phone page.
 */
export function createEnrollmentCode(
  db: DB,
  now: number,
  opts: { deviceName: string; createdBy: string | null; deviceId?: string | null },
): { code: string; display: string; expiresAt: number } {
  const code = newEnrollmentCode();
  const expiresAt = now + CODE_TTL_MS;
  db.prepare(
    `INSERT INTO enrollment_codes (code_hash, device_name, device_id, created_by, created_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(sha256(code), opts.deviceName, opts.deviceId ?? null, opts.createdBy, now, expiresAt);
  return { code, display: formatCode(code), expiresAt };
}

export function pendingCodes(db: DB, now: number): PendingCode[] {
  return db
    .prepare<[number], { code_hash: string; device_name: string; device_id: string | null; created_at: number; expires_at: number }>(
      `SELECT code_hash, device_name, device_id, created_at, expires_at FROM enrollment_codes
       WHERE used_at IS NULL AND expires_at > ? ORDER BY created_at DESC`,
    )
    .all(now)
    .map((r) => ({ codeHash: r.code_hash, deviceName: r.device_name, deviceId: r.device_id, createdAt: r.created_at, expiresAt: r.expires_at }));
}

export function cancelCode(db: DB, codeHash: string): boolean {
  return db.prepare("DELETE FROM enrollment_codes WHERE code_hash = ? AND used_at IS NULL").run(codeHash).changes === 1;
}

export interface Enrolled {
  deviceId: string;
  deviceName: string;
  token: string;
  reconnected: boolean;
}

/** Uses a code (already normalized): a new phone, or a new token for the phone it reconnects. Null when the code is no good. */
export function enroll(db: DB, code: string, device: Device, now: number): Enrolled | null {
  return db.transaction((): Enrolled | null => {
    const codeHash = sha256(code);
    const row = db
      .prepare<[string], { device_name: string; device_id: string | null; expires_at: number; used_at: number | null }>(
        "SELECT device_name, device_id, expires_at, used_at FROM enrollment_codes WHERE code_hash = ?",
      )
      .get(codeHash);
    if (!row || row.used_at !== null || row.expires_at <= now) return null;

    const token = randomToken(32);
    const facts = JSON.stringify(device);
    let deviceId: string;
    let deviceName = row.device_name;
    if (row.device_id) {
      deviceId = row.device_id;
      const current = db.prepare<[string], { name: string }>("SELECT name FROM devices WHERE id = ?").get(deviceId);
      if (!current) return null;
      deviceName = current.name;
      db.prepare(
        `UPDATE devices SET token_hash = ?, revoked_at = NULL, facts = ?, facts_at = ?, last_seen_at = ? WHERE id = ?`,
      ).run(sha256(token), facts, now, now, deviceId);
    } else {
      deviceId = newId();
      db.prepare(
        `INSERT INTO devices (id, name, token_hash, enrolled_at, last_seen_at, facts, facts_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(deviceId, deviceName, sha256(token), now, now, facts, now);
    }
    const used = db
      .prepare("UPDATE enrollment_codes SET used_at = ?, used_by_device = ? WHERE code_hash = ? AND used_at IS NULL")
      .run(now, deviceId, codeHash);
    if (used.changes !== 1) throw new Error("enrollment code raced");
    return { deviceId, deviceName, token, reconnected: row.device_id !== null };
  })();
}
