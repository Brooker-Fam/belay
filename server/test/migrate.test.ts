/** Upgrading a database from version 2 (Phase 2) or 4 (Phase 6) keeps what it holds. Made-up data only. */
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

  it("keeps the kid's requests, and of several waiting for one app keeps the newest", () => {
    const db = phase2();
    const insert = db.prepare(
      "INSERT INTO requests (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status) VALUES ('phone-1', ?, 'app', ?, 'Chatter Box', ?, ?, ?, ?, ?)",
    );
    insert.run("request-0001", "com.example.chat", "Please", T, T, T, "pending");
    insert.run("request-0002", "com.example.chat", null, T + 1, T + 1, T + 1, "pending");
    insert.run("request-0003", "com.example.chat", null, T + 2, T + 2, T + 2, "pending");
    insert.run("request-0004", "com.example.maps", null, T, T, T, "pending");
    insert.run("request-0005", "com.example.chat", null, T - 5, T - 5, T - 5, "declined");
    migrate(db);
    expect(db.prepare("SELECT id, status, superseded_by, reason FROM requests ORDER BY id").all()).toEqual([
      { id: "request-0001", status: "superseded", superseded_by: "request-0003", reason: "Please" },
      { id: "request-0002", status: "superseded", superseded_by: "request-0003", reason: null },
      { id: "request-0003", status: "pending", superseded_by: null, reason: null },
      { id: "request-0004", status: "pending", superseded_by: null, reason: null },
      { id: "request-0005", status: "declined", superseded_by: null, reason: null },
    ]);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'requests' ORDER BY name").all()).toEqual([
      { name: "requests_kind" },
      { name: "requests_package" },
      { name: "requests_received" },
      { name: "requests_status" },
      { name: "sqlite_autoindex_requests_1" },
    ]);
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

/** A database as a Phase 6 server left it (schema 4), with a parent and a phone. */
function phase6(): DB {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(
    db,
    loadMigrations().filter((m) => m.version <= 4),
  );
  db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES ('parent-1', 'Sam', 'sam', 'x', ?)").run(T);
  db.prepare("INSERT INTO devices (id, name, token_hash, enrolled_at) VALUES ('phone-1', 'Sam''s phone', 'h', ?)").run(T);
  return db;
}

