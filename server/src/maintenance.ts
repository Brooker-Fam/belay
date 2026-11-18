import type { DB } from "./db.js";
import { endExpiredCaregivers } from "./family/caregivers/changes.js";
import { pruneCallRecords } from "./family/calls/records.js";
import { pruneLocations } from "./family/location/fixes.js";
import { pruneNetwork } from "./family/network/store.js";
import { pruneRequests } from "./family/requests.js";
import { pruneUsage } from "./family/screentime/usage.js";
import { getSettings } from "./settings.js";

const DAY = 24 * 3_600_000;

/**
 * Deletes what has expired: sessions, codes, tokens; screen time older than the family keeps it
 * (13 months by default), with the extra time given that long ago; lock_now commands a month
 * old; and where the phone was, as the family keeps it (Phase 4: periodic fixes 7 days, checks 30,
 * arrivals and departures 90, lost-mode fixes until 7 days after lost mode ends, a help request's
 * fix with its request); call records, as the family keeps them (Phase 5: 90 days by default);
 * network days, as the family keeps them (Phase 3's network logging: 30 days by default);
 * the kid's requests that wait for no one any more a year after they last changed (help
 * requests stay until the phone is deleted); and the activity log's entries older than the family
 * keeps it (400 days by default). Phase 12: a caregiver's access whose time came ends (their
 * sessions, browsers and link go, and their phones get policies without them: `changed` wakes
 * each phone's long-poll), and their expired sessions and links go. Run hourly; safe to run any time.
 */
export function cleanUp(db: DB, now: number, changed?: (deviceId: string) => void): void {
  endExpiredCaregivers({ db, now, ...(changed ? { changed } : {}) });
  db.transaction(() => {
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM oauth_codes WHERE expires_at <= ?").run(now - DAY);
    db.prepare("DELETE FROM access_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?").run(now);
    db.prepare("DELETE FROM enrollment_codes WHERE expires_at <= ? AND (used_at IS NULL OR used_at <= ?)").run(now - 7 * DAY, now - 7 * DAY);
    db.prepare("DELETE FROM invites WHERE expires_at <= ?").run(now - 7 * DAY);
    db.prepare("DELETE FROM caregiver_sessions WHERE expires_at <= ?").run(now);
    db.prepare("DELETE FROM caregiver_links WHERE expires_at <= ? OR (used_at IS NOT NULL AND used_at <= ?)").run(now - DAY, now - DAY);
    // Registered clients that never completed a connection.
    db.prepare("DELETE FROM oauth_clients WHERE created_at <= ? AND client_id NOT IN (SELECT client_id FROM oauth_grants WHERE client_id IS NOT NULL)").run(now - DAY);
    // Phase 3. A lock_now lasts minutes: a month on, its row says nothing the activity log doesn't.
    const settings = getSettings(db);
    pruneUsage(db, now, settings.usageMonths);
    db.prepare("DELETE FROM commands WHERE kind = 'lock_now' AND issued_at <= ? AND (result IS NOT NULL OR replaced_at IS NOT NULL OR expires_at <= ?)").run(now - 30 * DAY, now - 30 * DAY);
    pruneLocations(db, now, settings.locationDays);
    pruneRequests(db, now);
    pruneCallRecords(db, now, settings.callDays);
    pruneNetwork(db, now, settings.networkDays);
    db.prepare("DELETE FROM audit_log WHERE at <= ?").run(now - settings.activityDays * DAY);
  }).immediate();
  db.pragma("optimize");
}
