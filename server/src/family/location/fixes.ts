/**
 * Phase 4: what the phone sends (POST /api/v1/locations), and how the parent pages, MCP and the
 * CLI read it. The server keeps only what the phone's rules asked for: a periodic fix only in
 * periodic mode (within its hours, in the phone's time), a check's fix only in on-demand or
 * periodic mode and naming one of this phone's checks, an arrival or departure only in periodic
 * mode and for one of its places. A lost-mode fix is always kept, and so is one the kid shared
 * with "I need help". Anything else is dropped, counted, and answered as accepted, so the phone
 * stops sending it. Everything is idempotent by the phone's ids.
 */
import type { DB } from "../../db.js";
import type { Fix, LocationsRequest, PlaceEvent } from "../../device/schemas.js";
import type { LocationRetention } from "../../settings.js";
import { isValidTimeZone, zoned } from "../../time.js";
import { type Command, listCommands } from "../commands.js";
import { deviceFacts } from "../devices.js";
import { clockMinutes } from "../screentime/days.js";
import { FIX_COLUMNS, FIX_SKEW_MS, FIX_TIME, type FixReason, type FixRow, type FixView, type LocationSettings, type Notify, insertFix, listPlaces, locationSettings, toFix } from "./store.js";

const DAY = 86_400_000;
/** Periodic fixes a little outside the hours still count: the phone's alarms aren't to the second. */
const HOURS_SLACK_MINUTES = 5;
/**
 * The most fixes the server keeps for one phone, whatever their reason (a lost-mode or help fix
 * too), the fix a kid shared with a help request aside (it's kept with the request): past that,
 * the oldest go, by when they arrived. A phone sharing every 15 minutes keeps about 700 a week.
 */
export const MAX_KEPT_FIXES = 10_000;
/** And the most arrivals and departures: past that, the oldest go. */
export const MAX_KEPT_PLACE_EVENTS = 2_000;

export interface NewPlaceEvent {
  id: string;
  placeId: string;
  /** The family's words. */
  placeName: string;
  kind: PlaceEvent["kind"];
  at: number;
  /** Whether the place tells the parents about this kind of event. */
  notify: boolean;
}

export interface SavedLocations {
  /** Every item in the call: kept, already kept, or dropped, the phone can stop sending them. */
  accepted: number;
  /** New fixes and place events kept. */
  stored: number;
  /** Fixes and place events the rules didn't ask for: not kept. */
  dropped: number;
  /** New ones the rules asked for, not kept because the phone made more this hour than it may (`budget`): it sends them again. */
  limited: number;
  /** Checks a fix in this call answers. */
  answered: string[];
  /** New arrivals and departures, for the parents' notices. */
  events: NewPlaceEvent[];
}

/** Whether a time is within the hours, in the phone's zone, give or take a few minutes. Unknown zone: yes. */
function withinHours(at: number, hours: LocationSettings["hours"], zone: string | null | undefined): boolean {
  if (!hours || !zone || !isValidTimeZone(zone)) return true;
  const start = clockMinutes(hours.start);
  const end = clockMinutes(hours.end);
  if (start === null || end === null) return true;
  const p = zoned(at, zone);
  const minute = p.hour * 60 + p.minute;
  const day = 1440;
  // An end at or before the start ends the next day.
  const length = (end - start + day) % day || day;
  if (length + 2 * HOURS_SLACK_MINUTES >= day) return true;
  const sinceStart = (minute - (start - HOURS_SLACK_MINUTES) + 2 * day) % day;
  return sinceStart <= length + 2 * HOURS_SLACK_MINUTES;
}

/** Whether the rules asked for this fix. */
function wanted(db: DB, deviceId: string, fix: Fix, s: LocationSettings | null, zone: string | null | undefined): boolean {
  switch (fix.reason) {
    case "lost":
    case "help":
      return true;
    case "on_demand":
      if (!s || s.mode === "off" || !fix.command_id) return false;
      return !!db.prepare("SELECT 1 FROM commands WHERE device_id = ? AND id = ? AND kind = 'locate_now'").get(deviceId, fix.command_id);
    case "periodic":
    case "place":
      return s?.mode === "periodic" && withinHours(fix.at, s.hours, zone);
  }
}

/**
 * Saves what the phone sent, as its rules ask. `budget` is how many new fixes and place events the
 * phone may still make the server keep this hour; past it, they aren't kept (`limited`), and the
 * phone sends them again later. The phone keeps at most MAX_KEPT_FIXES and MAX_KEPT_PLACE_EVENTS.
 */
