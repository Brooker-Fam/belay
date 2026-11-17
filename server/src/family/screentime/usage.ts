/**
 * What the phone counted, one local day at a time (POST /api/v1/usage), and how the parent pages,
 * MCP and the CLI read it. A day sent again replaces the stored one when its `as_of` is the same
 * or newer, so the phone can always send again. Apps the phone never blocks (the dialer, the texting app,
 * Belay…) are never kept, even if a phone sends them: a call or text to 988 never shows. Kept
 * for the family's `usageMonths` setting (13 by default), then deleted by the hourly clean-up.
 */
import type { DB } from "../../db.js";
import type { UsageDay } from "../../device/schemas.js";
import { isValidTimeZone } from "../../time.js";
import { addDays, dateIn, validDay } from "./days.js";

/** A date can be counted in at most this many zones (a phone that traveled has two): a day sent in another isn't kept. */
export const MAX_ZONES_PER_DAY = 3;

/**
 * The latest day a phone can have counted by now: today in the day's zone, and one more for a
 * phone whose clock is ahead. A zone that isn't a real one could be any: UTC's today, plus the 14
 * hours a zone can be ahead of it, plus that day.
 */
export function latestUsageDay(now: number, zone: string): string {
  return isValidTimeZone(zone) ? addDays(dateIn(now, zone), 1) : addDays(dateIn(now, "UTC"), 2);
}

export type GapReason = UsageDay["gaps"][number]["reason"];

export interface UsageDayView {
  day: string;
  zone: string;
  /** Counted up to then (the phone's clock). */
  asOf: number;
  complete: boolean;
  screenMinutes: number;
  unlocks: number;
  byHour: number[];
  gaps: { from: number; to: number; reason: GapReason }[];
  receivedAt: number;
  /** Most used first. */
  apps: { package: string; minutes: number; opens: number }[];
}

export interface SavedUsage {
  /** Days the server now has from this call, stored or already newer: the phone can stop sending them. */
  accepted: number;
  /** Days stored: new, or newer than the one kept. */
  stored: number;
}

/**
 * Saves the days a phone sent. `keep` says whether an app's time may be kept (never-blocked apps'
 * isn't). A day that isn't a real date is accepted and dropped, and so is one that can't have been
 * counted yet (after latestUsageDay), one older than the family keeps (before `oldest`), and a
 * date in a fourth zone: whatever a phone token sends, it can't make the server keep more days
 * than there are. With measuring off (`measure` false), nothing is kept: collecting is a parent's
 * choice.
 */
export function saveUsage(
  db: DB,
  deviceId: string,
  days: UsageDay[],
  now: number,
  opts: { measure: boolean; keep: (pkg: string) => boolean; oldest?: string },
): SavedUsage {
  return db.transaction((): SavedUsage => {
    let stored = 0;
    if (!opts.measure) return { accepted: days.length, stored };
    const existing = db.prepare<[string, string, string], { as_of: number }>("SELECT as_of FROM usage_days WHERE device_id = ? AND day = ? AND zone = ?");
    const zonesOf = db.prepare<[string, string], { n: number }>("SELECT COUNT(*) AS n FROM usage_days WHERE device_id = ? AND day = ?");
    const upsert = db.prepare(
      `INSERT INTO usage_days (device_id, day, zone, as_of, complete, screen_minutes, unlocks, by_hour, gaps, received_at)
       VALUES (@device_id, @day, @zone, @as_of, @complete, @screen_minutes, @unlocks, @by_hour, @gaps, @now)
       ON CONFLICT (device_id, day, zone) DO UPDATE SET as_of = excluded.as_of, complete = excluded.complete, screen_minutes = excluded.screen_minutes,
         unlocks = excluded.unlocks, by_hour = excluded.by_hour, gaps = excluded.gaps, received_at = excluded.received_at`,
    );
    const clearApps = db.prepare("DELETE FROM usage_apps WHERE device_id = ? AND day = ? AND zone = ?");
    const addApp = db.prepare("INSERT OR REPLACE INTO usage_apps (device_id, day, zone, package, minutes, opens) VALUES (?, ?, ?, ?, ?, ?)");
    for (const d of days) {
      if (!validDay(d.day) || d.day > latestUsageDay(now, d.zone) || (opts.oldest !== undefined && d.day < opts.oldest)) continue;
      // The same as_of replaces too: a complete day sent again after the phone's clock moved has
      // the same as_of (its end), and Android moved its usage history with the clock.
      const kept = existing.get(deviceId, d.day, d.zone);
      if (kept && kept.as_of > d.as_of) continue;
      if (!kept && (zonesOf.get(deviceId, d.day)?.n ?? 0) >= MAX_ZONES_PER_DAY) continue;
      upsert.run({
        device_id: deviceId,
        day: d.day,
        zone: d.zone,
        as_of: d.as_of,
        complete: d.complete ? 1 : 0,
        screen_minutes: d.screen_minutes,
        unlocks: d.unlocks,
        by_hour: JSON.stringify(d.by_hour),
        gaps: JSON.stringify(d.gaps.filter((g) => g.to > g.from)),
        now,
      });
      clearApps.run(deviceId, d.day, d.zone);
      for (const app of d.apps) if (opts.keep(app.package)) addApp.run(deviceId, d.day, d.zone, app.package, app.minutes, app.opens);
      stored++;
    }
    return { accepted: days.length, stored };
  }).immediate();
}

