/**
 * Phase 6: the recovery key (docs/protocol.md, "The recovery key"). 26 random characters of
 * Crockford's base32 alphabet, shown once; the policy carries only a salted SHA-256 of it, which
 * the phone checks offline. The agent's RecoveryKey.kt normalizes and hashes the same way, and the
 * tests of both share one test vector.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import type { DB } from "../db.js";
import { changePolicy, type Changed, type Person, type PolicyContext } from "./policy.js";

export const RECOVERY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const RECOVERY_LENGTH = 26;

/** What the policy's `recovery` carries, besides its version. */
export interface RecoveryCheck {
  /** 16 random bytes, lowercase hex. */
  salt: string;
  /** SHA-256 of the salt's bytes and the normalized key's UTF-8, lowercase hex. */
  hash: string;
}

/** Upper case, without spaces or dashes, O read as 0 and I and L as 1; null if it can't be a key. */
export function normalizeRecoveryKey(typed: string): string | null {
  let out = "";
  for (const c of typed) {
    if (c === "-" || /\s/.test(c)) continue;
    let u = c.toUpperCase();
    if (u === "O") u = "0";
    else if (u === "I" || u === "L") u = "1";
    if (u.length !== 1 || !RECOVERY_ALPHABET.includes(u)) return null;
    out += u;
  }
  return out.length === RECOVERY_LENGTH ? out : null;
}

export function recoveryHash(saltHex: string, normalized: string): string {
  return createHash("sha256").update(Buffer.from(saltHex, "hex")).update(normalized, "utf8").digest("hex");
}

/** Four groups of five and one of six: `7KD2M-8Q4ZX-1HNP3-RT6VW-B9CF0G`. */
export function groupRecoveryKey(key: string): string {
  const groups: string[] = [];
  for (let i = 0; i < key.length; i += 5) groups.push(key.slice(i, i + 5));
  if (groups.length > 1 && groups.at(-1)?.length === 1) groups.push(groups.splice(-2).join(""));
  return groups.join("-");
}

/** A new key, to show once, and its check, to keep. */
export function makeRecoveryKey(): { key: string; grouped: string } & RecoveryCheck {
  let key = "";
  for (let i = 0; i < RECOVERY_LENGTH; i++) key += RECOVERY_ALPHABET.charAt(randomInt(RECOVERY_ALPHABET.length));
  const salt = randomBytes(16).toString("hex");
  return { key, grouped: groupRecoveryKey(key), salt, hash: recoveryHash(salt, key) };
}

// ── Each phone's key ─────────────────────────────────────────────────────

export interface RecoveryState {
  /** The phone's key: the newest one made for it. */
  current: { version: number; createdAt: number; createdBy: string | null; usedAt: number | null } | null;
  /** The newest use the phone reported, of any of its keys. */
  lastUse: { version: number; usedAt: number; until: number; reportedAt: number } | null;
}

export function recoveryState(db: DB, deviceId: string): RecoveryState {
  const current = db
    .prepare<[string], { version: number; created_at: number; created_by_name: string | null; used_at: number | null }>(
      `SELECT k.version, k.created_at, p.name AS created_by_name, k.used_at FROM recovery_keys k LEFT JOIN parents p ON p.id = k.created_by
       WHERE k.device_id = ? ORDER BY k.version DESC LIMIT 1`,
    )
    .get(deviceId);
  const use = db
    .prepare<[string], { version: number; used_at: number; open_until: number; use_reported_at: number }>(
      "SELECT version, used_at, open_until, use_reported_at FROM recovery_keys WHERE device_id = ? AND used_at IS NOT NULL ORDER BY use_reported_at DESC, version DESC LIMIT 1",
    )
    .get(deviceId);
  return {
    current: current ? { version: current.version, createdAt: current.created_at, createdBy: current.created_by_name, usedAt: current.used_at } : null,
    lastUse: use ? { version: use.version, usedAt: use.used_at, until: use.open_until, reportedAt: use.use_reported_at } : null,
  };
}

/** Whether the phone has a key it can still use: one was made, and it isn't used. */
export const usableKey = (state: RecoveryState): boolean => state.current !== null && state.current.usedAt === null;

/**
 * Makes the phone a new recovery key: the next version, whose check the policy carries from now
 * on, so the earlier key stops working once the phone has it. The key comes back once, grouped,
 * to show; only its check is kept. A person's action (a parent, or the server's CLI), never an
 * AI client's.
 */
export function makePhoneRecoveryKey(ctx: PolicyContext, deviceId: string, who: Person): Changed<{ grouped: string; version: number; replaced: boolean }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a person makes a recovery key");
  return changePolicy(ctx, deviceId, who, (log) => {
    const latest = ctx.db.prepare<[string], { version: number | null }>("SELECT MAX(version) AS version FROM recovery_keys WHERE device_id = ?").get(deviceId);
    const version = (latest?.version ?? 0) + 1;
    const made = makeRecoveryKey();
    ctx.db
      .prepare("INSERT INTO recovery_keys (device_id, version, salt, hash, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?)")
      .run(deviceId, version, made.salt, made.hash, ctx.now, who.kind === "parent" ? who.parentId : null);
    log("recovery.made", { key_version: version });
    return { grouped: made.grouped, version, replaced: version > 1 };
  });
}
