/**
 * Where the demo keeps its made-up family (docs/demo.md): a new temporary directory by default, or
 * one given with --dir to keep between runs. The demo marks what it makes (a marker file, and a
 * row in the database's settings with the same id), and refuses a directory it didn't make before
 * it opens anything in it, so it can never touch a real family's data.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import Database from "better-sqlite3";
import type { DB } from "../src/db.js";

export const MARKER_FILE = "belay-demo.json";
/** The server's database file (src/db.ts). */
export const DB_FILE = "belay.db";
/** The simulated phone's state, and the demo's own (the personal access token it printed). */
export const PHONE_FILE = "demo-phone.json";
export const STATE_FILE = "demo-state.json";
/** The settings row that marks a database as the demo's. */
export const SETTING = "demo";

/** The directory isn't one the demo made: nothing in it was opened or changed. */
export class NotADemoDir extends Error {
  override name = "NotADemoDir";
}

export interface DemoDir {
  path: string;
  /** A new temporary directory, deleted when the demo stops. */
  temp: boolean;
  /** No database yet: the demo makes its family. */
  fresh: boolean;
  /** The id in the marker file, and in the database's settings. */
  id: string;
}

interface Marker {
  belay_demo: true;
  id: string;
  made_at: number;
}

function readMarker(dir: string): Marker | null {
  try {
    const value = JSON.parse(readFileSync(join(dir, MARKER_FILE), "utf8")) as Partial<Marker> | null;
    return value?.belay_demo === true && typeof value.id === "string" && /^[0-9a-f]{32}$/.test(value.id) && typeof value.made_at === "number"
      ? { belay_demo: true, id: value.id, made_at: value.made_at }
      : null;
  } catch {
    return null;
  }
}

/** Marks a directory as the demo's, and keeps git out of it (a contributor may make it inside the repository). */
function mark(dir: string, now: number): string {
  const id = randomBytes(16).toString("hex");
  const marker: Marker = { belay_demo: true, id, made_at: now };
  writeFileSync(join(dir, ".gitignore"), "# Made by npm run demo (server/demo): a made-up family. Never commit it.\n*\n", { mode: 0o600 });
  writeFileSync(join(dir, MARKER_FILE), `${JSON.stringify({ ...marker, about: "Made by Belay's npm run demo: a made-up family, nothing real. Safe to delete." }, null, 2)}\n`, { mode: 0o600 });
  return id;
}

/**
 * The demo id a database carries in its settings; null for any other database. It reads a copy, in
 * a temporary directory of its own: even a read-only open of a database in WAL mode leaves -shm and
 * -wal files beside it, and nothing may be added next to a database that may be a real family's.
 */
function demoIdOf(dir: string): string | null {
  const scratch = mkdtempSync(join(tmpdir(), "belay-demo-check-"));
  let db: Database.Database | null = null;
  try {
    for (const name of [DB_FILE, `${DB_FILE}-wal`]) {
      if (existsSync(join(dir, name))) copyFileSync(join(dir, name), join(scratch, name));
    }
    db = new Database(join(scratch, DB_FILE), { fileMustExist: true });
    const row = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(SETTING);
    const value = row ? (JSON.parse(row.value) as { id?: unknown }) : null;
    return typeof value?.id === "string" ? value.id : null;
  } catch {
    return null;
  } finally {
    db?.close();
    rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * The demo's directory: a new temporary one (`dir` null), a new or empty one, or one the demo made
 * before (its marker file, and a database whose settings carry the same id). Anything else is
 * refused (NotADemoDir) before anything in it is opened, so a real family's data directory, or
 * any other folder with files in it, is never touched.
 */
export function openDemoDir(dir: string | null, now = Date.now()): DemoDir {
  if (dir === null) {
    const path = mkdtempSync(join(tmpdir(), "belay-demo-"));
    return { path, temp: true, fresh: true, id: mark(path, now) };
  }
  const path = resolve(dir);
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return { path, temp: false, fresh: true, id: mark(path, now) };
  }
  if (!statSync(path).isDirectory()) throw new NotADemoDir(`${path} isn't a directory. Give --dir a new directory, or one the demo made before.`);
  const names = readdirSync(path);
  const marker = readMarker(path);
  if (!marker) {
    if (names.length === 0) return { path, temp: false, fresh: true, id: mark(path, now) };
    throw new NotADemoDir(
      names.includes(DB_FILE)
        ? `${path} holds a Belay database the demo didn't make: it may be a real family's, so the demo won't open it. Give --dir a new directory.`
        : `${path} has files in it, and the demo didn't make it, so the demo won't use it. Give --dir a new directory, or one the demo made before.`,
    );
  }
  if (!names.includes(DB_FILE)) {
    // Marked, but its database never got made (a run stopped early): start again, without the old phone.
    for (const stale of [PHONE_FILE, STATE_FILE]) rmSync(join(path, stale), { force: true });
    return { path, temp: false, fresh: true, id: marker.id };
  }
  if (demoIdOf(path) !== marker.id) {
    throw new NotADemoDir(`${path} has the demo's marker, but its database isn't the one the demo made there, so the demo won't open it. Give --dir a new directory.`);
  }
  return { path, temp: false, fresh: false, id: marker.id };
}

/** Marks a new database as the demo's, with the directory's id: openDemoDir checks it before opening the database again. */
export function markDatabase(db: DB, id: string, now: number): void {
  // No function of the server's keeps a row like this: it's the demo's own, like setup_token or vapid.
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING").run(SETTING, JSON.stringify({ id, made_at: now, by: "npm run demo" }));
}

/** Reads one of the demo's JSON files, or null. */
export function readJson(dir: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, name), "utf8")) as unknown;
  } catch {
    return null;
  }
}

/** Writes one of the demo's JSON files, all at once: it holds a token, so only its owner reads it. */
export function writeJson(dir: string, name: string, value: unknown): void {
  const file = join(dir, name);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value)}\n`, { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
}
