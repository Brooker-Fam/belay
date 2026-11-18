/**
 * Phase 4's changes, each through family/policy.ts's changePolicy: one transaction, the activity
 * log, and a new policy version when what the phone would see changed. Who may change what is
 * checked here as well as in the callers:
 *
 * - The mode, the interval and hours, the provider, keep_on, the places and lost mode are a
 *   parent's alone (the parent page, or the server's CLI acting as one). They decide what is
 *   collected, so an AI app can't change them, and can't propose to either.
 * - A check (locate_now) is a person's, or an AI app's with the location scope on (the caller
 *   checks the scope), and only while the phone takes checks: on demand or periodic. The kid gets
 *   a notice for every one, naming the AI app when one asked.
 */
import { insertCommandRow, type Changed, type Person, type PolicyContext, RuleRefused, type Tightener, changePolicy } from "../policy.js";
import { LOCATE_NOW_MS } from "../commands.js";
import { clockMinutes } from "../screentime/days.js";
import { oneLine } from "../../text.js";
import { round5 } from "./describe.js";
import {
  DEFAULT_LOCATION,
  LOCATION_LIMITS,
  type LocationMode,
  type LocationSettings,
  type Notify,
  type Place,
  type Provider,
  getPlace,
  listPlaces,
  locationSettings,
  newPlaceId,
  saveLocationSettings,
  takesChecks,
} from "./store.js";

/** The types already say so; this keeps it true at run time too. */
function onlyPeople(who: { kind: string }): void {
  if (who.kind === "ai") throw new Error("Only a parent changes where the phone shares its location: an AI app can't, not even as a proposal");
}

export interface LocationChange {
  mode?: LocationMode;
  everyMinutes?: number;
  /** Null: all day. */
  hours?: { start: string; end: string } | null;
  provider?: Provider;
  fallbackFused?: boolean;
  keepOn?: boolean;
}

export const MODE_WORDS: Record<LocationMode, string> = {
  off: "off",
  on_demand: "on demand: only when a parent checks",
  periodic: "periodic",
};

/** Checked at run time too: the CLI and the forms pass words people typed. */
const PROVIDERS: ReadonlySet<string> = new Set<Provider>(["gps", "fused"]);
const NOTIFY: ReadonlySet<string> = new Set<Notify>(["arrive", "leave"]);

/** Why a change won't do, or null. */
export function locationChangeProblem(change: LocationChange): string | null {
  if (change.mode !== undefined && !(change.mode in MODE_WORDS)) return "Choose off, on demand or periodic.";
  if (change.everyMinutes !== undefined && (!Number.isInteger(change.everyMinutes) || change.everyMinutes < LOCATION_LIMITS.minEvery || change.everyMinutes > LOCATION_LIMITS.maxEvery)) {
    return `Share where the phone is every ${LOCATION_LIMITS.minEvery} to ${LOCATION_LIMITS.maxEvery} minutes.`;
  }
  if (change.hours) {
    const start = clockMinutes(change.hours.start);
    const end = clockMinutes(change.hours.end);
    if (start === null || end === null) return "Hours are times like 07:00 and 21:00, in the phone's time.";
    if (start === end) return "The hours start and end at the same time: leave them out for all day.";
  }
  if (change.provider !== undefined && !PROVIDERS.has(change.provider)) return "Choose GPS only, or Android's combined provider.";
  return null;
}

/** The mode, interval, hours, provider and keep_on: a parent's choice, in the activity log. */
export function setLocation(ctx: PolicyContext, deviceId: string, change: LocationChange, who: Person): Changed<{ settings: LocationSettings }> {
  onlyPeople(who);
  const problem = locationChangeProblem(change);
  if (problem) throw new RuleRefused(problem);
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const before = locationSettings(db, deviceId);
    const current = before ?? { ...DEFAULT_LOCATION, changedAt: now };
    const next: LocationSettings = {
      ...current,
      ...(change.mode !== undefined ? { mode: change.mode } : {}),
      ...(change.everyMinutes !== undefined ? { everyMinutes: change.everyMinutes } : {}),
      ...(change.hours !== undefined ? { hours: change.hours } : {}),
      ...(change.provider !== undefined ? { provider: change.provider } : {}),
      ...(change.fallbackFused !== undefined ? { fallbackFused: change.fallbackFused } : {}),
      ...(change.keepOn !== undefined ? { keepOn: change.keepOn } : {}),
    };
    const same = (s: LocationSettings) => JSON.stringify([s.mode, s.everyMinutes, s.hours, s.provider, s.fallbackFused, s.keepOn]);
    if (before && same(before) === same(next)) return { settings: before };
    saveLocationSettings(db, deviceId, next, now);
    log("location.changed", {
      mode: next.mode,
      ...(next.mode === "periodic" ? { every_minutes: next.everyMinutes, hours: next.hours ?? undefined } : {}),
      provider: next.provider,
      fallback_fused: next.fallbackFused,
      keep_on: next.keepOn,
      ...(before ? { was: before.mode } : {}),
    });
    return { settings: next };
  });
}

