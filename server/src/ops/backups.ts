/**
 * The server's backups. Once a day, after 2 AM in the family's timezone, the server writes a
 * copy of the database to <data dir>/backups/belay-YYYY-MM-DD.db with `VACUUM INTO` (a
 * consistent copy while it runs), encrypted (`.db.enc`, ./crypt.ts) when the family set a
 * passphrase, and keeps the newest 14. Every try is a row in the backups table: a failure is
 * recorded and retried an hour later, never thrown. One backup runs at a time.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { DB } from "../db.js";
import { getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { dayKey, durations, zoned } from "../time.js";
import { DEFAULT_SCRYPT, encryptFile, type ScryptParams } from "./crypt.js";

/** The daily backup runs from this hour on, in the family's timezone. */
export const BACKUP_HOUR = 2;
export const BACKUPS_KEPT = 14;
/** After a failed daily backup, the next try. */
export const RETRY_MS = durations.HOUR;
/** Free space a backup must leave on the disk, so it can never be what fills it. */
const HEADROOM_BYTES = 64 * 1024 * 1024;
/** The daily job's files: belay-2026-11-17.db, belay-2026-11-17.db.enc, belay-2026-11-17-2.db. */
export const DAILY_FILE = /^belay-(\d{4}-\d{2}-\d{2})(?:-(\d{1,3}))?\.db(\.enc)?$/;
const PARTIAL = /\.partial-[0-9a-f]{12}$/;

export function backupDir(dataDir: string): string {
  return join(dataDir, "backups");
}

// ── Records ─────────────────────────────────────────────────────────────

export interface BackupRecord {
  id: number;
  kind: "daily" | "manual";
  startedAt: number;
  finishedAt: number;
  /** daily: its name in <data dir>/backups; manual: the path the command was given. */
  file: string;
  bytes: number | null;
  dbBytes: number | null;
  encrypted: boolean;
  ok: boolean;
  error: string | null;
}

interface BackupRow {
  id: number;
  kind: "daily" | "manual";
  started_at: number;
  finished_at: number;
  file: string;
  bytes: number | null;
  db_bytes: number | null;
  encrypted: number;
  ok: number;
  error: string | null;
}

const toRecord = (r: BackupRow): BackupRecord => ({
  id: r.id,
  kind: r.kind,
  startedAt: r.started_at,
  finishedAt: r.finished_at,
  file: r.file,
  bytes: r.bytes,
  dbBytes: r.db_bytes,
  encrypted: r.encrypted === 1,
  ok: r.ok === 1,
  error: r.error,
});

/** Records kept: about a year of daily backups, failures and all. */
const RECORDS_KEPT = 400;

