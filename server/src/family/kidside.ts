/**
 * Phase 7, the kid's side, as the policy carries it (docs/protocol.md, "The kid's side"): which
 * data categories the parents' AI app may read (`ai_reads`), when a parent saw each help request
 * (`help_seen`), and the numbers on the phone's emergency card (`parent_numbers`). Also the kid's
 * own number, which only the parent page uses ("Call" beside a help request) and the phone never
 * gets. Reads only: the changes, with who may make them, are in kidside-changes.ts.
 */
import type { DB } from "../db.js";
import type { Policy } from "../device/schemas.js";
import { type ParentNumber, aiReads, getSettings, parentNumbersFrom } from "../settings.js";
import { oneLine } from "../text.js";

/** The policy's help_seen and the parent page's "seen" both cover this long. */
export const HELP_SEEN_WINDOW_MS = 30 * 86_400_000;

export interface PhoneHelp {
  /** The kid's own number (E.164), for "Call"; null until a parent adds it. */
  kidNumber: string | null;
  /** This phone's own emergency-card numbers; null: the family's, from Settings. */
  ownParentNumbers: ParentNumber[] | null;
}

export function phoneHelp(db: DB, deviceId: string): PhoneHelp {
  const row = db.prepare<[string], { kid_number: string | null; parent_numbers: string | null }>("SELECT kid_number, parent_numbers FROM phone_help WHERE device_id = ?").get(deviceId);
  let own: ParentNumber[] | null = null;
  if (row?.parent_numbers != null) {
    try {
      own = parentNumbersFrom(JSON.parse(row.parent_numbers) as unknown);
    } catch {
      own = [];
    }
  }
  return { kidNumber: row?.kid_number ?? null, ownParentNumbers: own };
}

/** The numbers on the phone's emergency card: its own, or the family's. */
export function parentNumbersFor(db: DB, deviceId: string): Policy["parent_numbers"] {
  return (phoneHelp(db, deviceId).ownParentNumbers ?? getSettings(db).parentNumbers).map((p) => ({ name: p.name, number: p.number }));
}

/** The data categories the parents' AI app may read now, for the kid's "What your parent can see". */
export function aiReadsFor(db: DB): Policy["ai_reads"] {
  return aiReads(getSettings(db));
}

/** When a parent saw each of the kid's help requests, the last 30 days, newest first. */
export function helpSeenFor(db: DB, deviceId: string, now: number): Policy["help_seen"] {
  return db
    .prepare<[string, number], { request_id: string; at: number; by: string | null }>(
      `SELECT r.id AS request_id, r.seen_at AS at, p.name AS by FROM requests r LEFT JOIN parents p ON p.id = r.seen_by
       WHERE r.device_id = ? AND r.kind = 'help' AND r.seen_at IS NOT NULL AND r.seen_at >= ?
       ORDER BY r.seen_at DESC, r.rowid DESC LIMIT 200`,
    )
    .all(deviceId, now - HELP_SEEN_WINDOW_MS)
    .map((r) => ({ request_id: r.request_id, at: r.at, by: r.by === null ? null : oneLine(r.by, 60) || null }));
}
