import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackupCryptoError, DEFAULT_SCRYPT, HEADER_BYTES, decryptFile, encryptFile, fileKind, type CryptoProblem } from "../src/ops/crypt.js";

const FAST = { logN: 10, r: 8, p: 1 };
const PASS = "a made-up passphrase for tests";
const dirs: string[] = [];

function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), "belay-crypt-test-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function encrypted(plain: Buffer, passphrase = PASS) {
  const dir = scratch();
  writeFileSync(join(dir, "plain"), plain);
  await encryptFile(join(dir, "plain"), join(dir, "sealed"), passphrase, FAST);
  return { dir, sealed: join(dir, "sealed"), out: join(dir, "out") };
}

async function refusal(promise: Promise<unknown>): Promise<CryptoProblem> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof BackupCryptoError) return error.problem;
    throw error;
  }
  throw new Error("it didn't refuse");
}

describe("encrypted backups", () => {
  it("round-trips, streamed: empty, small, and several megabytes", async () => {
    for (const plain of [Buffer.alloc(0), Buffer.from("SQLite format 3\0 and then some"), randomBytes(3 * 1024 * 1024 + 17)]) {
      const { sealed, out } = await encrypted(plain);
      expect(statSync(sealed).size).toBe(HEADER_BYTES + plain.length + 16);
      await decryptFile(sealed, out, PASS);
      expect(readFileSync(out).equals(plain)).toBe(true);
    }
  });

  it("works with the default scrypt settings, and writes files only the server can read", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "plain"), "SQLite format 3\0");
    await encryptFile(join(dir, "plain"), join(dir, "sealed"), PASS, DEFAULT_SCRYPT);
    await decryptFile(join(dir, "sealed"), join(dir, "out"), PASS);
    expect(readFileSync(join(dir, "out"), "utf8")).toBe("SQLite format 3\0");
    expect(statSync(join(dir, "sealed")).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, "out")).mode & 0o777).toBe(0o600);
    const header = readFileSync(join(dir, "sealed")).subarray(0, 12);
    expect(header.subarray(0, 8).toString("ascii")).toBe("BELAYBAK");
    expect([...header.subarray(8)]).toEqual([1, 17, 8, 1]);
  });

  it("uses a new salt and nonce every time", async () => {
    const plain = Buffer.from("the same plaintext");
    const one = readFileSync((await encrypted(plain)).sealed);
    const two = readFileSync((await encrypted(plain)).sealed);
    expect(one.subarray(12, 40).equals(two.subarray(12, 40))).toBe(false);
    expect(one.subarray(HEADER_BYTES).equals(two.subarray(HEADER_BYTES))).toBe(false);
  });

  it("refuses a wrong passphrase cleanly, before decrypting anything", async () => {
    const { sealed, out } = await encrypted(randomBytes(5000));
    expect(await refusal(decryptFile(sealed, out, "not the passphrase at all"))).toBe("wrong_passphrase");
    expect(existsSync(out)).toBe(false);
  });

  it("takes the passphrase however the keyboard composed its accents", async () => {
    const { sealed, out } = await encrypted(Buffer.from("x"), "café au lait, 5 sugars please");
    await decryptFile(sealed, out, "café au lait, 5 sugars please");
    expect(readFileSync(out, "utf8")).toBe("x");
  });

  it("rejects a file cut short, anywhere, and leaves nothing behind", async () => {
    const plain = randomBytes(70_000);
    const { dir, sealed } = await encrypted(plain);
    const whole = readFileSync(sealed);
    for (const keep of [whole.length - 1, whole.length - 16, whole.length - 17, HEADER_BYTES + 16, HEADER_BYTES + 3, 30, 9]) {
      const cut = join(dir, `cut-${keep}`);
      writeFileSync(cut, whole.subarray(0, keep));
      expect(await refusal(decryptFile(cut, join(dir, `out-${keep}`), PASS))).toBe("damaged");
      expect(existsSync(join(dir, `out-${keep}`))).toBe(false);
    }
  });

  it("rejects a file that was changed: ciphertext, tag, nonce, header, or bytes added", async () => {
    const { dir, sealed } = await encrypted(randomBytes(70_000));
    const whole = readFileSync(sealed);
    const changed = (at: number) => {
      const copy = Buffer.from(whole);
      copy[at] = (copy[at] ?? 0) ^ 0x01;
      return copy;
    };
    const cases: [string, Buffer, CryptoProblem][] = [
      ["ciphertext", changed(HEADER_BYTES + 40_000), "damaged"],
      ["tag", changed(whole.length - 3), "damaged"],
      ["nonce", changed(30), "damaged"],
      ["salt", changed(14), "wrong_passphrase"],
      ["passphrase check", changed(45), "wrong_passphrase"],
      ["version", changed(8), "unsupported"],
      ["extended", Buffer.concat([whole, Buffer.from([0])]), "damaged"],
    ];
    for (const [name, bytes, problem] of cases) {
      writeFileSync(join(dir, name), bytes);
      expect([name, await refusal(decryptFile(join(dir, name), join(dir, `${name}.out`), PASS))]).toEqual([name, problem]);
      expect(existsSync(join(dir, `${name}.out`))).toBe(false);
    }
  });

  it("refuses a header that asks for too much memory or time", async () => {
    const { dir, sealed } = await encrypted(Buffer.from("x"));
    const greedy = readFileSync(sealed);
    greedy[9] = 22;
    greedy[10] = 32;
    writeFileSync(join(dir, "greedy"), greedy);
    expect(await refusal(decryptFile(join(dir, "greedy"), join(dir, "out"), PASS))).toBe("damaged");
  });

  it("says when a file isn't an encrypted backup, and never overwrites a file", async () => {
    const dir = scratch();
    writeFileSync(join(dir, "plain.db"), "SQLite format 3\0rest of a database");
    writeFileSync(join(dir, "notes.txt"), "hello");
    expect(await refusal(decryptFile(join(dir, "plain.db"), join(dir, "out"), PASS))).toBe("not_encrypted");
    expect(await fileKind(join(dir, "plain.db"))).toBe("sqlite");
    expect(await fileKind(join(dir, "notes.txt"))).toBe("other");

    const { sealed, dir: other } = await encrypted(Buffer.from("x"));
    expect(await fileKind(sealed)).toBe("encrypted");
    writeFileSync(join(other, "taken"), "keep me");
    await expect(decryptFile(sealed, join(other, "taken"), PASS)).rejects.toThrow(/EEXIST/);
    await expect(encryptFile(join(dir, "notes.txt"), join(other, "taken"), PASS, FAST)).rejects.toThrow(/EEXIST/);
    expect(readFileSync(join(other, "taken"), "utf8")).toBe("keep me");
  });
});