export function recordBackup(db: DB, r: Omit<BackupRecord, "id">): BackupRecord {
  return db.transaction(() => {
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO backups (kind, started_at, finished_at, file, bytes, db_bytes, encrypted, ok, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(r.kind, r.startedAt, r.finishedAt, r.file, r.bytes, r.dbBytes, r.encrypted ? 1 : 0, r.ok ? 1 : 0, r.error);
    db.prepare("DELETE FROM backups WHERE id NOT IN (SELECT id FROM backups ORDER BY id DESC LIMIT ?)").run(RECORDS_KEPT);
    return { id: Number(lastInsertRowid), ...r };
  })();
}

/** The newest backup, or the newest daily one, or the newest that worked. */
export function latestBackup(db: DB, filter: { kind?: BackupRecord["kind"]; ok?: boolean } = {}): BackupRecord | null {
  const row = db
    .prepare<{ kind: string | null; ok: number | null }, BackupRow>(
      `SELECT * FROM backups WHERE (@kind IS NULL OR kind = @kind) AND (@ok IS NULL OR ok = @ok) ORDER BY started_at DESC, id DESC LIMIT 1`,
    )
    .get({ kind: filter.kind ?? null, ok: filter.ok === undefined ? null : filter.ok ? 1 : 0 });
  return row ? toRecord(row) : null;
}

export function listBackups(db: DB, limit = 20): BackupRecord[] {
  return db.prepare<[number], BackupRow>("SELECT * FROM backups ORDER BY started_at DESC, id DESC LIMIT ?").all(limit).map(toRecord);
}

// ── The passphrase ──────────────────────────────────────────────────────

export const PASSPHRASE_MIN = 15;

/** Why a passphrase won't do, or null. */
export function passphraseProblem(passphrase: string): string | null {
  return Array.from(passphrase).length < PASSPHRASE_MIN ? `is too short: use at least ${PASSPHRASE_MIN} characters, like four or five random words` : null;
}

/**
 * The passphrase for encrypted backups: BELAY_BACKUP_PASSPHRASE, or the file
 * BELAY_BACKUP_PASSPHRASE_FILE names (a Docker secret; one final new line is ignored). Null
 * when neither is set: backups aren't encrypted. When it's set wrong this throws, in words,
 * and the backup fails rather than quietly being written in the clear.
 */
export function backupPassphrase(env: NodeJS.ProcessEnv): string | null {
  const direct = env.BELAY_BACKUP_PASSPHRASE;
  const path = env.BELAY_BACKUP_PASSPHRASE_FILE?.trim();
  if (path && direct) throw new Error("Both BELAY_BACKUP_PASSPHRASE and BELAY_BACKUP_PASSPHRASE_FILE are set: keep one.");
  let value: string;
  let name = "BELAY_BACKUP_PASSPHRASE";
  if (path) {
    name = `The file BELAY_BACKUP_PASSPHRASE_FILE names (${path})`;
    try {
      value = readFileSync(path, "utf8").replace(/\r?\n$/, "");
    } catch (error) {
      throw new Error(`Couldn't read BELAY_BACKUP_PASSPHRASE_FILE (${path}): ${error instanceof Error && "code" in error ? String(error.code) : "error"}.`, { cause: error });
    }
    if (!value) throw new Error(`${name} is empty.`);
  } else {
    if (!direct) return null;
    value = direct;
  }
  const problem = passphraseProblem(value);
  if (problem) throw new Error(`${name} ${problem}.`);
  return value;
}

// ── Writing one ─────────────────────────────────────────────────────────

/** The database's size: its pages, as this connection sees them (the WAL included). */
export function databaseBytes(db: DB): number {
  return (db.pragma("page_count", { simple: true }) as number) * (db.pragma("page_size", { simple: true }) as number);
}

export interface DiskSpace {
  freeBytes: number;
  totalBytes: number;
}

/** Free and total space on the filesystem that holds `path`, as an unprivileged process can use it. */
export function diskSpace(path: string): DiskSpace {
  const s = statfsSync(path);
  return { freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
}

/** "340 KB", "1.2 MB", "12 GB". */
export function formatBytes(bytes: number): string {
  const units = ["bytes", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} bytes` : `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit] ?? ""}`;
}

export class BackupError extends Error {
  override name = "BackupError";
}

export interface WriteOptions {
  /** Encrypts it with this passphrase; null writes a plain SQLite file. */
  passphrase: string | null;
  scrypt?: ScryptParams;
  /** For tests: the disk's space. */
  disk?: (path: string) => DiskSpace;
}

export interface Written {
  bytes: number;
  dbBytes: number;
  encrypted: boolean;
}

/**
 * Writes a backup of the database to `file`, which must not exist yet: `VACUUM INTO` a
 * temporary file next to it (mode 0600), encrypted into another if there's a passphrase, then
 * renamed, so `file` is never half-written. Refuses when it would leave the disk nearly full.
 */
export async function writeBackup(db: DB, file: string, opts: WriteOptions): Promise<Written> {
  if (existsSync(file)) throw new BackupError(`${file} already exists.`);
  const dir = dirname(file);
  if (!existsSync(dir)) throw new BackupError(`The folder ${dir} doesn't exist.`);
  const dbBytes = databaseBytes(db);
  const disk = (opts.disk ?? diskSpace)(dir);
  const needed = dbBytes * (opts.passphrase === null ? 1 : 2) + HEADROOM_BYTES;
  if (disk.freeBytes < needed) {
    throw new BackupError(`Not enough free disk space: a backup needs about ${formatBytes(needed)} free, and there's ${formatBytes(disk.freeBytes)}.`);
  }
  const partial = () => `${file}.partial-${randomBytes(6).toString("hex")}`;
  const plain = partial();
  try {
    db.prepare("VACUUM INTO ?").run(plain);
    chmodSync(plain, 0o600);
    if (opts.passphrase === null) {
      renameSync(plain, file);
    } else {
      const sealed = partial();
      try {
        await encryptFile(plain, sealed, opts.passphrase, opts.scrypt ?? DEFAULT_SCRYPT);
        renameSync(sealed, file);
      } finally {
        rmSync(sealed, { force: true });
      }
    }
  } finally {
    rmSync(plain, { force: true });
  }
  return { bytes: statSync(file).size, dbBytes, encrypted: opts.passphrase !== null };
}

