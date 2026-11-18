/**
 * npm run demo's directory (docs/demo.md): a new temporary one, or one given with --dir that's new,
 * empty or the demo's own, and never any other, refused before anything in it is opened, so the
 * demo can't touch a real family's data. Made-up data only.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { openDatabase } from "../src/db.js";
import { DB_FILE, MARKER_FILE, NotADemoDir, PHONE_FILE, STATE_FILE, markDatabase, openDemoDir } from "../demo/dir.js";
import { T0 } from "./helpers.js";

describe("the demo's directory", () => {
  const root = mkdtempSync(join(tmpdir(), "belay-demo-test-"));
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  /** Each file's name and contents: a refusal changes none and adds none. */
  const snapshot = (dir: string) =>
    readdirSync(dir)
      .sort()
      .map((name) => `${name} ${createHash("sha256").update(readFileSync(join(dir, name))).digest("hex")}`);

  it("refuses a real server's data directory without opening its database", () => {
    const dir = join(root, "real");
    const db = openDatabase(dir);
    db.prepare("INSERT INTO settings (key, value) VALUES ('timezone', '\"America/New_York\"')").run();
    db.close();
    const before = snapshot(dir);
    expect(() => openDemoDir(dir)).toThrow(NotADemoDir);
    expect(() => openDemoDir(dir)).toThrow(/database the demo didn't make/);
    // Not a byte of it changed, and nothing was added: no marker, no -wal or -shm from opening it.
    expect(snapshot(dir)).toEqual(before);
  });

  it("refuses a directory with other files in it", () => {
    const dir = join(root, "notes");
    mkdirSync(dir);
    writeFileSync(join(dir, "todo.txt"), "made up\n");
    expect(() => openDemoDir(dir)).toThrow(NotADemoDir);
    expect(readdirSync(dir)).toEqual(["todo.txt"]);
  });

  it("refuses its own marker beside a database it didn't make, adding nothing to look", () => {
    const made = join(root, "made");
    const demo = openDemoDir(made);
    expect(demo.fresh).toBe(true);
    const real = join(root, "copied");
    openDatabase(real).close();
    writeFileSync(join(real, MARKER_FILE), readFileSync(join(made, MARKER_FILE)));
    const before = snapshot(real);
    expect(() => openDemoDir(real)).toThrow(/isn't the one the demo made/);
    // It read a copy: even a read-only open of a WAL database would leave -shm and -wal files here.
    expect(snapshot(real)).toEqual(before);
  });

  it("refuses a path that isn't a directory", () => {
    const file = join(root, "a-file");
    writeFileSync(file, "made up\n");
    expect(() => openDemoDir(file)).toThrow(/isn't a directory/);
  });

  it("makes a new directory, or uses an empty one, and comes back to one it made", () => {
    const fresh = openDemoDir(join(root, "new", "demo"));
    expect([fresh.fresh, fresh.temp]).toEqual([true, false]);
    expect(statSync(fresh.path).mode & 0o777).toBe(0o700);
    // Git leaves it alone, wherever it is.
    expect(readFileSync(join(fresh.path, ".gitignore"), "utf8")).toMatch(/^\*$/m);
    const db = openDatabase(fresh.path);
    markDatabase(db, fresh.id, T0);
    db.close();
    const again = openDemoDir(fresh.path);
    expect([again.fresh, again.id]).toEqual([false, fresh.id]);

    const empty = join(root, "empty");
    mkdirSync(empty);
    expect(openDemoDir(empty).fresh).toBe(true);

    const temp = openDemoDir(null);
    expect([temp.fresh, temp.temp]).toEqual([true, true]);
    expect(existsSync(join(temp.path, DB_FILE))).toBe(false);
    rmSync(temp.path, { recursive: true, force: true });
  });

  it("reads a database the demo was stopped from closing (its WAL not written back yet)", () => {
    const dir = join(root, "unclosed");
    const demo = openDemoDir(dir);
    const db = openDatabase(dir);
    markDatabase(db, demo.id, T0);
    // Still open: the row is in belay.db-wal only, as after a crash.
    expect(existsSync(join(dir, `${DB_FILE}-wal`))).toBe(true);
    try {
      expect(openDemoDir(dir)).toMatchObject({ fresh: false, id: demo.id });
    } finally {
      db.close();
    }
  });

  it("starts again in its own directory when its database was never made", () => {
    const dir = join(root, "early");
    const demo = openDemoDir(dir);
    writeFileSync(join(dir, PHONE_FILE), "{}\n");
    writeFileSync(join(dir, STATE_FILE), "{}\n");
    expect(openDemoDir(dir)).toMatchObject({ fresh: true, id: demo.id });
    expect(existsSync(join(dir, PHONE_FILE)) || existsSync(join(dir, STATE_FILE))).toBe(false);
  });
});