interface DayRow {
  day: string;
  zone: string;
  as_of: number;
  complete: number;
  screen_minutes: number;
  unlocks: number;
  by_hour: string;
  gaps: string;
  received_at: number;
}

function parseList<T>(text: string): T[] {
  try {
    const value = JSON.parse(text) as unknown;
    return Array.isArray(value) ? (value as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * The days a phone sent, newest first: from `from` to `to` ("YYYY-MM-DD", both included) when
 * given. A day the phone counted in two zones (it traveled, with `zone: "phone"`) has two.
 */
export function usageDays(db: DB, deviceId: string, opts: { from?: string; to?: string; limit?: number } = {}): UsageDayView[] {
  const rows = db
    .prepare<[string, string, string, number], DayRow>(
      `SELECT day, zone, as_of, complete, screen_minutes, unlocks, by_hour, gaps, received_at FROM usage_days
       WHERE device_id = ? AND day >= ? AND day <= ? ORDER BY day DESC, as_of DESC LIMIT ?`,
    )
    .all(deviceId, opts.from ?? "0000-00-00", opts.to ?? "9999-99-99", opts.limit ?? 400);
  const apps = db.prepare<[string, string, string], { package: string; minutes: number; opens: number }>(
    "SELECT package, minutes, opens FROM usage_apps WHERE device_id = ? AND day = ? AND zone = ? ORDER BY minutes DESC, package",
  );
  return rows.map((r) => {
    const byHour = parseList<number>(r.by_hour).map((n) => (typeof n === "number" ? n : 0));
    return {
      day: r.day,
      zone: r.zone,
      asOf: r.as_of,
      complete: r.complete === 1,
      screenMinutes: r.screen_minutes,
      unlocks: r.unlocks,
      byHour: byHour.length === 24 ? byHour : Array.from({ length: 24 }, (_, i) => byHour[i] ?? 0),
      gaps: parseList<UsageDayView["gaps"][number]>(r.gaps),
      receivedAt: r.received_at,
      apps: apps.all(deviceId, r.day, r.zone),
    };
  });
}

/** One entry per day, newest first: of a day counted in two zones, the one counted furthest. */
export function oneEach(days: UsageDayView[]): UsageDayView[] {
  const seen = new Map<string, UsageDayView>();
  for (const d of days) {
    const kept = seen.get(d.day);
    if (!kept || d.asOf > kept.asOf) seen.set(d.day, d);
  }
  return [...seen.values()].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}

/** The day `months` months before `now`'s UTC date: usage older than that is deleted. */
export function retentionCutoff(now: number, months: number): string {
  const today = dateIn(now, "UTC");
  const [y = 1970, m = 1, d = 1] = today.split("-").map(Number);
  const back = new Date(Date.UTC(y, m - 1 - months, 1));
  // The same day of the month, or the month's last day when it has fewer.
  const last = new Date(Date.UTC(back.getUTCFullYear(), back.getUTCMonth() + 1, 0)).getUTCDate();
  return addDays(back.toISOString().slice(0, 10), Math.min(d, last) - 1);
}

/**
 * Deletes usage older than `months` months, and extra time given that long ago; and a day no phone
 * can have counted yet (from before the server dropped those as they came). Returns the days deleted.
 */
export function pruneUsage(db: DB, now: number, months: number): number {
  const cutoff = retentionCutoff(now, months);
  return db.transaction(() => {
    db.prepare("DELETE FROM extra_time WHERE day < ?").run(cutoff);
    return db.prepare("DELETE FROM usage_days WHERE day < ? OR day > ?").run(cutoff, latestUsageDay(now, "")).changes;
  }).immediate();
}

export const GAP_WORDS: Record<GapReason, string> = {
  no_usage_access: "usage access for Belay was off",
  phone_off: "the phone was off",
  unknown: "Belay can't tell why",
};
