import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";

export type DB = Database.Database;

const MIGRATIONS_DIR = new URL("./migrations/", import.meta.url);

interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** `NNN_name.sql` files in src/migrations, in order. */
export function loadMigrations(): Migration[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith(".sql"))
    .map((file) => {
      const match = /^(\d+)_([\w-]+)\.sql$/.exec(file);
      if (!match?.[1] || !match[2]) throw new Error(`Migration file name must be NNN_name.sql: ${file}`);
      return { version: Number(match[1]), name: match[2], sql: readFileSync(new URL(file, MIGRATIONS_DIR), "utf8") };
    })
    .sort((a, b) => a.version - b.version);
}

/** A migration failed. Its transaction rolled back: the database is still at the version before it. */
export class MigrationError extends Error {
  override name = "MigrationError";
  constructor(
    readonly version: number,
    readonly migration: string,
    cause: unknown,
  ) {
    super(`Migration ${version} (${migration}) failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
  }
}

/** Applies every migration newer than the database's `user_version`, each in its own transaction. */
export function migrate(db: DB, migrations: Migration[] = loadMigrations()): number[] {
  const current = db.pragma("user_version", { simple: true }) as number;
  const latest = migrations.at(-1)?.version ?? 0;
  if (current > latest) {
    throw new Error(`The database is from a newer Belay (schema ${current}; this one knows ${latest}). Upgrade the server instead.`);
  }
  const applied: number[] = [];
  for (const migration of migrations) {
    if (migration.version <= current) continue;
    try {
      db.transaction(() => {
        db.exec(migration.sql);
        db.pragma(`user_version = ${migration.version}`);
      })();
    } catch (error) {
      throw new MigrationError(migration.version, migration.name, error);
    }
    applied.push(migration.version);
  }
  return applied;
}

/** Opens (creating if needed) the database in `dataDir`, or an in-memory one for ":memory:". */
export function openDatabase(dataDir: string): DB {
  let file = ":memory:";
  if (dataDir !== ":memory:") {
    mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = join(dataDir, "belay.db");
  }
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}
