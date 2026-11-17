/**
 * Phase 4: each phone's location settings and places as the server keeps them, and the policy's
 * `location` built from them (docs/protocol.md, "Location rules"); and storing one fix. Reads and
 * the lowest-level writes only: changes to the settings, with who may make them, are in changes.ts,
 * and what the phone sends (POST /api/v1/locations) in fixes.ts.
 *
 * Only a parent changes any of it, on the parent page or the server's CLI: never an AI app, not
 * even as a proposal, since what is collected is a parent's decision.
 */
import { randomBytes } from "node:crypto";
import type { DB } from "../../db.js";
import type { Fix, Policy } from "../../device/schemas.js";
import { type PlaceRef, round5 } from "./describe.js";

export type LocationMode = "off" | "on_demand" | "periodic";
export type Provider = "gps" | "fused";
export type FixReason = Fix["reason"];
export type Notify = "arrive" | "leave";

export const LOCATION_LIMITS = {
  minEvery: 15,
  maxEvery: 120,
  defaultEvery: 30,
  maxPlaces: 20,
  placeName: 40,
  minRadius: 50,
  maxRadius: 1000,
  /** The lock-screen message, number included. */
  lostMessage: 120,
  lostNumber: 20,
} as const;

/** What lost mode says on the lock screen until a parent writes their own words. */
export const LOST_MESSAGE = "This phone is lost. Please call";

export interface LocationSettings {
  mode: LocationMode;
  /** Periodic: a fix every this many minutes. Kept while another mode is on, for next time. */
  everyMinutes: number;
  /** Periodic fixes only within these hours, in the phone's time; null: all day. */
  hours: { start: string; end: string } | null;
  provider: Provider;
  fallbackFused: boolean;
  keepOn: boolean;
  /** Lost mode, while it's on. */
  lost: { since: number; message: string; number: string | null } | null;
  /** The last lost-mode words and number, kept after it ends to fill the form next time. */
  lostMessage: string | null;
  lostNumber: string | null;
  lostEndedAt: number | null;
  /** Fixes and place events the phone sent that the rules didn't ask for: dropped, not kept. */
  dropped: number;
  droppedAt: number | null;
  changedAt: number;
}

export const DEFAULT_LOCATION: Omit<LocationSettings, "changedAt"> = {
  mode: "off",
  everyMinutes: LOCATION_LIMITS.defaultEvery,
  hours: null,
  provider: "gps",
  fallbackFused: false,
  keepOn: false,
  lost: null,
  lostMessage: null,
  lostNumber: null,
  lostEndedAt: null,
  dropped: 0,
  droppedAt: null,
};

interface SettingsRow {
  mode: LocationMode;
  every_minutes: number;
  hours_start: string | null;
  hours_end: string | null;
  provider: Provider;
  fallback_fused: number;
  keep_on: number;
  lost_since: number | null;
  lost_message: string | null;
  lost_number: string | null;
  lost_ended_at: number | null;
  dropped: number;
  dropped_at: number | null;
  changed_at: number;
}

/** The phone's location settings, or null when a parent never set any (no location at all). */
export function locationSettings(db: DB, deviceId: string): LocationSettings | null {
  const row = db.prepare<[string], SettingsRow>("SELECT * FROM location_settings WHERE device_id = ?").get(deviceId);
  if (!row) return null;
  return {
    mode: row.mode,
    everyMinutes: row.every_minutes,
    hours: row.hours_start !== null && row.hours_end !== null ? { start: row.hours_start, end: row.hours_end } : null,
    provider: row.provider,
    fallbackFused: row.fallback_fused === 1,
    keepOn: row.keep_on === 1,
    lost: row.lost_since !== null ? { since: row.lost_since, message: row.lost_message ?? LOST_MESSAGE, number: row.lost_number } : null,
    lostMessage: row.lost_message,
    lostNumber: row.lost_number,
    lostEndedAt: row.lost_ended_at,
    dropped: row.dropped,
    droppedAt: row.dropped_at,
    changedAt: row.changed_at,
  };
}