export interface PlaceInput {
  /** Changes this place; left out: a new one. */
  id?: string;
  name: string;
  lat: number;
  lng: number;
  radiusM: number;
  notify: Notify[];
}

/** Why a place won't do, or null. */
export function placeProblem(input: PlaceInput): string | null {
  const name = oneLine(input.name, 200);
  if (!name) return "Name the place, like School.";
  if (name.length > LOCATION_LIMITS.placeName) return `Keep the place's name to ${LOCATION_LIMITS.placeName} characters: the kid sees it.`;
  if (!Number.isFinite(input.lat) || input.lat < -90 || input.lat > 90 || !Number.isFinite(input.lng) || input.lng < -180 || input.lng > 180) {
    return "The center is a latitude (-90 to 90) and a longitude (-180 to 180), like 40.10000, -73.20000.";
  }
  if (!Number.isInteger(input.radiusM) || input.radiusM < LOCATION_LIMITS.minRadius || input.radiusM > LOCATION_LIMITS.maxRadius) {
    return `A place's radius is ${LOCATION_LIMITS.minRadius} to ${LOCATION_LIMITS.maxRadius} meters.`;
  }
  if (input.notify.some((n) => !NOTIFY.has(n))) return "Tell you on arriving, on leaving, or both.";
  return null;
}

/**
 * Adds a place, or changes one. Names are the family's words, at most 40 characters, shown to the
 * kid; each phone's are different from one another, and there are at most 20. The phone gets
 * them in periodic mode only, since only it uses them.
 */
export function savePlace(ctx: PolicyContext, deviceId: string, input: PlaceInput, who: Person): Changed<{ place: Place; added: boolean }> {
  onlyPeople(who);
  const problem = placeProblem(input);
  if (problem) throw new RuleRefused(problem);
  const { db, now } = ctx;
  const name = oneLine(input.name, LOCATION_LIMITS.placeName);
  const notify = [...new Set(input.notify)];
  return changePolicy(ctx, deviceId, who, (log) => {
    const places = listPlaces(db, deviceId);
    const existing = input.id === undefined ? undefined : places.find((p) => p.id === input.id);
    if (input.id !== undefined && !existing) throw new RuleRefused("That place isn't there any more. Reload the page.");
    if (places.some((p) => p.id !== existing?.id && p.name.toLowerCase() === name.toLowerCase())) throw new RuleRefused(`There's already a place called ${name}.`);
    if (!existing && places.length >= LOCATION_LIMITS.maxPlaces) throw new RuleRefused(`A phone can have at most ${LOCATION_LIMITS.maxPlaces} places. Remove one first.`);
    const id = existing?.id ?? newPlaceId();
    db.prepare(
      `INSERT INTO places (device_id, id, name, lat, lng, radius_m, notify_arrive, notify_leave, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, id) DO UPDATE SET name = excluded.name, lat = excluded.lat, lng = excluded.lng, radius_m = excluded.radius_m,
         notify_arrive = excluded.notify_arrive, notify_leave = excluded.notify_leave, updated_at = excluded.updated_at`,
    ).run(deviceId, id, name, round5(input.lat), round5(input.lng), input.radiusM, notify.includes("arrive") ? 1 : 0, notify.includes("leave") ? 1 : 0, now, now);
    // A place needs the phone's settings row: a phone without one has no location at all.
    if (!locationSettings(db, deviceId)) saveLocationSettings(db, deviceId, { ...DEFAULT_LOCATION }, now);
    log(existing ? "place.changed" : "place.added", { place: name, radius_m: input.radiusM, notify });
    const place = getPlace(db, deviceId, id);
    if (!place) throw new Error("place vanished");
    return { place, added: !existing };
  });
}

