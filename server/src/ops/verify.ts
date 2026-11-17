/**
 * Proving a backup restores. verify-backup copies it into a private temporary folder
 * (decrypting an encrypted one there), opens the copy read-only, runs PRAGMA integrity_check,
 * compares its schema with this server's migrations (an older one is upgraded, on the copy,
 * to show the upgrade works), and counts the phones, apps and parents in it with the server's
 * own code. restore does the same, then moves the checked copy into an empty data dir. The
 * backup itself is only ever read.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, constants, copyFileSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import Database from "better-sqlite3";
import { audit } from "../audit.js";
import { type DB, loadMigrations, migrate, openDatabase } from "../db.js";
import { appCounts } from "../family/apps.js";
import { listDevices } from "../family/devices.js";
import { getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { BackupCryptoError, decryptFile, fileKind } from "./crypt.js";

export interface VerifyReport {
  ok: boolean;
  /** The first thing that failed, in words; null when it restores. */
  problem: string | null;
  encrypted: boolean;
  bytes: number;
  /** "ok", or what PRAGMA integrity_check found. */
  integrity: string | null;
  /** The backup's schema version, this server's, and whether the copy was upgraded to it. */
  schema: { version: number; server: number; upgraded: boolean } | null;
  counts: { phones: number; disconnected: number; apps: number; parents: number } | null;
  /** The newest time recorded in it (a check-in, an app change, the activity log). */
  newestAt: number | null;
  /** The family's timezone, as the backup has it. */
  timezone: string | null;
}

export interface CheckOptions {
  /** Asked for only when the backup is encrypted. A throw is the report's problem. */
  passphrase: () => Promise<string>;
  now: number;
}

/** The schema this server's migrations make. */
export function serverSchema(): number {
  return loadMigrations().at(-1)?.version ?? 0;
}

const BELAY_TABLES = ["settings", "parents", "devices", "apps", "audit_log"];

function message(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error), 300);
}

function newestAt(db: DB): number | null {
  const row = db
    .prepare<[], { at: number | null }>(
      `SELECT MAX(at) AS at FROM (
         SELECT MAX(at) AS at FROM audit_log
         UNION ALL SELECT MAX(received_at) FROM app_events
         UNION ALL SELECT MAX(last_seen_at) FROM devices
         UNION ALL SELECT MAX(received_at) FROM snapshots)`,
    )
    .get();
  return row?.at ?? null;
}

/**
 * Checks `file` in `work`, a private folder the caller made and deletes. On success the checked
 * (and possibly upgraded) copy is `work/belay.db`.
 */
async function check(file: string, work: string, opts: CheckOptions): Promise<VerifyReport> {
  const report: VerifyReport = { ok: false, problem: null, encrypted: false, bytes: 0, integrity: null, schema: null, counts: null, newestAt: null, timezone: null };
  const fail = (problem: string): VerifyReport => {
    report.problem = problem;
    return report;
  };
  let size: number;
  try {
    const st = statSync(file);
    if (!st.isFile()) return fail(`${file} isn't a file.`);
    size = st.size;
  } catch {
    return fail(`There's no file at ${file}.`);
  }
  report.bytes = size;
  const copy = join(work, "belay.db");
  const kind = await fileKind(file);
  if (kind === "other") return fail("This isn't a Belay backup: it's neither a database nor an encrypted backup.");
  report.encrypted = kind === "encrypted";
  let passphrase = "";
  if (report.encrypted) {
    try {
      passphrase = await opts.passphrase();
    } catch (error) {
      return fail(message(error));
    }
  }
  try {
    if (report.encrypted) {
      await decryptFile(file, copy, passphrase);
    } else {
      copyFileSync(file, copy, constants.COPYFILE_EXCL);
      chmodSync(copy, 0o600);
    }
  } catch (error) {
    if (error instanceof BackupCryptoError) return fail(error.message);
    return fail(`Couldn't copy it into a temporary folder to check it: ${message(error)}`);
  }

  let db: DB | null = null;
  try {
    db = new Database(copy, { readonly: true, fileMustExist: true });
    const found = (db.pragma("integrity_check(20)") as { integrity_check: string }[]).map((r) => r.integrity_check);
    report.integrity = found.join("; ").slice(0, 1000);
    if (found.length !== 1 || found[0] !== "ok") return fail(`The database in it is damaged: ${oneLine(found[0] ?? "no answer", 200)}`);

    const version = db.pragma("user_version", { simple: true }) as number;
    const tables = new Set(db.prepare<[], { name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name));
    if (version === 0 || BELAY_TABLES.some((t) => !tables.has(t))) return fail("It's a database, but not Belay's.");
    const server = serverSchema();
    report.schema = { version, server, upgraded: false };
    if (version > server) return fail(`It's from a newer Belay (schema ${version}; this server knows ${server}): restore it with a server at least that new.`);
    if (version < server) {
      db.close();
      db = new Database(copy, { fileMustExist: true });
      try {
        migrate(db);
      } catch (error) {
        return fail(`Upgrading it from schema ${version} to ${server} failed, on the copy: ${message(error)}`);
      }
      report.schema.upgraded = true;
    }

    // Read with the server's own code, as the parent page would.
    const settings = getSettings(db);
    const phones = listDevices(db, settings, opts.now);
    const parents = db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM parents").get()?.n ?? 0;
    report.counts = {
      phones: phones.length,
      disconnected: phones.filter((p) => p.revokedAt !== null).length,
      apps: phones.reduce((n, p) => n + appCounts(db as DB, p.id).userApps, 0),
      parents,
    };
    report.timezone = settings.timezone;
    report.newestAt = newestAt(db);
    report.ok = true;
    return report;
  } catch (error) {
    const code = error instanceof Error && "code" in error ? String(error.code) : "";
    if (code.startsWith("SQLITE_CORRUPT") || code === "SQLITE_NOTADB") return fail(`The database in it is damaged: ${message(error)}`);
    return fail(`It can't be read as a database: ${message(error)}`);
  } finally {
    db?.close();
  }
}

function workDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belay-backup-"));
  chmodSync(dir, 0o700);
  return dir;
}

/** Saves a stream (a backup read from stdin) into `work`, for checking like a file. */
export async function saveInput(input: NodeJS.ReadableStream, work: string): Promise<string> {
  const file = join(work, "input");
  await pipeline(input, createWriteStream(file, { flags: "wx", mode: 0o600 }));
  return file;
}

/** verify-backup: checks a backup file (or a stream) and deletes everything it made. */
export async function verifyBackup(input: string | NodeJS.ReadableStream, opts: CheckOptions): Promise<VerifyReport> {
  const work = workDir();
  try {
    const file = typeof input === "string" ? input : await saveInput(input, work);
    return await check(file, work, opts);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export class RestoreError extends Error {
  override name = "RestoreError";
}

export interface RestoreOptions extends CheckOptions {
  /** A restore drill's scratch copy: it sends no notifications, and its parent page says so. */
  drill: boolean;
  /** The backup's file name, like "belay-2026-11-17.db.enc", for the activity log; null when it came on stdin. */
  name: string | null;
}

export const DRILL_KEY = "drill_copy";

/** A scratch copy made for a restore drill, and when: it sends no notifications. */
export function drillCopy(db: DB): { at: number; from: string | null } | null {
  const row = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(DRILL_KEY);
  if (!row) return null;
  try {
    const value = JSON.parse(row.value) as { at?: unknown; from?: unknown };
    return typeof value.at === "number" ? { at: value.at, from: typeof value.from === "string" ? value.from : null } : null;
  } catch {
    return null;
  }
}

/**
 * restore: checks the backup, then puts the checked copy at <data dir>/belay.db. Only into a
 * data dir without a database, so it can't overwrite the family's data by mistake. The
 * restored database records it in its activity log.
 */
export async function restoreBackup(input: string | NodeJS.ReadableStream, dataDir: string, opts: RestoreOptions): Promise<VerifyReport> {
  const target = join(dataDir, "belay.db");
  const occupied = () => [target, `${target}-wal`, `${target}-shm`].some((f) => existsSync(f));
  if (occupied()) {
    throw new RestoreError(
      `There's a database in ${dataDir} already. restore only writes where there's none, so it can't overwrite the family's data by mistake. To replace it: stop the server, move belay.db (and belay.db-wal and belay.db-shm, if they're there) somewhere safe, then run restore again.`,
    );
  }
  const work = workDir();
  try {
    const file = typeof input === "string" ? input : await saveInput(input, work);
    const report = await check(file, work, opts);
    if (!report.ok) return report;
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    const partial = join(dataDir, `belay.db.restoring-${randomBytes(6).toString("hex")}`);
    try {
      copyFileSync(join(work, "belay.db"), partial, constants.COPYFILE_EXCL);
      chmodSync(partial, 0o600);
      if (occupied()) throw new RestoreError(`A database appeared in ${dataDir} while restoring: nothing was changed.`);
      renameSync(partial, target);
    } finally {
      rmSync(partial, { force: true });
    }
    const db = openDatabase(dataDir);
    try {
      if (opts.drill) {
        db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(
          DRILL_KEY,
          JSON.stringify({ at: opts.now, from: opts.name }),
        );
      }
      audit(db, opts.now, { kind: "server" }, "backup.restored", { detail: { ...(opts.name ? { file: opts.name } : {}), drill: opts.drill } });
    } finally {
      db.close();
    }
    return report;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
