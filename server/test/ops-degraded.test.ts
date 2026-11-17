import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { testConfig } from "../src/config.js";
import { MigrationError, loadMigrations, migrate, openDatabase } from "../src/db.js";
import { databaseProblem, degradedApp, serveDegraded } from "../src/ops/degraded.js";
import { scratchDir } from "./ops-helpers.js";

const LATEST = loadMigrations().at(-1)?.version ?? 0;

/** A data dir whose database is from a newer Belay, so it won't open. */
function newerDatabase(): { dataDir: string; error: unknown } {
  const dataDir = scratchDir();
  const db = openDatabase(dataDir);
  db.pragma(`user_version = ${LATEST + 1}`);
  db.close();
  try {
    openDatabase(dataDir).close();
  } catch (error) {
    return { dataDir, error };
  }
  throw new Error("it opened");
}

describe("a database that can't be opened or upgraded", () => {
  it("a failed migration names itself, and rolls back to the version before it", () => {
    const db = new Database(":memory:");
    const steps = [
      { version: 1, name: "first", sql: "CREATE TABLE a (x INTEGER);" },
      { version: 2, name: "broken", sql: "CREATE TABLE b (y INTEGER); CREATE TABLE a (z INTEGER);" },
    ];
    let thrown: unknown;
    try {
      migrate(db, steps);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MigrationError);
    expect(thrown).toMatchObject({ version: 2, migration: "broken", message: "Migration 2 (broken) failed: table a already exists" });
    expect(db.pragma("user_version", { simple: true })).toBe(1);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'b'").get()).toBeUndefined();
  });

  it("says what went wrong in a sentence, without paths or SQL", () => {
    expect(databaseProblem(new MigrationError(5, "screen_time", new Error("near \"CREAT\": syntax error")))).toBe("Belay couldn't upgrade its database (step 5, screen_time).");
    expect(databaseProblem(newerDatabase().error)).toBe("The database is from a newer version of Belay than this server.");
    expect(databaseProblem(new Error("SQLITE_CANTOPEN: unable to open database file /data/belay.db"))).toBe("Belay couldn't open its database.");
  });

  it("answers /healthz with the reason (503 when strict), and every other request with 503", async () => {
    const app = degradedApp(testConfig(), "Belay couldn't upgrade its database (step 5, screen_time).");
    let res = await app.request("/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "the database couldn't be opened or upgraded" });
    res = await app.request("/healthz?strict=1");
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ ok: false, reason: "the database couldn't be opened or upgraded" });

    res = await app.request("/");
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("300");
    const page = await res.text();
    expect(page).toContain("Belay isn't working right now");
    expect(page).toContain("<p>Belay couldn&#39;t upgrade its database (step 5, screen_time).</p>");
    expect(page).toContain("The phones keep enforcing their rules on their own");

    for (const [method, path] of [["POST", "/api/v1/checkin"], ["GET", "/api/v1/policy?have=3&wait=30"], ["POST", "/mcp"], ["POST", "/oauth/token"]] as const) {
      res = await app.request(path, { method });
      expect([path, res.status]).toEqual([path, 503]);
      expect(await res.json()).toMatchObject({ error: "unavailable" });
    }
  });

  it("keeps listening, tries again, and starts normally once the database opens", async () => {
    const { dataDir, error } = newerDatabase();
    const logs: string[] = [];
    let recovered = false;
    const degraded = serveDegraded(testConfig({ dataDir, host: "127.0.0.1", port: 0 }), error, () => (recovered = true), { retryMs: 40, log: (line) => logs.push(line) });
    try {
      const port = await degraded.port;
      const res = await fetch(`http://127.0.0.1:${port}/healthz?strict=1`);
      expect(res.status).toBe(503);
      expect(logs[0]).toMatch(/^The database is from a newer version of Belay than this server\. Until it can, every page says so/);
      // Someone puts a database this server can open in place (here: the version it knows).
      const db = new Database(`${dataDir}/belay.db`);
      db.pragma(`user_version = ${LATEST}`);
      db.close();
      await expect.poll(() => recovered, { timeout: 5000 }).toBe(true);
      expect(logs.at(-1)).toBe("The database opens now: starting normally.");
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
    } finally {
      await degraded.close();
    }
  });
});
