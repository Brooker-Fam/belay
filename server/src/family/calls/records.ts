/**
 * Phase 5: what the phone sends about its calls (POST /api/v1/calls), and how the parent pages,
 * MCP and the CLI read it. The server keeps a record only while the phone's rules record calls
 * (`calls.log`); otherwise it's dropped, counted, and answered as accepted, so the phone stops
 * sending it. It's idempotent by the phone's ids.
 *
 * A record never names an emergency number, 988 or one of the family's private numbers: the phone
 * never records those calls. If one arrives anyway, the server drops it before anything else, even
 * one whose number isn't E.164 (911 can't be), keeps no count a parent sees (a count would say a
 * kid called 988), and says only that it did, in its own log, without the number (`neverKept`).
 */
import type { DB } from "../../db.js";
import type { CallRecord } from "../../device/schemas.js";
import { alwaysAllowed } from "./numbers.js";
import { callSettings, listContacts, numbersOf } from "./store.js";

const DAY = 86_400_000;

/** A phone keeps at most this many records a day: a busy kid makes far fewer calls, and a stuck phone can't fill the disk. */
export const MAX_RECORDS_PER_DAY = 1000;

export interface SavedCalls {
  /** Every record in the call, kept, already kept or dropped: the phone can stop sending them. */
  accepted: number;
  /** New records kept. */
  stored: number;
  /** Records the rules didn't ask for (not recording), or past the day's limit: not kept, counted for the parent page. */
  dropped: number;
}

/**
 * Takes out of a body, before it's checked, any record that names an emergency number or 988, in
 * any form: such a record is never kept, and one the phone shouldn't have sent mustn't cost the
 * others in the call. How many it took out.
 */
export function withoutAlwaysAllowed(body: unknown): { body: unknown; neverKept: number } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { calls?: unknown }).calls)) return { body, neverKept: 0 };
  const calls = (body as { calls: unknown[] }).calls;
  const kept = calls.filter((r) => {
    const number = r && typeof r === "object" ? (r as { number?: unknown }).number : undefined;
    return !(typeof number === "string" && alwaysAllowed(number) !== null);
  });
  return { body: { ...body, calls: kept }, neverKept: calls.length - kept.length };
}

/**
 * Saves the phone's call records (checked). A record that names a private number is dropped like
 * one with an emergency number (`neverKept`). One for a contact keeps the contact's name as it is
 * now, so a contact removed later still reads; a number with a contact's id is never kept.
 */
export function saveCallRecords(db: DB, deviceId: string, calls: CallRecord[], now: number): SavedCalls & { neverKept: number } {
  return db.transaction(() => {
    const s = callSettings(db, deviceId);
    const recording = s?.enabled === true && s.log;
    const privateNumbers = new Set(numbersOf(db, deviceId, "private"));
    const names = new Map(listContacts(db, deviceId).map((c) => [c.id, c.name]));
    const known = db.prepare("SELECT 1 FROM call_records WHERE device_id = ? AND id = ?");
    const insert = db.prepare(
      `INSERT INTO call_records (device_id, id, at, direction, contact_id, contact_name, number, duration_s, outcome, reason, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, id) DO NOTHING`,
    );
    let today = db.prepare<[string, number], { n: number }>("SELECT COUNT(*) AS n FROM call_records WHERE device_id = ? AND received_at > ?").get(deviceId, now - DAY)?.n ?? 0;
    const out = { accepted: calls.length, stored: 0, dropped: 0, neverKept: 0 };
    for (const r of calls) {
      const number = r.contact_id ? null : (r.number ?? null);
      if (number !== null && (alwaysAllowed(number) !== null || privateNumbers.has(number))) {
        out.neverKept++;
        continue;
      }
      if (known.get(deviceId, r.id)) continue;
      if (!recording || today >= MAX_RECORDS_PER_DAY) {
        out.dropped++;
        continue;
      }
      const contactId = r.contact_id ?? null;
      const name = contactId === null ? null : (names.get(contactId) ?? null);
      if (insert.run(deviceId, r.id, r.at, r.direction, contactId, name, number, r.duration_s, r.outcome, r.reason ?? null, now).changes === 1) {
        out.stored++;
        today++;
      }
    }
    if (out.dropped > 0 && s) db.prepare("UPDATE call_settings SET dropped = dropped + ?, dropped_at = ? WHERE device_id = ?").run(out.dropped, now, deviceId);
    return out;
  })();
}

// ── Reading ──────────────────────────────────────────────────────────

export interface CallRecordView {
  id: string;
  /** The phone's clock. */
  at: number;
  direction: "in" | "out";
  contactId: string | null;
  /** The contact's name when the record arrived (the family's words). */
  contactName: string | null;
  /** E.164, for someone who isn't a contact; null for no caller id (or a contact). */
  number: string | null;
  durationS: number;
  outcome: CallRecord["outcome"];
  reason: NonNullable<CallRecord["reason"]> | null;
  receivedAt: number;
}

interface RecordRow {
  id: string;
  at: number;
  direction: "in" | "out";
  contact_id: string | null;
  contact_name: string | null;
  number: string | null;
  duration_s: number;
  outcome: CallRecord["outcome"];
  reason: NonNullable<CallRecord["reason"]> | null;
  received_at: number;
}

/** The phone's call records, newest first (by the phone's clock), from `from` (inclusive) to `to` (exclusive). */
export function listCallRecords(db: DB, deviceId: string, opts: { from?: number; to?: number; limit?: number } = {}): CallRecordView[] {
  return db
    .prepare<[string, number, number, number], RecordRow>(
      `SELECT id, at, direction, contact_id, contact_name, number, duration_s, outcome, reason, received_at FROM call_records
       WHERE device_id = ? AND at >= ? AND at < ? ORDER BY at DESC, rowid DESC LIMIT ?`,
    )
    .all(deviceId, opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 50)
    .map((r) => ({
      id: r.id,
      at: r.at,
      direction: r.direction,
      contactId: r.contact_id,
      contactName: r.contact_name,
      number: r.number,
      durationS: r.duration_s,
      outcome: r.outcome,
      reason: r.reason,
      receivedAt: r.received_at,
    }));
}

// ── Keeping ──────────────────────────────────────────────────────────

/**
 * Deletes call records once the family stops keeping them (90 days by default). A record counts
 * from its own time, or from when it arrived if the phone's clock was ahead.
 */
export function pruneCallRecords(db: DB, now: number, days: number): number {
  return db.prepare("DELETE FROM call_records WHERE MIN(at, received_at) <= ?").run(now - days * DAY).changes;
}
