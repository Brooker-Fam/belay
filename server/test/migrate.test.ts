/** Upgrading a database from version 2 (Phase 2) keeps what it holds. Made-up data only. */
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { type DB, loadMigrations, migrate } from "../src/db.js";

const T = Date.UTC(2026, 10, 16, 15, 0, 0);

/** A database as a Phase 2 server left it, with a parent and a phone. */
function phase2(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    loadMigrations().filter((m) => m.version <= 2),
  );
  db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES ('parent-1', 'Sam', 'sam', 'x', ?)").run(T);
  db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'Sam''s phone', 'h', ?)").run(T);
  return db;
}

describe("migration 3", () => {
  it("keeps every proposal, and the waiting ones still wait", () => {
    const db = phase2();
    const insert = db.prepare(
      "INSERT INTO proposals (id, device_id, kind, package, reason, client_name, parent_id, created_at, status, decided_by, decided_at) VALUES (?, 'phone-1', ?, ?, 'x', 'Claude', 'parent-1', ?, ?, ?, ?)",
    );
    insert.run("p-1", "allow_app", "com.example.chat", T, "pending", null, null);
    insert.run("p-2", "resume", null, T + 1, "approved", "parent-1", T + 2);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(loadMigrations().at(-1)?.version);
    expect(db.prepare("SELECT id, kind, package, status, decided_by, context, outdated_why FROM proposals ORDER BY id").all()).toEqual([
      { id: "p-1", kind: "allow_app", package: "com.example.chat", status: "pending", decided_by: null, context: null, outdated_why: null },
      { id: "p-2", kind: "resume", package: null, status: "approved", decided_by: "parent-1", context: null, outdated_why: null },
    ]);
    db.prepare("UPDATE proposals SET status = 'outdated' WHERE id = 'p-1'").run();
    expect(() => db.prepare("UPDATE proposals SET status = 'maybe' WHERE id = 'p-1'").run()).toThrow(/CHECK/);
    // A phone's deletion still takes its proposals with it.
    db.prepare("DELETE FROM devices WHERE id = 'phone-1'").run();
    expect(db.prepare("SELECT COUNT(*) AS n FROM proposals").get()).toEqual({ n: 0 });
  });

  it("learns from the activity log when new apps first asked, and when they last changed", () => {
    const db = phase2();
    db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-2', 'Alex''s phone', 'h2', ?)").run(T);
    db.prepare("INSERT INTO policies (device_id, version, changed_at, new_apps) VALUES ('phone-1', 3, ?, 'allow')").run(T + 30);
    db.prepare("INSERT INTO policies (device_id, version, changed_at, new_apps) VALUES ('phone-2', 1, ?, 'allow')").run(T + 5);
    const log = db.prepare("INSERT INTO audit_log (at, actor, parent_id, device_id, action, detail) VALUES (?, 'parent', 'parent-1', ?, ?, ?)");
    log.run(T + 10, "phone-1", "policy.protected", JSON.stringify({ grandfathered: 2, version: 1 }));
    log.run(T + 20, "phone-1", "policy.new_apps", JSON.stringify({ mode: "allow", grandfathered: 0, version: 2 }));
    log.run(T + 5, "phone-2", "policy.support_message", JSON.stringify({ version: 1 }));
    migrate(db);
    expect(db.prepare("SELECT device_id, ask_first_at, new_apps_at, pause_set_at FROM policies ORDER BY device_id").all()).toEqual([
      { device_id: "phone-1", ask_first_at: T + 10, new_apps_at: T + 20, pause_set_at: null },
      // New apps never asked on this one: the first time will allow what's on the phone.
      { device_id: "phone-2", ask_first_at: null, new_apps_at: null, pause_set_at: null },
    ]);
  });
});