export function saveLocations(db: DB, deviceId: string, body: LocationsRequest, now: number, opts: { budget?: number } = {}): SavedLocations {
  return db.transaction((): SavedLocations => {
    const s = locationSettings(db, deviceId);
    const zone = deviceFacts(db, deviceId)?.timezone;
    const out: SavedLocations = { accepted: body.fixes.length + body.place_events.length, stored: 0, dropped: 0, limited: 0, answered: [], events: [] };
    const budget = opts.budget ?? Infinity;
    const known = db.prepare<[string, string], { reason: FixReason; command_id: string | null }>("SELECT reason, command_id FROM fixes WHERE device_id = ? AND id = ?");
    for (const fix of body.fixes) {
      const already = known.get(deviceId, fix.id);
      if (already) {
        if (already.reason === "on_demand" && already.command_id) out.answered.push(already.command_id);
        continue;
      }
      if (!wanted(db, deviceId, fix, s, zone)) {
        out.dropped++;
        continue;
      }
      if (out.stored >= budget) {
        out.limited++;
        continue;
      }
      // A lost-mode fix sent after lost mode ended is kept as long as that lost mode's others.
      const lostEndedAt = fix.reason === "lost" && !s?.lost ? (s?.lostEndedAt ?? now) : null;
      if (insertFix(db, deviceId, fix, now, { commandId: fix.reason === "on_demand" ? (fix.command_id ?? null) : null, lostEndedAt })) out.stored++;
      if (fix.reason === "on_demand" && fix.command_id) out.answered.push(fix.command_id);
    }
    const places = new Map(listPlaces(db, deviceId).map((p) => [p.id, p]));
    const insertEvent = db.prepare(
      `INSERT INTO place_events (device_id, id, place_id, place_name, kind, at, fix_id, received_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, id) DO NOTHING`,
    );
    const eventKnown = db.prepare("SELECT 1 FROM place_events WHERE device_id = ? AND id = ?");
    for (const e of body.place_events) {
      if (eventKnown.get(deviceId, e.id)) continue;
      const place = places.get(e.place_id);
      if (s?.mode !== "periodic" || !place) {
        out.dropped++;
        continue;
      }
      if (out.stored >= budget) {
        out.limited++;
        continue;
      }
      if (insertEvent.run(deviceId, e.id, e.place_id, place.name, e.kind, e.at, e.fix_id, now).changes === 1) {
        out.stored++;
        const direction: Notify = e.kind === "arrived" ? "arrive" : "leave";
        out.events.push({ id: e.id, placeId: place.id, placeName: place.name, kind: e.kind, at: e.at, notify: place.notify.includes(direction) });
      }
    }
    if (out.dropped > 0 && s) db.prepare("UPDATE location_settings SET dropped = dropped + ?, dropped_at = ? WHERE device_id = ?").run(out.dropped, now, deviceId);
    out.accepted -= out.limited;
    // However the phone sends them, it keeps at most so many: the ones that arrived first go.
    db.prepare(
      "DELETE FROM fixes WHERE rowid IN (SELECT rowid FROM fixes WHERE device_id = ? AND request_id IS NULL ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?)",
    ).run(deviceId, MAX_KEPT_FIXES);
    db.prepare("DELETE FROM place_events WHERE rowid IN (SELECT rowid FROM place_events WHERE device_id = ? ORDER BY received_at DESC, rowid DESC LIMIT -1 OFFSET ?)").run(
      deviceId,
      MAX_KEPT_PLACE_EVENTS,
    );
    return out;
  }).immediate();
}

/** Records that the parents were told about an arrival or departure. */
export function markNotified(db: DB, deviceId: string, eventId: string, now: number): void {
  db.prepare("UPDATE place_events SET notified_at = ? WHERE device_id = ? AND id = ?").run(now, deviceId, eventId);
}

// ── Reading ──────────────────────────────────────────────────────────

/**
 * The phone's fixes, newest first, by the fix's own time, but never later than a few minutes after
 * it arrived (FIX_TIME): a fix dated in the future doesn't stay on top.
 */
