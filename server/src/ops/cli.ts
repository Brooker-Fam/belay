/**
 * The backup commands (docs/server.md, "Backups"):
 *
 *   backup <file> [--encrypt]     a consistent copy of the database, while it runs; --encrypt seals it with the backup passphrase
 *   verify-backup <file>          proves a backup restores: checks a private copy and counts what's in it
 *   restore [--drill] <file>      puts a checked backup in place, in a data dir without a database
 *   restore-drill                 the steps of a restore drill, for the newest backup
 *
 * verify-backup and restore also take "-" for a backup on stdin, and run before the CLI opens
 * the live database (cli.ts): they work on a computer without a server, and without
 * BELAY_PUBLIC_URL. verify-backup records "last verified" in the server's database when the
 * backup is in the server's data dir.
 */
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { CliIO } from "../admin.js";
import { audit } from "../audit.js";
import { type DB, openDatabase } from "../db.js";
import { getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { formatAgo, formatDateTime, offsetLabel } from "../time.js";
import {
  DAILY_FILE,
  backupDir,
  backupPassphrase,
  formatBytes,
  latestBackup,
  latestCheck,
  passphraseProblem,
  recordBackup,
  recordCheck,
  writeBackup,
  type BackupRecord,
} from "./backups.js";
import { RestoreError, restoreBackup, verifyBackup, type VerifyReport } from "./verify.js";
import { dayAndTime, plural } from "./words.js";

/** What verify-backup and restore need, run before the CLI opens the live database. */
export interface OfflineIO {
  env: NodeJS.ProcessEnv;
  now: number;
  out: (line: string) => void;
  err: (line: string) => void;
  readSecret: (prompt: string) => Promise<string>;
  interactive: boolean;
  stdin: NodeJS.ReadableStream;
}

type CommonIO = Omit<OfflineIO, "stdin"> & { stdin?: NodeJS.ReadableStream };

class CommandError extends Error {}

function parse(args: string[]): { positional: string[]; flags: Set<string> } {
  const positional: string[] = [];
  const flags = new Set<string>();
  for (const arg of args) {
    if (arg.startsWith("--")) flags.add(arg.slice(2));
    else positional.push(arg);
  }
  return { positional, flags };
}

function message(error: unknown): string {
  return oneLine(error instanceof Error ? error.message : String(error), 300);
}

/** The passphrase to read an encrypted backup: the server's own setting, or asked for. */
function readingPassphrase(io: CommonIO, fromStdin: boolean): () => Promise<string> {
  return async () => {
    const set = backupPassphrase(io.env);
    if (set !== null) return set;
    if (fromStdin) throw new Error("It's encrypted, and it's coming in on stdin: set BELAY_BACKUP_PASSPHRASE (or BELAY_BACKUP_PASSPHRASE_FILE) to its passphrase.");
    return io.readSecret("The backup's passphrase: ");
  };
}

/** The passphrase to encrypt a backup with: the server's own setting, or a new one, asked twice at a terminal. */
async function writingPassphrase(io: CommonIO): Promise<string> {
  let set: string | null;
  try {
    set = backupPassphrase(io.env);
  } catch (error) {
    throw new CommandError(message(error));
  }
  if (set !== null) return set;
  const passphrase = await io.readSecret("A passphrase for this backup: ");
  if (io.interactive && (await io.readSecret("The same passphrase again: ")) !== passphrase) throw new CommandError("The two passphrases don't match.");
  const problem = passphraseProblem(passphrase);
  if (problem) throw new CommandError(`That passphrase ${problem}.`);
  return passphrase;
}

function sameFile(a: string, b: string): boolean {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

function inside(file: string, dir: string): boolean {
  try {
    const rel = relative(realpathSync(dir), realpathSync(file));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** The report, in plain words: the verdict, then what was found. */
export function reportLines(name: string, r: VerifyReport): string[] {
  const lines = [r.ok ? `${name}: it restores.` : `${name}: it does NOT restore. ${r.problem ?? ""}`.trimEnd()];
  const read = r.integrity !== null;
  if (r.encrypted && read) lines.push("  Encrypted: yes, and the passphrase works.");
  if (!r.encrypted && read) lines.push("  Encrypted: no.");
  if (read) lines.push(`  Integrity: ${r.integrity === "ok" ? "ok" : (r.integrity ?? "")}.`);
  if (r.schema) {
    const { version, server, upgraded } = r.schema;
    lines.push(
      version === server
        ? `  Schema: version ${version}, the same as this server.`
        : upgraded
          ? `  Schema: version ${version}, older than this server's ${server}: the upgrade worked, on a copy.`
          : `  Schema: version ${version}; this server's is ${server}.`,
    );
  }
  if (r.counts) {
    const { phones, disconnected, apps, parents } = r.counts;
    lines.push(`  In it: ${plural(phones, "phone")}${disconnected ? ` (${disconnected} disconnected)` : ""}, ${plural(apps, "app")}, ${plural(parents, "parent")}.`);
  }
  if (r.newestAt !== null && r.timezone) lines.push(`  Newest data: ${formatDateTime(r.newestAt, r.timezone)} (${offsetLabel(r.newestAt, r.timezone)}).`);
  if (r.bytes) lines.push(`  Size: ${formatBytes(r.bytes)}.`);
  return lines;
}

function print(io: CommonIO, lines: string[], ok: boolean): void {
  for (const line of lines) (ok ? io.out : io.err)(line);
}

type WithServerDb = (use: (db: DB) => void) => void;

async function verifyCommand(args: string[], io: CommonIO, dataDir: string, withServerDb: WithServerDb): Promise<number> {
  const { positional, flags } = parse(args);
  const input = positional[0];
  if (!input || positional.length > 1 || flags.size) throw new CommandError("Usage: verify-backup <file>, or - for a backup on stdin");
  const fromStdin = input === "-";
  if (fromStdin && !io.stdin) throw new CommandError("Usage: verify-backup <file>");
  if (!fromStdin && sameFile(input, join(dataDir, "belay.db"))) {
    throw new CommandError("That's the live database, not a backup. Make a backup first (backup <file>), then check that.");
  }
  const report = await verifyBackup(fromStdin && io.stdin ? io.stdin : input, { now: io.now, passphrase: readingPassphrase(io, fromStdin) });
  print(io, reportLines(fromStdin ? "The backup on stdin" : input, report), report.ok);
  if (!fromStdin && inside(input, dataDir)) {
    withServerDb((db) => {
      const file = basename(input);
      recordCheck(db, { kind: "verify", at: io.now, file, ok: report.ok, detail: { problem: report.problem, encrypted: report.encrypted, schema: report.schema, counts: report.counts, newest_at: report.newestAt }, parentId: null });
      audit(db, io.now, { kind: "server" }, "backup.verified", { detail: { file, ok: report.ok, ...(report.problem ? { problem: report.problem } : {}) } });
      io.out("Recorded as this server's latest backup check.");
    });
  }
  return report.ok ? 0 : 1;
}

async function restoreCommand(args: string[], io: OfflineIO, dataDir: string): Promise<number> {
  const { positional, flags } = parse(args);
  const input = positional[0];
  if (!input || positional.length > 1 || [...flags].some((f) => f !== "drill")) throw new CommandError("Usage: restore [--drill] <file>, or - for a backup on stdin");
  const fromStdin = input === "-";
  const drill = flags.has("drill");
  let report: VerifyReport;
  try {
    report = await restoreBackup(fromStdin ? io.stdin : input, dataDir, { now: io.now, passphrase: readingPassphrase(io, fromStdin), drill, name: fromStdin ? null : basename(input) });
  } catch (error) {
    if (error instanceof RestoreError) throw new CommandError(error.message);
    throw error;
  }
  print(io, reportLines(fromStdin ? "The backup on stdin" : input, report), report.ok);
  if (!report.ok) {
    io.err("Nothing was restored.");
    return 1;
  }
  io.out(`Restored to ${join(dataDir, "belay.db")}${drill ? ", as a restore drill's copy: it sends no notifications" : ""}. Start the server.`);
  return 0;
}

/** verify-backup and restore, before the CLI opens the live database. Null: not one of them. */
export async function runOfflineCommand(argv: string[], io: OfflineIO): Promise<number | null> {
  const [command, ...args] = argv;
  if (command !== "verify-backup" && command !== "restore") return null;
  // As config.ts reads it.
  const dataDir = io.env.BELAY_DATA_DIR?.trim() || "./data";
  try {
    if (command === "restore") return await restoreCommand(args, io, dataDir);
    return await verifyCommand(args, io, dataDir, (use) => {
      if (!existsSync(join(dataDir, "belay.db"))) return;
      try {
        const db = openDatabase(dataDir);
        try {
          use(db);
        } finally {
          db.close();
        }
      } catch (error) {
        io.err(`Couldn't record it in the server's database: ${message(error)}`);
      }
    });
  } catch (error) {
    if (error instanceof CommandError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function backupCommand(args: string[], io: CliIO, env: NodeJS.ProcessEnv): Promise<number> {
  const { positional, flags } = parse(args);
  const file = positional[0];
  if (!file || positional.length > 1 || [...flags].some((f) => f !== "encrypt")) {
    throw new CommandError("Usage: backup <file> [--encrypt], for example backup /data/belay-backup.db");
  }
  if (existsSync(file)) throw new CommandError(`${file} already exists. Pick a new name.`);
  const passphrase = flags.has("encrypt") ? await writingPassphrase({ ...io, env }) : null;
  const path = resolve(file);
  const record = (r: Pick<BackupRecord, "bytes" | "dbBytes" | "encrypted" | "ok" | "error">) =>
    recordBackup(io.db, { kind: "manual", startedAt: io.now, finishedAt: io.now, file: path, ...r });
  try {
    const made = await writeBackup(io.db, path, { passphrase });
    record({ bytes: made.bytes, dbBytes: made.dbBytes, encrypted: made.encrypted, ok: true, error: null });
    io.out(
      made.encrypted
        ? `Backed up to ${file} (${formatBytes(made.bytes)}), encrypted. Keep the passphrase somewhere safe, like a password manager: without it nobody can read this backup, you included.`
        : `Backed up to ${file} (${formatBytes(made.bytes)}). It holds the family's data: keep it as private as the server, or use --encrypt for a copy that leaves this machine.`,
    );
    return 0;
  } catch (error) {
    const why = message(error);
    record({ bytes: null, dbBytes: null, encrypted: passphrase !== null, ok: false, error: why });
    io.err(`The backup didn't work: ${why}`);
    return 1;
  }
}

/** The newest of the daily job's files in the backups folder. */
function newestDailyFile(dir: string): string | null {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const daily = names
    .flatMap((name) => {
      const match = DAILY_FILE.exec(name);
      return match?.[1] ? [{ name, day: match[1], n: Number(match[2] ?? 1) }] : [];
    })
    .sort((a, b) => b.day.localeCompare(a.day) || b.n - a.n);
  return daily[0]?.name ?? null;
}

/** The steps of a restore drill (docs/server.md, "Restore drill"), for one backup in the server's backups folder. */
export function drillSteps(path: string, encrypted: boolean): string[] {
  const name = basename(path);
  return [
    "1. Check it here (it asks for the passphrase of an encrypted one):",
    `     docker compose exec belay node dist/cli.js verify-backup ${path}`,
    "2. Copy it to the computer for the drill (this one will do), from the folder with docker-compose.yml:",
    `     docker compose cp belay:${path} .`,
    "3. There, from the server folder of Belay's code, restore it into a scratch server on its own volume:",
    "     docker build -t belay-server .",
    "     docker volume create belay-drill",
    ...(encrypted
      ? [
          "     read -rs BELAY_BACKUP_PASSPHRASE && export BELAY_BACKUP_PASSPHRASE",
          `     docker run --rm -i -e BELAY_BACKUP_PASSPHRASE -v belay-drill:/data belay-server node dist/cli.js restore --drill - < ${name}`,
        ]
      : [`     docker run --rm -i -v belay-drill:/data belay-server node dist/cli.js restore --drill - < ${name}`]),
    "     docker run -d --name belay-drill -p 127.0.0.1:8081:8080 -e BELAY_PUBLIC_URL=http://localhost:8081 -v belay-drill:/data belay-server",
    "4. Open http://localhost:8081 there, sign in with your usual username and password, and check that the phones are there.",
    "5. Clean up:",
    `     docker rm -f belay-drill && docker volume rm belay-drill && rm ${name}`,
    '6. On the parent page, under "This server" on the Phones page, choose "We did a restore drill".',
  ];
}

function drillCommand(io: CliIO): number {
  const { db, now } = io;
  const tz = getSettings(db).timezone;
  const dir = backupDir(io.config.dataDir);
  const name = newestDailyFile(dir);
  io.out("A restore drill proves the backups work: restore the newest one into a scratch server, sign in, and see the phones. Do one every 3 months.");
  io.out("");
  if (!name) {
    io.err(`There's no backup in ${dir} yet. The server makes one every day after 2 AM; or make one now with: backup ${join(dir, "belay-now.db")}`);
    return 1;
  }
  const made = latestBackup(db, { kind: "daily", ok: true });
  const encrypted = name.endsWith(".enc");
  const about = made?.file === name ? ` (${dayAndTime(made.startedAt, now, tz)}${made.bytes !== null ? `, ${formatBytes(made.bytes)}` : ""}${encrypted ? ", encrypted" : ""})` : encrypted ? " (encrypted)" : "";
  const drill = latestCheck(db, "drill");
  const verified = latestCheck(db, "verify");
  io.out(`The newest backup: ${join(dir, name)}${about}.`);
  io.out(
    `Last restore drill: ${drill ? formatAgo(drill.at, now) : "never"}. Last check with verify-backup: ${verified ? `${formatAgo(verified.at, now)}${verified.ok ? "" : ", and it failed"}` : "never"}.`,
  );
  io.out("");
  for (const line of drillSteps(join(dir, name), encrypted)) io.out(line);
  return 0;
}

/** backup, verify-backup and restore-drill, with the live database open (admin.ts). Null: not one of them. */
export async function runOpsCommand(argv: string[], io: CliIO, env: NodeJS.ProcessEnv = process.env): Promise<number | null> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "backup":
        return await backupCommand(args, io, env);
      case "verify-backup":
        return await verifyCommand(args, { ...io, env, stdin: process.stdin }, io.config.dataDir, (use) => {
          use(io.db);
        });
      case "restore-drill":
        return drillCommand(io);
      default:
        return null;
    }
  } catch (error) {
    if (error instanceof CommandError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}