/** Saves the settings a parent chose (the counts of dropped fixes are the phone's, kept as they are). */
export function saveLocationSettings(db: DB, deviceId: string, s: Omit<LocationSettings, "dropped" | "droppedAt" | "changedAt">, now: number): void {
  db.prepare(
    `INSERT INTO location_settings (device_id, mode, every_minutes, hours_start, hours_end, provider, fallback_fused, keep_on, lost_since, lost_message, lost_number, lost_ended_at, changed_at)
     VALUES (@device_id, @mode, @every_minutes, @hours_start, @hours_end, @provider, @fallback_fused, @keep_on, @lost_since, @lost_message, @lost_number, @lost_ended_at, @now)
     ON CONFLICT (device_id) DO UPDATE SET mode = excluded.mode, every_minutes = excluded.every_minutes, hours_start = excluded.hours_start,
       hours_end = excluded.hours_end, provider = excluded.provider, fallback_fused = excluded.fallback_fused, keep_on = excluded.keep_on,
       lost_since = excluded.lost_since, lost_message = excluded.lost_message, lost_number = excluded.lost_number, lost_ended_at = excluded.lost_ended_at,
       changed_at = excluded.changed_at`,
  ).run({
    device_id: deviceId,
    mode: s.mode,
    every_minutes: s.everyMinutes,
    hours_start: s.hours?.start ?? null,
    hours_end: s.hours?.end ?? null,
    provider: s.provider,
    fallback_fused: s.fallbackFused ? 1 : 0,
    keep_on: s.keepOn ? 1 : 0,
    lost_since: s.lost?.since ?? null,
    lost_message: s.lost?.message ?? s.lostMessage,
    lost_number: s.lost ? s.lost.number : s.lostNumber,
    lost_ended_at: s.lostEndedAt,
    now,
  });
}

export interface Place extends PlaceRef {
  /** Which events tell the parents. */
  notify: Notify[];
  createdAt: number;
  updatedAt: number;
}

interface PlaceRow {
  id: string;
  name: string;
  lat: number;
  lng: number;
  radius_m: number;
  notify_arrive: number;
  notify_leave: number;
  created_at: number;
  updated_at: number;
}