export function listFixes(db: DB, deviceId: string, opts: { limit?: number; reasons?: FixReason[]; since?: number } = {}): FixView[] {
  const reasons = opts.reasons ?? ["on_demand", "periodic", "place", "lost", "help"];
  return db
    .prepare<(string | number)[], FixRow>(
      `SELECT ${FIX_COLUMNS} FROM fixes WHERE device_id = ? AND reason IN (${reasons.map(() => "?").join(", ")}) AND ${FIX_TIME} >= ? ORDER BY ${FIX_TIME} DESC, rowid DESC LIMIT ?`,
    )
    .all(deviceId, ...reasons, opts.since ?? 0, opts.limit ?? 50)
    .map(toFix);
}

/**
 * The newest fix the phone sent, of any kind, as listFixes orders them; with `real`, one Android
 * didn't mark as made up by an app. A phone's clock ahead of the server's (or a phone that lies
 * about it) can't keep one on top.
 */
export function latestFix(db: DB, deviceId: string, opts: { real?: boolean } = {}): FixView | null {
  if (!opts.real) return listFixes(db, deviceId, { limit: 1 })[0] ?? null;
  const row = db.prepare<[string], FixRow>(`SELECT ${FIX_COLUMNS} FROM fixes WHERE device_id = ? AND mock = 0 ORDER BY ${FIX_TIME} DESC, rowid DESC LIMIT 1`).get(deviceId);
  return row ? toFix(row) : null;
}

/**
 * The newest fix answering this check, or a later one (a newer check takes a waiting one's place,
 * and its fix answers both), or null while none has come. With `withinMs` (Phase 12, a
 * caregiver's check), only a check issued that soon after this one answers it: never a later one.
 */
export function checkAnswer(db: DB, deviceId: string, commandId: string, opts: { withinMs?: number } = {}): FixView | null {
  const row = db
    .prepare<[string, string, string, number, string, string], FixRow>(
      `SELECT ${FIX_COLUMNS.split(", ")
        .map((c) => `f.${c}`)
        .join(", ")} FROM fixes f JOIN commands c ON c.device_id = f.device_id AND c.id = f.command_id
       WHERE f.device_id = ? AND f.reason = 'on_demand' AND c.kind = 'locate_now'
         AND c.issued_at >= (SELECT issued_at FROM commands WHERE device_id = ? AND id = ?)
         AND c.issued_at <= ? + (SELECT issued_at FROM commands WHERE device_id = ? AND id = ?)
       ORDER BY MIN(f.at, f.received_at + ${FIX_SKEW_MS}) DESC, f.rowid DESC LIMIT 1`,
    )
    .get(deviceId, deviceId, commandId, opts.withinMs ?? Number.MAX_SAFE_INTEGER, deviceId, commandId);
  return row ? toFix(row) : null;
}

/**
 * How the phone answered a check, either way: the fix that answers it (as checkAnswer finds it), or
 * its report that it couldn't find where it is (`failed`, with Belay on the phone's words: they
 * come from the kid's phone, so untrusted) or got the check too late, by its own clock, to run it
 * (`expired`). A newer check that took this one's place answers it too, within `withinMs` as
 * checkAnswer, since the phone runs only the newest. A fix comes first. Null while the phone hasn't
 * answered: a "done" with no fix yet isn't an answer, since the fix itself is on its way.
 */
export type CheckOutcome = { kind: "fix"; fix: FixView } | { kind: "failed"; problem: string | null } | { kind: "expired" };

export function checkOutcome(db: DB, deviceId: string, commandId: string, opts: { withinMs?: number } = {}): CheckOutcome | null {
  const fix = checkAnswer(db, deviceId, commandId, opts);
  if (fix) return { kind: "fix", fix };
  const row = db
    .prepare<[string, string, string, number, string, string], { result: "failed" | "expired"; problem: string | null }>(
      `SELECT c.result, c.problem FROM commands c
       WHERE c.device_id = ? AND c.kind = 'locate_now' AND c.result IN ('failed', 'expired')
         AND c.issued_at >= (SELECT issued_at FROM commands WHERE device_id = ? AND id = ?)
         AND c.issued_at <= ? + (SELECT issued_at FROM commands WHERE device_id = ? AND id = ?)
       ORDER BY c.issued_at DESC, c.rowid DESC LIMIT 1`,
    )
    .get(deviceId, deviceId, commandId, opts.withinMs ?? Number.MAX_SAFE_INTEGER, deviceId, commandId);
  if (!row) return null;
  return row.result === "failed" ? { kind: "failed", problem: row.problem } : { kind: "expired" };
}

