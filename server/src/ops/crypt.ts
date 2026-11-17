/**
 * Encrypted backup files, with Node's crypto only: AES-256-GCM with a key from the family's
 * passphrase (scrypt), streamed, so a large database never has to fit in memory.
 *
 * The file is a 56-byte header, then the ciphertext, then GCM's 16-byte tag:
 *
 *   0   8  magic "BELAYBAK"
 *   8   1  format version (1)
 *   9   1  scrypt cost, log2(N)
 *   10  1  scrypt block size r
 *   11  1  scrypt parallelism p
 *   12  16 salt
 *   28  12 nonce
 *   40  16 passphrase check: HMAC-SHA256(check key, "Belay backup passphrase check"), first 16 bytes
 *
 * scrypt gives 64 bytes: the first 32 are the AES key, the last 32 the check key, so a wrong
 * passphrase is told apart from a damaged file before anything is decrypted. (The check gives
 * someone guessing passphrases nothing they don't already have: a database's first bytes are
 * always "SQLite format 3".) The whole header is the GCM additional data, so changing any of
 * it fails the tag, as does changing, cutting or extending the ciphertext.
 *
 * GCM only proves the data is genuine at the end, so decryptFile writes to a new file and
 * deletes it unless the tag matched: nothing should use the output of a decryption that threw.
 */
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { open, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export const MAGIC = Buffer.from("BELAYBAK", "ascii");
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "latin1");
export const FORMAT_VERSION = 1;
export const HEADER_BYTES = 56;
export const TAG_BYTES = 16;

export interface ScryptParams {
  /** log2 of scrypt's cost N. */
  logN: number;
  r: number;
  p: number;
}

/** 128 MiB of memory and about a second on a small server: what OWASP suggests for scrypt. */
export const DEFAULT_SCRYPT: ScryptParams = { logN: 17, r: 8, p: 1 };

/** What a file may ask for, so a made-up header can't make the server spend gigabytes. */
const MAX_MEMORY = 512 * 1024 * 1024;

function scryptMemory({ logN, r }: ScryptParams): number {
  return 128 * 2 ** logN * r;
}

function paramsProblem(params: ScryptParams): string | null {
  const { logN, r, p } = params;
  if (!Number.isInteger(logN) || logN < 10 || logN > 22) return "scrypt's cost is out of range";
  if (!Number.isInteger(r) || r < 1 || r > 32) return "scrypt's block size is out of range";
  if (!Number.isInteger(p) || p < 1 || p > 16) return "scrypt's parallelism is out of range";
  if (scryptMemory(params) > MAX_MEMORY) return "scrypt's settings need too much memory";
  return null;
}

export type CryptoProblem = "not_encrypted" | "unsupported" | "wrong_passphrase" | "damaged";

export class BackupCryptoError extends Error {
  override name = "BackupCryptoError";
  constructor(
    readonly problem: CryptoProblem,
    message: string,
  ) {
    super(message);
  }
}

function deriveKeys(passphrase: string, salt: Uint8Array, params: ScryptParams): Promise<{ key: Buffer; check: Buffer }> {
  const options: ScryptOptions = { N: 2 ** params.logN, r: params.r, p: params.p, maxmem: scryptMemory(params) + 32 * 1024 * 1024 };
  // NFC, so the same passphrase typed on another computer gives the same key.
  const secret: BinaryLike = Buffer.from(passphrase.normalize("NFC"), "utf8");
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 64, options, (error, out) => {
      if (error) reject(error);
      else resolve({ key: out.subarray(0, 32), check: createHmac("sha256", out.subarray(32)).update("Belay backup passphrase check").digest().subarray(0, 16) });
    });
  });
}

interface Header {
  bytes: Buffer;
  params: ScryptParams;
  salt: Buffer;
  nonce: Buffer;
  check: Buffer;
}

