import type { DB } from "./db.js";

const DAY = 24 * 3_600_000;

/** Deletes what has expired: sessions, codes, tokens. Run hourly; safe to run any time. */
export function cleanUp(db: DB, now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now - DAY);
    db.prepare("DELETE FROM access_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    db.prepare("DELETE FROM enrollment_codes WHERE expires_at <= ? AND (used_at IS NULL OR used_at <= ?)").run(now - 7 * DAY, now - 7 * DAY);
    db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now - 7 * DAY);
    // Registered clients that never completed a connection.
    db.prepare("DELETE FROM oauth_clients WHERE created_at <= ? AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL)").run(now - DAY);
  })();
  db.pragma("optimize");
}
