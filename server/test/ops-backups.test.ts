import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadMigrations } from "../src/db.js";
import { BACKUPS_KEPT, backupDir, backupPassphrase, dailyBackupDue, latestBackup, listBackups, runDailyBackup, writeBackup } from "../src/ops/backups.js";
import { decryptFile } from "../src/ops/crypt.js";
import { opsTick } from "../src/ops/jobs.js";
import { enrollPhone, T0 } from "./helpers.js";
import { FAST_SCRYPT, PASSPHRASE, dailyContext, opsServer, scratchDir } from "./ops-helpers.js";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const LATEST = loadMigrations().at(-1)?.version;

function openCopy(file: string) {
  return new Database(file, { readonly: true, fileMustExist: true });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the daily backup", () => {
  it("writes a consistent copy of the database to backups/belay-<day>.db, and records it", async () => {
    const t = opsServer();
    await enrollPhone(t, "Test phone");
    const record = await runDailyBackup(dailyContext(t));
    expect(record).toMatchObject({ kind: "daily", file: "belay-2026-11-16.db", ok: true, encrypted: false, error: null, startedAt: T0 });
    const file = join(backupDir(t.dataDir), "belay-2026-11-16.db");
    expect(record?.bytes).toBe(statSync(file).size);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(backupDir(t.dataDir)).mode & 0o777).toBe(0o700);
    const copy = openCopy(file);
    expect(copy.pragma("integrity_check", { simple: true })).toBe("ok");
    expect(copy.pragma("user_version", { simple: true })).toBe(LATEST);
    expect(copy.prepare("SELECT name FROM devices").all()).toEqual([{ name: "Test phone" }]);
    copy.close();
    expect(latestBackup(t.deps.db)).toEqual(record);
    expect(t.logs.at(-1)).toMatch(/^Backed up the database to backups\/belay-2026-11-16\.db \(\d+(\.\d)? KB\)\.$/);
  });

  it("runs once a day, from 2 AM in the family's timezone", async () => {
    const t = opsServer();
    await runDailyBackup(dailyContext(t));
    t.advance(HOUR);
    expect(await runDailyBackup(dailyContext(t))).toBeNull();
    // 1:30 AM in New York the next day: not yet.
    t.advance(15.5 * HOUR - HOUR);
    expect(dailyBackupDue(t.deps.db, t.now())).toBe(false);
    t.advance(30 * 60_000);
    expect(await runDailyBackup(dailyContext(t))).toMatchObject({ file: "belay-2026-11-17.db", ok: true });
    expect(listBackups(t.deps.db)).toHaveLength(2);
  });

  it("keeps the newest 14 of its own files, and nothing else is touched", async () => {
    const t = opsServer();
    mkdirSync(backupDir(t.dataDir));
    writeFileSync(join(backupDir(t.dataDir), "notes.txt"), "the family's own file");
    for (let day = 0; day < 20; day++) {
      expect(await runDailyBackup(dailyContext(t))).toMatchObject({ ok: true });
      t.advance(DAY);
    }
    const files = readdirSync(backupDir(t.dataDir)).sort();
    expect(files).toHaveLength(BACKUPS_KEPT + 1);
    expect(files[0]).toBe("belay-2026-11-22.db");
    expect(files.at(-2)).toBe("belay-2026-12-05.db");
    expect(files.at(-1)).toBe("notes.txt");
  });

  it("cleans up what a crash left half-written, after an hour", async () => {
    const t = opsServer();
    mkdirSync(backupDir(t.dataDir));
    const partial = join(backupDir(t.dataDir), "belay-2026-11-15.db.partial-0123456789ab");
    writeFileSync(partial, "half a backup");
    const old = (Date.now() - 2 * HOUR) / 1000;
    utimesSync(partial, old, old);
    await runDailyBackup(dailyContext(t));
    expect(existsSync(partial)).toBe(false);
  });

  it("never overwrites a backup: a second one for the same day gets its own name", async () => {
    const t = opsServer();
    mkdirSync(backupDir(t.dataDir));
    writeFileSync(join(backupDir(t.dataDir), "belay-2026-11-16.db"), "an older backup from today, kept");
    expect(await runDailyBackup(dailyContext(t))).toMatchObject({ file: "belay-2026-11-16-2.db", ok: true });
    expect(readFileSync(join(backupDir(t.dataDir), "belay-2026-11-16.db"), "utf8")).toBe("an older backup from today, kept");
  });

  it("encrypts it when the family set a passphrase: belay-<day>.db.enc, which decrypts to the database", async () => {
    const t = opsServer();
    await enrollPhone(t, "Test phone");
    const record = await runDailyBackup(dailyContext(t, { passphrase: () => PASSPHRASE }));
    expect(record).toMatchObject({ file: "belay-2026-11-16.db.enc", ok: true, encrypted: true });
    const dir = backupDir(t.dataDir);
    expect(readdirSync(dir)).toEqual(["belay-2026-11-16.db.enc"]);
    expect(readFileSync(join(dir, "belay-2026-11-16.db.enc")).subarray(0, 8).toString()).toBe("BELAYBAK");
    const out = join(scratchDir(), "plain.db");
    await decryptFile(join(dir, "belay-2026-11-16.db.enc"), out, PASSPHRASE);
    const copy = openCopy(out);
    expect(copy.prepare("SELECT COUNT(*) AS n FROM devices").get()).toEqual({ n: 1 });
    copy.close();
  });

  it("records a failure instead of throwing, says why, and tries again an hour later", async () => {
    const t = opsServer();
    const ctx = dailyContext(t, {
      passphrase: () => {
        throw new Error("Couldn't read BELAY_BACKUP_PASSPHRASE_FILE (/run/secrets/belay_backup): ENOENT.");
      },
    });
    const failed = await runDailyBackup(ctx);
    expect(failed).toMatchObject({ ok: false, encrypted: false, bytes: null, error: "Couldn't read BELAY_BACKUP_PASSPHRASE_FILE (/run/secrets/belay_backup): ENOENT." });
    expect(readdirSync(backupDir(t.dataDir))).toEqual([]);
    expect(t.logs.at(-1)).toBe("The daily backup didn't work: Couldn't read BELAY_BACKUP_PASSPHRASE_FILE (/run/secrets/belay_backup): ENOENT.");
    t.advance(30 * 60_000);
    expect(await runDailyBackup(ctx)).toBeNull();
    t.advance(30 * 60_000);
    expect(await runDailyBackup(dailyContext(t))).toMatchObject({ ok: true });
  });

  it("won't fill the disk: it refuses when too little space would be left", async () => {
    const t = opsServer();
    const record = await runDailyBackup(dailyContext(t, { disk: () => ({ freeBytes: 20e6, totalBytes: 100e9 }) }));
    expect(record).toMatchObject({ ok: false });
    expect(record?.error).toMatch(/^Not enough free disk space: a backup needs about \d+ MB free, and there's 20 MB\.$/);
  });

  it("records a data dir it can't write to", async () => {
    const t = opsServer();
    writeFileSync(backupDir(t.dataDir), "a file where the backups folder should be");
    const record = await runDailyBackup(dailyContext(t));
    expect(record).toMatchObject({ ok: false });
    expect(record?.error).toMatch(/EEXIST|ENOTDIR/);
  });

  it("never runs two at once", async () => {
    const t = opsServer();
    const ctx = dailyContext(t, { passphrase: () => PASSPHRASE });
    const [one, two] = await Promise.all([runDailyBackup(ctx, { force: true }), runDailyBackup(ctx, { force: true })]);
    expect(one).toMatchObject({ ok: true });
    expect(two).toBeNull();
    expect(listBackups(t.deps.db)).toHaveLength(1);
  });

  it("runs from the server's periodic work, with the passphrase from the environment", async () => {
    const t = opsServer();
    await opsTick(t.deps, { env: { BELAY_BACKUP_PASSPHRASE: PASSPHRASE }, scrypt: FAST_SCRYPT });
    expect(latestBackup(t.deps.db)).toMatchObject({ file: "belay-2026-11-16.db.enc", ok: true });
    t.advance(DAY);
    await opsTick(t.deps, { env: { BELAY_BACKUP_PASSPHRASE: "too short" }, scrypt: FAST_SCRYPT });
    expect(latestBackup(t.deps.db)).toMatchObject({ ok: false, error: "BELAY_BACKUP_PASSPHRASE is too short: use at least 15 characters, like four or five random words." });
  });
});

