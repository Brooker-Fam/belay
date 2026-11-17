import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function newId(): string {
  return randomUUID();
}

/** `bytes` random bytes as base64url without padding (32 bytes: 43 characters, 256 bits). */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** SHA-256, hex. Tokens, session ids and codes are stored only like this. */
export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Crockford base32, without I, L, O and U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const CODE_LENGTH = 8;

/** A new enrollment code: 8 Crockford base32 characters, 40 random bits. */
export function newEnrollmentCode(): string {
  const bytes = randomBytes(5);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let code = "";
  for (let i = CODE_LENGTH - 1; i >= 0; i--) code += CROCKFORD.charAt(Number((bits >> BigInt(i * 5)) & 31n));
  return code;
}

/**
 * The code as typed ("7kq2-m9xa", "7KQ2 M9XA") in canonical form, or null when it can't be
 * one. I and L read as 1, O as 0, as Crockford says. Same rules as the agent's Enrollment.kt.
 */
export function normalizeCode(typed: string): string | null {
  const code = typed
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replace(/[IL]/g, "1")
    .replace(/O/g, "0");
  if (code.length !== CODE_LENGTH) return null;
  for (const c of code) if (!CROCKFORD.includes(c)) return null;
  return code;
}

/** "7KQ2M9XA" → "7KQ2-M9XA", easier to read aloud and type. */
export function formatCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