// ── The daily job ───────────────────────────────────────────────────────

/** Whether the daily backup should run now: after 2 AM, none worked today, and no failed try in the last hour. */
export function dailyBackupDue(db: DB, now: number): boolean {
  const tz = getSettings(db).timezone;
  if (zoned(now, tz).hour < BACKUP_HOUR) return false;
  const worked = latestBackup(db, { kind: "daily", ok: true });
  if (worked && dayKey(worked.startedAt, tz) === dayKey(now, tz)) return false;
  const last = latestBackup(db, { kind: "daily" });
  return !(last && !last.ok && now - last.startedAt >= 0 && now - last.startedAt < RETRY_MS);
}

/** Today's name, or belay-<day>-2.db and so on when one is there already (say, after a restore): no backup is overwritten. */
function freeName(dir: string, day: string, encrypted: boolean): string {
  for (let n = 1; n < 1000; n++) {
    const base = n === 1 ? `belay-${day}` : `belay-${day}-${n}`;
    if (!existsSync(join(dir, `${base}.db`)) && !existsSync(join(dir, `${base}.db.enc`))) return `${base}.db${encrypted ? ".enc" : ""}`;
  }
  throw new BackupError("There are too many backups from today already.");
}

/** Deletes all but the newest `keep` of the daily job's files, and temporary files left over from a crash. */
export function pruneBackups(dir: string, keep = BACKUPS_KEPT): string[] {
  // File times come from the filesystem's clock, so their age does too.
  const now = Date.now();
  const names = readdirSync(dir);
  const daily = names
    .flatMap((name) => {
      const match = DAILY_FILE.exec(name);
      return match?.[1] ? [{ name, day: match[1], n: Number(match[2] ?? 1) }] : [];
    })
    .sort((a, b) => b.day.localeCompare(a.day) || b.n - a.n);
  const removed = daily.slice(keep).map((f) => f.name);
  for (const name of removed) rmSync(join(dir, name), { force: true });
  for (const name of names) {
    if (!PARTIAL.test(name)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > durations.HOUR) rmSync(join(dir, name), { force: true });
    } catch {
      // Gone already.
    }
  }
  return removed;
}

export interface DailyContext {
  db: DB;
  dataDir: string;
  now: () => number;
  /** The passphrase (backupPassphrase); a throw fails the backup, with its words recorded. */
  passphrase: () => string | null;
  log: (message: string) => void;
  scrypt?: ScryptParams;
  disk?: (path: string) => DiskSpace;
}

const running = new WeakSet<DB>();

function reason(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error), 300) || "unknown error";
}

/**
 * Makes today's backup if it's due (or `force`), keeps the newest 14, and records the result.
 * Never throws; returns the record, or null when nothing ran (not due, or one is running).
 */
export async function runDailyBackup(ctx: DailyContext, opts: { force?: boolean } = {}): Promise<BackupRecord | null> {
  const { db } = ctx;
  if (ctx.dataDir === ":memory:" || running.has(db)) return null;
  const startedAt = ctx.now();
  if (!opts.force && !dailyBackupDue(db, startedAt)) return null;
  running.add(db);
  const day = dayKey(startedAt, getSettings(db).timezone);
  let file = `belay-${day}.db`;
  let encrypted = false;
  try {
    const dir = backupDir(ctx.dataDir);
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const passphrase = ctx.passphrase();
      encrypted = passphrase !== null;
      file = freeName(dir, day, encrypted);
      const made = await writeBackup(db, join(dir, file), { passphrase, scrypt: ctx.scrypt, disk: ctx.disk });
      const record = recordBackup(db, { kind: "daily", startedAt, finishedAt: ctx.now(), file, bytes: made.bytes, dbBytes: made.dbBytes, encrypted, ok: true, error: null });
      pruneBackups(dir);
      ctx.log(`Backed up the database to backups/${file} (${formatBytes(made.bytes)}${encrypted ? ", encrypted" : ""}).`);
      return record;
    } catch (error) {
      const why = reason(error);
      ctx.log(`The daily backup didn't work: ${why}`);
      let dbBytes: number | null = null;
      try {
        dbBytes = databaseBytes(db);
      } catch {
        // Recorded without it.
      }
      return recordBackup(db, { kind: "daily", startedAt, finishedAt: ctx.now(), file, bytes: null, dbBytes, encrypted, ok: false, error: why });
    }
  } catch (error) {
    ctx.log(`Couldn't record the daily backup's result: ${reason(error)}`);
    return null;
  } finally {
    running.delete(db);
  }
}