function parseHeader(bytes: Buffer): Header {
  if (bytes.length < MAGIC.length || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) {
    throw new BackupCryptoError("not_encrypted", "This isn't an encrypted Belay backup.");
  }
  const cutShort = new BackupCryptoError("damaged", "This backup is cut short: its header isn't whole.");
  if (bytes.length <= 8) throw cutShort;
  if (bytes[8] !== FORMAT_VERSION) {
    throw new BackupCryptoError("unsupported", `This backup is in format ${bytes[8] ?? 0}, which this Belay can't read: it was made by a newer one.`);
  }
  if (bytes.length < HEADER_BYTES) throw cutShort;
  const params = { logN: bytes[9] ?? 0, r: bytes[10] ?? 0, p: bytes[11] ?? 0 };
  const problem = paramsProblem(params);
  if (problem) throw new BackupCryptoError("damaged", `This backup's header is damaged: ${problem}.`);
  return { bytes: bytes.subarray(0, HEADER_BYTES), params, salt: bytes.subarray(12, 28), nonce: bytes.subarray(28, 40), check: bytes.subarray(40, 56) };
}

/** What the file starts with: an encrypted Belay backup, a plain SQLite database, or something else. */
export async function fileKind(file: string): Promise<"encrypted" | "sqlite" | "other"> {
  const handle = await open(file, "r");
  try {
    const start = Buffer.alloc(16);
    const { bytesRead } = await handle.read(start, 0, 16, 0);
    if (bytesRead >= MAGIC.length && start.subarray(0, MAGIC.length).equals(MAGIC)) return "encrypted";
    if (bytesRead === 16 && start.equals(SQLITE_MAGIC)) return "sqlite";
    return "other";
  } finally {
    await handle.close();
  }
}

/**
 * Encrypts `source` into `target`, a new file (mode 0600). Returns its size. Each file gets
 * its own salt and nonce, so the same passphrase never reuses a key and nonce.
 */
export async function encryptFile(source: string, target: string, passphrase: string, params: ScryptParams = DEFAULT_SCRYPT): Promise<number> {
  const problem = paramsProblem(params);
  if (problem) throw new Error(`Can't encrypt with these scrypt settings: ${problem}`);
  const salt = randomBytes(16);
  const nonce = randomBytes(12);
  const { key, check } = await deriveKeys(passphrase, salt, params);
  const header = Buffer.concat([MAGIC, Buffer.from([FORMAT_VERSION, params.logN, params.r, params.p]), salt, nonce, check]);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(header);
  try {
    await pipeline(
      createReadStream(source),
      cipher,
      async function* (sealed: AsyncIterable<Buffer>) {
        yield header;
        for await (const chunk of sealed) yield chunk;
        yield cipher.getAuthTag();
      },
      createWriteStream(target, { flags: "wx", mode: 0o600 }),
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) await rm(target, { force: true });
    throw error;
  }
  return (await stat(target)).size;
}

/**
 * Decrypts `source` into `target`, a new file (mode 0600). A wrong passphrase, a file that
 * isn't one, or one that was cut short or changed throws BackupCryptoError, and `target` is
 * deleted: nothing unproven is left behind.
 */
export async function decryptFile(source: string, target: string, passphrase: string): Promise<void> {
  const size = (await stat(source)).size;
  const handle = await open(source, "r");
  let header: Header;
  const tag = Buffer.alloc(TAG_BYTES);
  try {
    const start = Buffer.alloc(HEADER_BYTES);
    const { bytesRead } = await handle.read(start, 0, HEADER_BYTES, 0);
    header = parseHeader(start.subarray(0, bytesRead));
    if (size < HEADER_BYTES + TAG_BYTES) throw new BackupCryptoError("damaged", "This backup is cut short: it ends before its tag.");
    await handle.read(tag, 0, TAG_BYTES, size - TAG_BYTES);
  } finally {
    await handle.close();
  }
  const { key, check } = await deriveKeys(passphrase, header.salt, header.params);
  if (!timingSafeEqual(check, header.check)) throw new BackupCryptoError("wrong_passphrase", "The passphrase is wrong for this backup.");
  const decipher = createDecipheriv("aes-256-gcm", key, header.nonce);
  decipher.setAAD(header.bytes);
  decipher.setAuthTag(tag);
  const sealedBytes = size - HEADER_BYTES - TAG_BYTES;
  const sealed = sealedBytes > 0 ? createReadStream(source, { start: HEADER_BYTES, end: HEADER_BYTES + sealedBytes - 1 }) : Readable.from([]);
  try {
    await pipeline(sealed, decipher, createWriteStream(target, { flags: "wx", mode: 0o600 }));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) await rm(target, { force: true });
    if (error instanceof Error && /unable to authenticate/i.test(error.message)) {
      throw new BackupCryptoError("damaged", "This backup is damaged, or was changed after it was made: it doesn't match its tag.");
    }
    throw error;
  }
}