describe("migration 5 (screen time)", () => {
  it("keeps requests, proposals and commands, and takes Phase 3's kinds", () => {
    const db = phase6();
    db.prepare(
      "INSERT INTO requests (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status, note, answered_by, answered_at) VALUES ('phone-1', 'request-0001', 'app', 'com.example.chat', 'Chatter Box', 'Please', ?, ?, ?, 'approved', 'OK', 'parent-1', ?)",
    ).run(T, T, T, T + 1);
    db.prepare("INSERT INTO proposals (id, device_id, kind, reason, client_name, parent_id, created_at) VALUES ('p-1', 'phone-1', 'resume', 'x', 'Claude', 'parent-1', ?)").run(T);
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at, expires_at, issued_by) VALUES ('c-1', 'phone-1', 'remove_other_users', ?, ?, 'parent-1')").run(T, T + 1);
    migrate(
      db,
      loadMigrations().filter((m) => m.version <= 5),
    );
    expect(db.pragma("user_version", { simple: true })).toBe(5);
    expect(db.prepare("SELECT id, kind, package, label, reason, status, note, answered_by, answered_at, limit_id, minutes FROM requests").all()).toEqual([
      { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter Box", reason: "Please", status: "approved", note: "OK", answered_by: "parent-1", answered_at: T + 1, limit_id: null, minutes: null },
    ]);
    expect(db.prepare("SELECT id, kind, status, payload FROM proposals").all()).toEqual([{ id: "p-1", kind: "resume", status: "pending", payload: null }]);
    expect(db.prepare("SELECT id, kind, expires_at, client_name FROM commands").all()).toEqual([{ id: "c-1", kind: "remove_other_users", expires_at: T + 1, client_name: null }]);

    // Phase 3's kinds, each with what it needs.
    const request = db.prepare(
      "INSERT INTO requests (device_id, id, kind, package, label, limit_id, minutes, agreement_version, agreement_answer, asked_at, received_at, updated_at) VALUES ('phone-1', ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)",
    );
    request.run("request-0002", "more_time", null, null, "l-games", 15, null, null);
    request.run("request-0003", "agreement", null, null, null, null, 2, "talk");
    expect(() => request.run("request-0004", "app", null, null, null, null, null, null)).toThrow(/CHECK/);
    expect(() => request.run("request-0005", "more_time", null, null, null, 15, null, null)).toThrow(/CHECK/);
    expect(() => request.run("request-0006", "agreement", null, null, null, null, 2, "maybe")).toThrow(/CHECK/);
    expect(() => request.run("request-0007", "time", null, null, null, null, null, null)).toThrow(/CHECK/);
    db.prepare("INSERT INTO proposals (id, device_id, kind, payload, reason, client_name, created_at) VALUES ('p-2', 'phone-1', 'screen_time', '{}', 'x', 'Claude', 0)").run();
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at) VALUES ('c-2', 'phone-1', 'lock_now', 0)").run();

    // A stage with a phone on it can't be deleted; deleting the phone takes everything of it.
    db.prepare("INSERT INTO stages (id, number, name, rules, created_at, updated_at) VALUES ('stage-1', 1, 'Starter', '{}', 0, 0)").run();
    db.prepare("INSERT INTO phone_stages (device_id, stage_id, since) VALUES ('phone-1', 'stage-1', 0)").run();
    expect(() => db.prepare("DELETE FROM stages WHERE id = 'stage-1'").run()).toThrow(/FOREIGN KEY/);
    db.prepare(
      "INSERT INTO usage_days (device_id, day, zone, as_of, complete, screen_minutes, unlocks, by_hour, gaps, received_at) VALUES ('phone-1', '2026-11-16', 'America/New_York', 0, 0, 0, 0, '[]', '[]', 0)",
    ).run();
    db.prepare("INSERT INTO usage_apps (device_id, day, zone, package, minutes, opens) VALUES ('phone-1', '2026-11-16', 'America/New_York', 'com.example.blocks', 5, 1)").run();
    db.prepare("DELETE FROM devices WHERE id = 'phone-1'").run();
    for (const table of ["requests", "proposals", "commands", "phone_stages", "usage_days", "usage_apps"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
    db.prepare("DELETE FROM stages WHERE id = 'stage-1'").run();
  });
});

/** A database as a Phase 3 server left it (schema 5), with a parent and a phone. */
function phase3(): DB {
  const db = phase6();
  migrate(
    db,
    loadMigrations().filter((m) => m.version <= 5),
  );
  return db;
}

describe("migration 6 (location and the kid's side)", () => {
  it("keeps requests and commands, and takes Phase 4's and 7's kinds", () => {
    const db = phase3();
    db.prepare(
      "INSERT INTO requests (device_id, id, kind, limit_id, minutes, given_minutes, extra_id, reason, asked_at, received_at, updated_at, status, answered_by, answered_at) VALUES ('phone-1', 'request-0001', 'more_time', 'l-games', 15, 15, 'x-1', 'Please', ?, ?, ?, 'approved', 'parent-1', ?)",
    ).run(T, T, T, T + 1);
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at, expires_at, issued_by, client_name) VALUES ('c-1', 'phone-1', 'lock_now', ?, ?, 'parent-1', 'Claude')").run(T, T + 1);
    migrate(db);
    expect(db.pragma("user_version", { simple: true })).toBe(6);
    expect(db.prepare("SELECT id, kind, limit_id, given_minutes, extra_id, reason, status, answered_by, withdrawn_at, seen_at FROM requests").all()).toEqual([
      { id: "request-0001", kind: "more_time", limit_id: "l-games", given_minutes: 15, extra_id: "x-1", reason: "Please", status: "approved", answered_by: "parent-1", withdrawn_at: null, seen_at: null },
    ]);
    expect(db.prepare("SELECT id, kind, client_name FROM commands").all()).toEqual([{ id: "c-1", kind: "lock_now", client_name: "Claude" }]);

    const request = db.prepare("INSERT INTO requests (device_id, id, kind, reason, status, withdrawn_at, seen_at, asked_at, received_at, updated_at) VALUES ('phone-1', ?, ?, ?, ?, ?, ?, 0, 0, 0)");
    request.run("request-0002", "help", null, "pending", null, null);
    request.run("request-0003", "talk", "My curfew", "withdrawn", 5, null);
    request.run("request-0004", "help", "Lost", "approved", null, 7);
    expect(() => request.run("request-0005", "talk", "x", "withdrawn", null, null)).toThrow(/CHECK/);
    expect(() => request.run("request-0006", "talk", "x", "pending", null, 7)).toThrow(/CHECK/);
    expect(() => request.run("request-0007", "chat", "x", "pending", null, null)).toThrow(/CHECK/);
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at) VALUES ('c-2', 'phone-1', 'locate_now', 0)").run();
    expect(() => db.prepare("INSERT INTO commands (id, device_id, kind, issued_at) VALUES ('c-3', 'phone-1', 'find', 0)").run()).toThrow(/CHECK/);

    // Everything of Phase 4 and 7 goes with its phone.
    db.prepare("INSERT INTO location_settings (device_id, mode, changed_at) VALUES ('phone-1', 'periodic', 0)").run();
    expect(() => db.prepare("UPDATE location_settings SET every_minutes = 5").run()).toThrow(/CHECK/);
    expect(() => db.prepare("UPDATE location_settings SET hours_start = '07:00'").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO places (device_id, id, name, lat, lng, radius_m, created_at, updated_at) VALUES ('phone-1', 'p-1', 'School', 40.1, -73.2, 100, 0, 0)").run();
    expect(() => db.prepare("UPDATE places SET radius_m = 20").run()).toThrow(/CHECK/);
    db.prepare("INSERT INTO fixes (device_id, id, at, lat, lng, accuracy_m, provider, reason, mock, received_at) VALUES ('phone-1', 'fix-00001', 0, 40.1, -73.2, 20, 'gps', 'periodic', 0, 0)").run();
    expect(() =>
      db.prepare("INSERT INTO fixes (device_id, id, at, lat, lng, accuracy_m, provider, reason, mock, received_at) VALUES ('phone-1', 'fix-00002', 0, 91, 0, 20, 'gps', 'periodic', 0, 0)").run(),
    ).toThrow(/CHECK/);
    db.prepare("INSERT INTO place_events (device_id, id, place_id, place_name, kind, at, fix_id, received_at) VALUES ('phone-1', 'event-0001', 'p-1', 'School', 'arrived', 0, 'fix-00001', 0)").run();
    db.prepare("INSERT INTO phone_help (device_id, kid_number, changed_at) VALUES ('phone-1', '+15555550123', 0)").run();
    db.prepare("DELETE FROM devices WHERE id = 'phone-1'").run();
    for (const table of ["requests", "commands", "location_settings", "places", "fixes", "place_events", "phone_help"]) {
      expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
  });
});
