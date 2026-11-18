/**
 * Phase 13's mobile data on the server (docs/design/phase13-mobile-data.md): each phone's
 * Wi-Fi-only apps and its measuring switch (the policy's `mobile_data`, both off by default), and
 * the days the phone sends while it measures (POST /api/v1/mobile-data): how many bytes each app
 * used on mobile data each local day, with the day's Wi-Fi total and the lines that aren't one
 * app's (Android's own parts with the apps the phone never blocks, removed apps, the phone's
 * hotspot). A day sent again replaces the stored one, so the phone can always send again. Kept
 * only while the phone's switch is on, never as a never-blocked app's own line (its bytes go with
 * Android's), and for the family's `mobileDataDays` setting (90 by default), then deleted by the
 * hourly clean-up. A package name is the app developer's choice: untrusted, under `untrusted`
 * over MCP.
 */
import type { DB } from "../../db.js";
import type { MobileDataDay, Policy } from "../../device/schemas.js";
import { addDays, dateIn, validDay } from "../screentime/days.js";
import { latestUsageDay } from "../screentime/usage.js";

export interface MobileDataSettings {
  measure: boolean;
  /** When measuring was last turned on. */
  measureSince: number | null;
  changedAt: number;
  /** Days the phone sent while it was off: not kept. */
  dropped: number;
  droppedAt: number | null;
}

interface SettingsRow {
  measure: number;
  measure_since: number | null;
  changed_at: number;
  dropped: number;
  dropped_at: number | null;
}

/** The phone's measuring switch; null when no parent ever turned it on (off). */
export function mobileDataSettings(db: DB, deviceId: string): MobileDataSettings | null {
  const row = db
    .prepare<[string], SettingsRow>("SELECT measure, measure_since, changed_at, dropped, dropped_at FROM mobile_data_settings WHERE device_id = ?")
    .get(deviceId);
  return row ? { measure: row.measure === 1, measureSince: row.measure_since, changedAt: row.changed_at, dropped: row.dropped, droppedAt: row.dropped_at } : null;
}

export type WifiOnlyAddedBy = "parent" | "ai" | "server";

export interface WifiOnlyApp {
  package: string;
  addedAt: number;
  addedBy: WifiOnlyAddedBy;
  /** The parent who added it, or whose connection the AI app used; null from the server's CLI, or a parent since removed. */
  parentName: string | null;
  /** The AI app that added it. */
  clientName: string | null;
}

/** The phone's Wi-Fi-only apps, by package, with who added each and when. */
export function wifiOnlyApps(db: DB, deviceId: string): WifiOnlyApp[] {
  return db
    .prepare<[string], { package: string; added_at: number; added_by: WifiOnlyAddedBy; parent_name: string | null; client_name: string | null }>(
      `SELECT w.package, w.added_at, w.added_by, p.name AS parent_name, w.client_name FROM wifi_only_apps w
       LEFT JOIN parents p ON p.id = w.parent_id WHERE w.device_id = ? ORDER BY w.package`,
    )
    .all(deviceId)
    .map((r) => ({ package: r.package, addedAt: r.added_at, addedBy: r.added_by, parentName: r.parent_name, clientName: r.client_name }));
}

/** The phone's Wi-Fi-only apps' packages, sorted: the policy's `mobile_data.wifi_only`. */
export function wifiOnlyPackages(db: DB, deviceId: string): string[] {
  return db
    .prepare<[string], { package: string }>("SELECT package FROM wifi_only_apps WHERE device_id = ? ORDER BY package")
    .all(deviceId)
    .map((r) => r.package);
}

/** The policy's `mobile_data`: the Wi-Fi-only apps and the switch, always sent. */
export function mobileDataFor(db: DB, deviceId: string): Policy["mobile_data"] {
  return { wifi_only: wifiOnlyPackages(db, deviceId), measure: mobileDataSettings(db, deviceId)?.measure === true };
}

/** The oldest day kept with `days` days of retention: older ones are deleted. */
export function mobileDataCutoff(now: number, days: number): string {
  return addDays(dateIn(now, "UTC"), -days);
}

export interface SavedMobileData {
  /** Days in the call, kept or not: the phone can stop sending them. */
  accepted: number;
  /** Days stored (new, or replacing the one kept). */
  stored: number;
  /** Days sent while the phone's switch is off: not kept, counted for the parent page. */
  dropped: number;
}

/**
 * Saves the days a phone sent (checked). `never` says which apps the phone never blocks: their
 * bytes are never kept as their own line, but added to Android's, so the day's total stays right
 * (a phone sends none: core's DataUse folds them already). With the switch off, nothing is kept:
 * the days are counted and dropped. A day that isn't a real date, one the phone can't have counted
 * yet (after tomorrow in its zone), and one older than the family keeps (before `oldest`) are
 * accepted and dropped too: whatever a phone token sends, it can't make the server keep more days
 * than there are.
 */
