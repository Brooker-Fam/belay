/**
 * Phase 6: the recovery key (docs/protocol.md, "The recovery key"). 26 random characters of
 * Crockford's base32 alphabet, shown once; the policy carries only a salted SHA-256 of it, which
 * the phone checks offline. The agent's RecoveryKey.kt normalizes and hashes the same way, and the
 * tests of both share one test vector.
 */
import { createHash, randomBytes, randomInt } from "node:crypto";

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