/** A parent's check (or their AI app's), with the fix that answered it. */
export interface Check {
  command: Command;
  fix: FixView | null;
}

/** The checks of the last 30 days (or since `since`), newest first: the same list the kid sees on the phone. */
export function listChecks(db: DB, deviceId: string, now: number, opts: { since?: number; limit?: number } = {}): Check[] {
  const since = opts.since ?? now - 30 * DAY;
  const fixFor = db.prepare<[string, string], FixRow>(`SELECT ${FIX_COLUMNS} FROM fixes WHERE device_id = ? AND command_id = ? ORDER BY ${FIX_TIME} DESC LIMIT 1`);
  return listCommands(db, deviceId, now, { kind: "locate_now", limit: opts.limit ?? 100 })
    .filter((c) => c.issuedAt >= since)
    .map((command) => {
      const row = fixFor.get(deviceId, command.id);
      return { command, fix: row ? toFix(row) : null };
    });
}

export interface PlaceEventView {
  id: string;
  placeId: string;
  /** The place's name when it happened (the family's words). */
  placeName: string;
  kind: PlaceEvent["kind"];
  /** The phone's clock, but never more than FIX_SKEW_MS after the server got it, as a fix's. */
  at: number;
  fixId: string;
  receivedAt: number;
  notifiedAt: number | null;
}

/**
 * Arrivals and departures, newest first, from `from` (inclusive) to `to` (exclusive), by their
 * own time but never later than a few minutes after they arrived (FIX_TIME, as fixes): one dated
 * in the future doesn't stay on top, nor show as from then.
 */
export function listPlaceEvents(db: DB, deviceId: string, opts: { from?: number; to?: number; limit?: number } = {}): PlaceEventView[] {
  return db
    .prepare<[string, number, number, number], { id: string; place_id: string; place_name: string; kind: PlaceEvent["kind"]; at: number; fix_id: string; received_at: number; notified_at: number | null }>(
      `SELECT id, place_id, place_name, kind, ${FIX_TIME} AS at, fix_id, received_at, notified_at FROM place_events
       WHERE device_id = ? AND ${FIX_TIME} >= ? AND ${FIX_TIME} < ? ORDER BY ${FIX_TIME} DESC, rowid DESC LIMIT ?`,
    )
    .all(deviceId, opts.from ?? 0, opts.to ?? Number.MAX_SAFE_INTEGER, opts.limit ?? 50)
    .map((r) => ({ id: r.id, placeId: r.place_id, placeName: r.place_name, kind: r.kind, at: r.at, fixId: r.fix_id, receivedAt: r.received_at, notifiedAt: r.notified_at }));
}

// ── Keeping ──────────────────────────────────────────────────────────

/**
 * Deletes where the phone was once the family's settings stop keeping it: periodic fixes after 7
 * days, a check's fix after 30, arrivals and departures after 90, a lost-mode fix 7 days after its
 * lost mode ended (never while it's on), a help request's fix with the request (one the phone sent
 * alone, like a check's). A fix counts from its own time, or from when it arrived if the phone's
 * clock was ahead. Checks older than a month that are over go too, as a lock_now's do.
 */
export function pruneLocations(db: DB, now: number, days: LocationRetention): void {
  const age = "MIN(at, received_at)";
  db.prepare(`DELETE FROM fixes WHERE reason IN ('periodic', 'place') AND ${age} <= ?`).run(now - days.periodic * DAY);
  db.prepare(`DELETE FROM fixes WHERE reason = 'on_demand' AND ${age} <= ?`).run(now - days.checks * DAY);
  db.prepare("DELETE FROM fixes WHERE reason = 'lost' AND lost_ended_at IS NOT NULL AND lost_ended_at <= ?").run(now - days.lostAfter * DAY);
  db.prepare(
    `DELETE FROM fixes WHERE reason = 'help' AND ((request_id IS NULL AND ${age} <= ?)
       OR (request_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM requests r WHERE r.device_id = fixes.device_id AND r.id = fixes.request_id)))`,
  ).run(now - days.checks * DAY);
  db.prepare(`DELETE FROM place_events WHERE ${age} <= ?`).run(now - days.placeEvents * DAY);
  db.prepare("DELETE FROM commands WHERE kind = 'locate_now' AND issued_at <= ? AND (result IS NOT NULL OR replaced_at IS NOT NULL OR expires_at <= ?)").run(
    now - 30 * DAY,
    now - 30 * DAY,
  );
}