export function saveMobileDataDays(db: DB, deviceId: string, days: MobileDataDay[], now: number, opts: { never: (pkg: string) => boolean; oldest: string }): SavedMobileData {
  return db.transaction((): SavedMobileData => {
    const out = { accepted: days.length, stored: 0, dropped: 0 };
    const s = mobileDataSettings(db, deviceId);
    if (!s?.measure) {
      out.dropped = days.length;
      if (s && days.length) db.prepare("UPDATE mobile_data_settings SET dropped = dropped + ?, dropped_at = ? WHERE device_id = ?").run(days.length, now, deviceId);
      return out;
    }
    const upsert = db.prepare(
      `INSERT INTO mobile_data_days (device_id, day, zone, from_at, as_of, complete, mobile_bytes, wifi_bytes, android_bytes, removed_bytes, hotspot_bytes, received_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, day) DO UPDATE SET zone = excluded.zone, from_at = excluded.from_at, as_of = excluded.as_of, complete = excluded.complete,
         mobile_bytes = excluded.mobile_bytes, wifi_bytes = excluded.wifi_bytes, android_bytes = excluded.android_bytes,
         removed_bytes = excluded.removed_bytes, hotspot_bytes = excluded.hotspot_bytes, received_at = excluded.received_at`,
    );
    const clear = db.prepare("DELETE FROM mobile_data_apps WHERE device_id = ? AND day = ?");
    const add = db.prepare("INSERT INTO mobile_data_apps (device_id, day, package, bytes) VALUES (?, ?, ?, ?) ON CONFLICT DO UPDATE SET bytes = bytes + excluded.bytes");
    for (const d of days) {
      if (!validDay(d.day) || d.day > latestUsageDay(now, d.zone) || d.day < opts.oldest) continue;
      const kept = d.apps.filter((a) => a.bytes > 0 && !opts.never(a.package));
      const folded = d.apps.filter((a) => a.bytes > 0 && opts.never(a.package)).reduce((sum, a) => sum + a.bytes, 0);
      upsert.run(deviceId, d.day, d.zone, d.from, d.as_of, d.complete ? 1 : 0, d.mobile_bytes, d.wifi_bytes, d.android_bytes + folded, d.removed_bytes, d.hotspot_bytes, now);
      clear.run(deviceId, d.day);
      for (const a of kept) add.run(deviceId, d.day, a.package, a.bytes);
      out.stored++;
    }
    return out;
  }).immediate();
}

export interface MobileDataAppView {
  /** The app's developer's choice: untrusted. */
  package: string;
  bytes: number;
}

export interface MobileDataDayView {
  day: string;
  zone: string;
  /** Counted from (the phone's clock): the day's start, or when measuring turned on. */
  from: number;
  /** Counted up to (the phone's clock). */
  asOf: number;
  complete: boolean;
  mobileBytes: number;
  wifiBytes: number;
  /** Android's own parts, with the apps the phone never blocks (the phone app, texting…). */
  androidBytes: number;
  removedBytes: number;
  hotspotBytes: number;
  receivedAt: number;
  /** Most first. */
  apps: MobileDataAppView[];
}

interface DayRow {
  day: string;
  zone: string;
  from_at: number;
  as_of: number;
  complete: number;
  mobile_bytes: number;
  wifi_bytes: number;
  android_bytes: number;
  removed_bytes: number;
  hotspot_bytes: number;
  received_at: number;
}

/** The days a phone sent, newest first: from `from` to `to` ("YYYY-MM-DD", both included) when given. */
export function mobileDataDays(db: DB, deviceId: string, opts: { from?: string; to?: string; limit?: number } = {}): MobileDataDayView[] {
  const rows = db
    .prepare<[string, string, string, number], DayRow>(
      `SELECT day, zone, from_at, as_of, complete, mobile_bytes, wifi_bytes, android_bytes, removed_bytes, hotspot_bytes, received_at
       FROM mobile_data_days WHERE device_id = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?`,
    )
    .all(deviceId, opts.from ?? "0000-00-00", opts.to ?? "9999-99-99", opts.limit ?? 100);
  const apps = db.prepare<[string, string], MobileDataAppView>("SELECT package, bytes FROM mobile_data_apps WHERE device_id = ? AND day = ? ORDER BY bytes DESC, package");
  return rows.map((r) => ({
    day: r.day,
    zone: r.zone,
    from: r.from_at,
    asOf: r.as_of,
    complete: r.complete === 1,
    mobileBytes: r.mobile_bytes,
    wifiBytes: r.wifi_bytes,
    androidBytes: r.android_bytes,
    removedBytes: r.removed_bytes,
    hotspotBytes: r.hotspot_bytes,
    receivedAt: r.received_at,
    apps: apps.all(deviceId, r.day),
  }));
}

/** How many days the server keeps for the phone, and the oldest. */
export function mobileDataKept(db: DB, deviceId: string): { days: number; oldest: string | null } {
  const row = db.prepare<[string], { n: number; oldest: string | null }>("SELECT COUNT(*) AS n, MIN(day) AS oldest FROM mobile_data_days WHERE device_id = ?").get(deviceId);
  return { days: row?.n ?? 0, oldest: row?.oldest ?? null };
}

/**
 * Deletes days older than the family keeps (`days` days, 90 by default), with their apps, and a day
 * no phone can have counted yet. Returns the days deleted.
 */
export function pruneMobileData(db: DB, now: number, days: number): number {
  return db.prepare("DELETE FROM mobile_data_days WHERE day < ? OR day > ?").run(mobileDataCutoff(now, days), latestUsageDay(now, "")).changes;
}

/** "350 MB", "1.2 GB", "0 bytes": a day's bytes, in decimal units as phones show data plans. */
export function bytesInWords(bytes: number): string {
  if (bytes < 1000) return `${bytes} byte${bytes === 1 ? "" : "s"}`;
  const units = ["KB", "MB", "GB", "TB"] as const;
  let value = bytes / 1000;
  let unit = 0;
  const round = (v: number) => (v < 10 ? Math.round(v * 10) / 10 : Math.round(v));
  // 999,999 bytes is "1 MB", not "1000 KB".
  while (round(value) >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${round(value)} ${units[unit] ?? "TB"}`;
}