const toPlace = (r: PlaceRow): Place => ({
  id: r.id,
  name: r.name,
  lat: r.lat,
  lng: r.lng,
  radiusM: r.radius_m,
  notify: [...(r.notify_arrive === 1 ? (["arrive"] as const) : []), ...(r.notify_leave === 1 ? (["leave"] as const) : [])],
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

/** The phone's places, oldest first. */
export function listPlaces(db: DB, deviceId: string): Place[] {
  return db
    .prepare<[string], PlaceRow>("SELECT id, name, lat, lng, radius_m, notify_arrive, notify_leave, created_at, updated_at FROM places WHERE device_id = ? ORDER BY created_at, rowid")
    .all(deviceId)
    .map(toPlace);
}

export function getPlace(db: DB, deviceId: string, id: string): Place | null {
  const row = db
    .prepare<[string, string], PlaceRow>("SELECT id, name, lat, lng, radius_m, notify_arrive, notify_leave, created_at, updated_at FROM places WHERE device_id = ? AND id = ?")
    .get(deviceId, id);
  return row ? toPlace(row) : null;
}

/** A new place's id: short, and a rule id the phone takes ("p-…"). */
export function newPlaceId(): string {
  return `p-${randomBytes(9).toString("base64url")}`;
}

/** The lock-screen words: the parent's message, then the number to show, at most 120 characters. */
export function lockScreenWords(message: string, number: string | null): string {
  const words = number ? `${message.trim()} ${number}` : message.trim();
  return words.slice(0, LOCATION_LIMITS.lostMessage);
}

/** Whether the phone takes a fix when a parent checks: on demand or periodic. Lost mode takes its own. */
export const takesChecks = (s: Pick<LocationSettings, "mode"> | null): boolean => s !== null && s.mode !== "off";

/**
 * The policy's `location`: null until a parent first sets location on the phone. The interval,
 * hours and places only in periodic mode, since only it uses them (the kid sees what's sent: never
 * a place Belay doesn't watch); keep_on only while Belay uses location (lost mode keeps it on
 * by itself). Lost mode works in any mode, off included.
 */
export function locationFor(db: DB, deviceId: string): Policy["location"] {
  const s = locationSettings(db, deviceId);
  if (!s) return null;
  const periodic = s.mode === "periodic";
  return {
    mode: s.mode,
    every_minutes: periodic ? s.everyMinutes : null,
    hours: periodic && s.hours ? { start: s.hours.start, end: s.hours.end } : null,
    provider: s.provider,
    fallback_fused: s.fallbackFused,
    places: periodic
      ? listPlaces(db, deviceId).map((p) => ({ id: p.id, name: p.name.slice(0, LOCATION_LIMITS.placeName), lat: p.lat, lng: p.lng, radius_m: p.radiusM, notify: p.notify }))
      : [],
    keep_on: s.mode !== "off" && s.keepOn,
    lost: s.lost ? { since: s.lost.since, message: lockScreenWords(s.lost.message, s.lost.number) } : null,
  };
}

// ── Fixes ────────────────────────────────────────────────────────────

/**
 * How far a fix's own time may be after the server got it: a little, for a phone's clock that's a
 * bit ahead. Past that, the fix counts as made then (FIX_TIME), so a phone whose clock is wrong,
 * or one that lies, can't make a fix "the latest" for longer than it is.
 */
export const FIX_SKEW_MS = 5 * 60_000;
/** In SQL: a fix's (or an arrival's or departure's) time as the server uses it, to show, order and pick "the latest fix" by. */
export const FIX_TIME = `MIN(at, received_at + ${FIX_SKEW_MS})`;

export interface FixView {
  id: string;
  /** The fix's own time (the phone's clock), but never more than FIX_SKEW_MS after it arrived. */
  at: number;
  lat: number;
  lng: number;
  accuracyM: number;
  provider: Provider;
  reason: FixReason;
  commandId: string | null;
  requestId: string | null;
  mock: boolean;
  receivedAt: number;
}

export interface FixRow {
  id: string;
  at: number;
  lat: number;
  lng: number;
  accuracy_m: number;
  provider: Provider;
  reason: FixReason;
  command_id: string | null;
  request_id: string | null;
  mock: number;
  received_at: number;
}

export const FIX_COLUMNS = "id, at, lat, lng, accuracy_m, provider, reason, command_id, request_id, mock, received_at";

export const toFix = (r: FixRow): FixView => ({
  id: r.id,
  at: Math.min(r.at, r.received_at + FIX_SKEW_MS),
  lat: r.lat,
  lng: r.lng,
  accuracyM: r.accuracy_m,
  provider: r.provider,
  reason: r.reason,
  commandId: r.command_id,
  requestId: r.request_id,
  mock: r.mock === 1,
  receivedAt: r.received_at,
});


/**
 * Stores one fix, its coordinates rounded to 5 decimal places (about a meter). Idempotent by the
 * phone's id: a fix the server already has stays as it is. Returns whether it's new.
 */
export function insertFix(
  db: DB,
  deviceId: string,
  fix: Fix,
  now: number,
  extra: { reason?: FixReason; commandId?: string | null; requestId?: string | null; lostEndedAt?: number | null } = {},
): boolean {
  return (
    db
      .prepare(
        `INSERT INTO fixes (device_id, id, at, lat, lng, accuracy_m, provider, reason, command_id, request_id, mock, received_at, lost_ended_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, id) DO NOTHING`,
      )
      .run(
        deviceId,
        fix.id,
        fix.at,
        round5(fix.lat),
        round5(fix.lng),
        fix.accuracy_m,
        fix.provider,
        extra.reason ?? fix.reason,
        extra.commandId === undefined ? (fix.command_id ?? null) : extra.commandId,
        extra.requestId ?? null,
        fix.mock ? 1 : 0,
        now,
        extra.lostEndedAt ?? null,
      ).changes === 1
  );
}