/** Removes a place. Its arrivals and departures stay, with its name, until they age out. */
export function removePlace(ctx: PolicyContext, deviceId: string, id: string, who: Person): Changed<{ removed: Place | null }> {
  onlyPeople(who);
  const { db } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const place = getPlace(db, deviceId, id);
    if (!place) return { removed: null };
    db.prepare("DELETE FROM places WHERE device_id = ? AND id = ?").run(deviceId, id);
    log("place.removed", { place: place.name });
    return { removed: place };
  });
}

/** A number to show on the lock screen: digits, spaces, +, -, dots and parentheses, as people write them. */
export function lostNumberProblem(number: string): string | null {
  if (number.length > LOCATION_LIMITS.lostNumber || !/^[+0-9 ().-]+$/.test(number) || (number.match(/\d/g) ?? []).length < 3) {
    return `A number to show is digits, spaces and +, - or parentheses, at most ${LOCATION_LIMITS.lostNumber} characters, like 555-0100.`;
  }
  return null;
}

/**
 * Lost mode (any location mode, off included): the parent's message and a number on the lock
 * screen, location kept on, a fix every 5 minutes, and the screen locked once. Null ends it; its
 * fixes are kept until 7 days after (a setting). Changing the words while it's on keeps its start.
 */
export function setLost(ctx: PolicyContext, deviceId: string, input: { message: string; number: string | null } | null, who: Person): Changed<{ on: boolean; changed: boolean }> {
  onlyPeople(who);
  const message = input ? oneLine(input.message, 200) : "";
  const number = input?.number?.trim() || null;
  if (input) {
    if (!message) throw new RuleRefused("Write the message for the lock screen, like \"This phone is lost. Please call\".");
    const numberProblem = number === null ? null : lostNumberProblem(number);
    if (numberProblem) throw new RuleRefused(numberProblem);
    const length = message.length + (number ? number.length + 1 : 0);
    if (length > LOCATION_LIMITS.lostMessage) throw new RuleRefused(`The lock screen shows at most ${LOCATION_LIMITS.lostMessage} characters, the number included: shorten the message.`);
  }
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const current = locationSettings(db, deviceId) ?? { ...DEFAULT_LOCATION, changedAt: now };
    if (!input) {
      if (!current.lost) return { on: false, changed: false };
      // Lost mode's fixes are kept until a while after it ends (the hourly clean-up, from the family's setting).
      db.prepare("UPDATE fixes SET lost_ended_at = ? WHERE device_id = ? AND reason = 'lost' AND lost_ended_at IS NULL").run(now, deviceId);
      saveLocationSettings(db, deviceId, { ...current, lost: null, lostMessage: current.lost.message, lostNumber: current.lost.number, lostEndedAt: now }, now);
      log("lost.off", { since: current.lost.since });
      return { on: false, changed: true };
    }
    if (current.lost && current.lost.message === message && current.lost.number === number) return { on: true, changed: false };
    saveLocationSettings(db, deviceId, { ...current, lost: { since: current.lost?.since ?? now, message, number }, lostMessage: message, lostNumber: number }, now);
    log(current.lost ? "lost.changed" : "lost.on", { message, number: number ?? undefined });
    return { on: true, changed: true };
  });
}

/**
 * A check of where the phone is now: a locate_now command, which the phone runs once if it gets it
 * within 2 minutes, answering with a fix that names it. One still waiting is replaced, so a phone
 * that's offline doesn't collect them. Only while the phone takes checks (on demand or periodic).
 * A person's, an AI app's or (Phase 12) a caregiver's (the policy names either, for the kid's
 * notice), in the activity log.
 */
export function locateNow(ctx: PolicyContext, deviceId: string, who: Tightener): Changed<{ command: string; expiresAt: number }> {
  const { db, now } = ctx;
  if (!takesChecks(locationSettings(db, deviceId))) {
    throw new RuleRefused("Location is off for this phone, so it doesn't answer a check. A parent can turn it on, on the phone's Location page.");
  }
  return changePolicy(ctx, deviceId, who, (log) => {
    db.prepare("UPDATE commands SET replaced_at = ? WHERE device_id = ? AND kind = 'locate_now' AND result IS NULL AND replaced_at IS NULL").run(now, deviceId);
    const expiresAt = now + LOCATE_NOW_MS;
    const command = insertCommandRow(db, deviceId, "locate_now", now, expiresAt, who);
    log("command.issued", { kind: "locate_now", command, expires_at: expiresAt });
    return { command, expiresAt };
  });
}
