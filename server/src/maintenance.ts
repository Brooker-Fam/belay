import type { DB } from "./db.js";
import { pruneUsage } from "./family/screentime/usage.js";
import { getSettings } from "./settings.js";

const DAY = 24 * 3_600_000;

/**
 * Deletes what has expired: sessions, codes, tokens; screen time older than the family keeps it
 * (13 months by default), with the extra time given that long ago; and lock_now commands a
 * month old. Run hourly; safe to run any time.
 */
export function cleanUp(db: DB, now: number): void {
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now - DAY);
    db.prepare("DELETE FROM access_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    db.prepare("DELETE FROM enrollment_codes WHERE expires_at <= ? AND (used_at IS NULL OR used_at <= ?)").run(now - 7 * DAY, now - 7 * DAY);
    db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now - 7 * DAY);
    // Registered clients that never completed a connection.
    db.prepare("DELETE FROM oauth_clients WHERE created_at <= ? AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL)").run(now - DAY);
    // Phase 3. A lock_now lasts minutes: a month on, its row says nothing the activity log doesn't.
    pruneUsage(db, now, getSettings(db).usageMonths);
    db.prepare("DELETE FROM commands WHERE kind = 'lock_now' AND issued_at <= ? AND (result IS NOT NULL OR replaced_at IS NOT NULL OR expires_at <= ?)").run(now - 30 * DAY, now - 30 * DAY);
  })();
  db.pragma("optimize");
}