describe("writeBackup", () => {
  it("refuses a file that exists, or a folder that doesn't", async () => {
    const t = opsServer();
    const dir = scratchDir();
    writeFileSync(join(dir, "taken.db"), "keep me");
    await expect(writeBackup(t.deps.db, join(dir, "taken.db"), { passphrase: null })).rejects.toThrow(/already exists/);
    await expect(writeBackup(t.deps.db, join(dir, "nope", "x.db"), { passphrase: null })).rejects.toThrow(/doesn't exist/);
    expect(readFileSync(join(dir, "taken.db"), "utf8")).toBe("keep me");
    expect(readdirSync(dir)).toEqual(["taken.db"]);
  });
});

describe("the backup passphrase", () => {
  it("comes from BELAY_BACKUP_PASSPHRASE or a file (a Docker secret), and must be long enough", () => {
    const dir = scratchDir();
    writeFileSync(join(dir, "secret"), `${PASSPHRASE}\n`);
    writeFileSync(join(dir, "empty"), "");
    expect(backupPassphrase({})).toBeNull();
    expect(backupPassphrase({ BELAY_BACKUP_PASSPHRASE: "" })).toBeNull();
    expect(backupPassphrase({ BELAY_BACKUP_PASSPHRASE: PASSPHRASE })).toBe(PASSPHRASE);
    expect(backupPassphrase({ BELAY_BACKUP_PASSPHRASE_FILE: join(dir, "secret") })).toBe(PASSPHRASE);
    expect(() => backupPassphrase({ BELAY_BACKUP_PASSPHRASE: "short" })).toThrow("BELAY_BACKUP_PASSPHRASE is too short");
    expect(() => backupPassphrase({ BELAY_BACKUP_PASSPHRASE_FILE: join(dir, "missing") })).toThrow(/Couldn't read BELAY_BACKUP_PASSPHRASE_FILE .*ENOENT/);
    expect(() => backupPassphrase({ BELAY_BACKUP_PASSPHRASE_FILE: join(dir, "empty") })).toThrow(/is empty/);
    expect(() => backupPassphrase({ BELAY_BACKUP_PASSPHRASE: PASSPHRASE, BELAY_BACKUP_PASSPHRASE_FILE: join(dir, "secret") })).toThrow(/keep one/);
  });
});
