/**
 * Phase 3's network logging on the server: each phone's switch (the policy's `network_log`, a
 * parent's choice alone, off by default), and the days the phone sends (POST /api/v1/network):
 * how many times each app looked up each domain, one local day at a time, reduced on the phone
 * from Android's DNS lookups. A day sent again replaces the stored one, so the phone can always
 * send again. Kept only while the phone's switch is on, never for the apps the phone never blocks
 * (the phone app, texting, Belay…), and never for 988's websites; kept for the family's
 * `networkDays` setting (30 by default), then deleted by the hourly clean-up. A domain is the app
 * developer's choice: untrusted text, under `untrusted` over MCP.
 */
import type { DB } from "../../db.js";
import type { NetworkDay, Policy } from "../../device/schemas.js";
import { addDays, dateIn, validDay } from "../screentime/days.js";
import { latestUsageDay } from "../screentime/usage.js";

/**
 * 988's websites (checked 2026-11-17), never kept, like a call to 988: the 988 Suicide and Crisis
 * Lifeline, its Spanish site and its earlier site (both lead there now), Canada's 9-8-8 Suicide
 * Crisis Helpline, and the Veterans Crisis Line (dial 988, then 1). The phone never sends them
 * (core's network/Domains.kt has the same list); one that arrives anyway is dropped before
 * anything else, counted for no one, and the server's log says only that it happened.
 */
export const CRISIS_988 = ["988lifeline.org", "988lineadevida.org", "suicidepreventionlifeline.org", "988.ca", "veteranscrisisline.net"] as const;

/** One of 988's websites, or a name under one, however it's written. */
export function isCrisis(domain: string): boolean {
  const d = domain.trim().toLowerCase().replace(/\.$/, "");
  return CRISIS_988.some((c) => d === c || d.endsWith(`.${c}`));
}

export interface NetworkSettings {
  enabled: boolean;
  /** When it was last turned on. */
  enabledAt: number | null;
  changedAt: number;
  /** Days the phone sent while it was off: not kept. */
  dropped: number;
  droppedAt: number | null;
}

interface SettingsRow {
  enabled: number;
  enabled_at: number | null;
  changed_at: number;
  dropped: number;
  dropped_at: number | null;
}

/** The phone's switch; null when no parent ever turned it on (off). */
export function networkSettings(db: DB, deviceId: string): NetworkSettings | null {
  const row = db.prepare<[string], SettingsRow>("SELECT enabled, enabled_at, changed_at, dropped, dropped_at FROM network_settings WHERE device_id = ?").get(deviceId);
  return row ? { enabled: row.enabled === 1, enabledAt: row.enabled_at, changedAt: row.changed_at, dropped: row.dropped, droppedAt: row.dropped_at } : null;
}

/**
 * The phone's private websites, sorted: registrable domains (family/network/domains.ts) Belay never
 * keeps a lookup of, or of a name under one, like 988's. A parent's; never shown to an AI app.
 */
export function privateDomainsOf(db: DB, deviceId: string): string[] {
  return db
    .prepare<[string], { domain: string }>("SELECT domain FROM network_private_domains WHERE device_id = ? ORDER BY domain")
    .all(deviceId)
    .map((r) => r.domain);
}

/** The policy's `network_log`: the switch, and the private websites, sent whether logging is on or off. */
export function networkLogFor(db: DB, deviceId: string): Policy["network_log"] {
  return { enabled: networkSettings(db, deviceId)?.enabled === true, private_domains: privateDomainsOf(db, deviceId) };
}

/** The oldest day kept with `days` days of retention: older ones are deleted. */
export function networkCutoff(now: number, days: number): string {
  return addDays(dateIn(now, "UTC"), -days);
}

/**
 * Takes out of a body, before it's checked, every entry naming one of 988's websites, in any form:
 * it's never kept, and one the phone shouldn't have sent mustn't cost the rest of its day. How
 * many it took out.
 */
export function withoutCrisis(body: unknown): { body: unknown; neverKept: number } {
  if (!body || typeof body !== "object" || !Array.isArray((body as { days?: unknown }).days)) return { body, neverKept: 0 };
  let neverKept = 0;
  const days = (body as { days: unknown[] }).days.map((d) => {
    if (!d || typeof d !== "object" || !Array.isArray((d as { entries?: unknown }).entries)) return d;
    const entries = (d as { entries: unknown[] }).entries.filter((e) => {
      const domain = e && typeof e === "object" ? (e as { domain?: unknown }).domain : undefined;
      const crisis = typeof domain === "string" && isCrisis(domain);
      if (crisis) neverKept++;
      return !crisis;
    });
    return { ...d, entries };
  });
  return { body: { ...body, days }, neverKept };
}

export interface SavedNetwork {
  /** Days in the call, kept or not: the phone can stop sending them. */
  accepted: number;
  /** Days stored (new, or replacing the one kept). */
  stored: number;
  /** Days sent while the phone's switch is off: not kept, counted for the parent page. */
  dropped: number;
}

/**
 * Saves the days a phone sent (checked, 988 already taken out). `keep` says whether an app's
 * lookups may be kept (never-blocked apps' aren't). With the switch off, nothing is kept: the
 * days are counted and dropped. A day that isn't a real date, one the phone can't have counted
 * yet (after tomorrow in its zone), and one older than the family keeps (before `oldest`) are
 * accepted and dropped too: whatever a phone token sends, it can't make the server keep more days
 * than there are.
 */
export function saveNetworkDays(db: DB, deviceId: string, days: NetworkDay[], now: number, opts: { keep: (pkg: string) => boolean; oldest: string }): SavedNetwork {
  return db.transaction((): SavedNetwork => {
    const out = { accepted: days.length, stored: 0, dropped: 0 };
    const s = networkSettings(db, deviceId);
    if (!s?.enabled) {
      out.dropped = days.length;
      if (s && days.length) db.prepare("UPDATE network_settings SET dropped = dropped + ?, dropped_at = ? WHERE device_id = ?").run(days.length, now, deviceId);
      return out;
    }
    const upsert = db.prepare(
      `INSERT INTO network_days (device_id, day, zone, as_of, dropped, received_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id, day) DO UPDATE SET zone = excluded.zone, as_of = excluded.as_of, dropped = excluded.dropped, received_at = excluded.received_at`,
    );
    const clear = db.prepare("DELETE FROM network_lookups WHERE device_id = ? AND day = ?");
    const add = db.prepare("INSERT OR REPLACE INTO network_lookups (device_id, day, package, domain, lookups) VALUES (?, ?, ?, ?, ?)");
    for (const d of days) {
      if (!validDay(d.day) || d.day > latestUsageDay(now, d.zone) || d.day < opts.oldest) continue;
      upsert.run(deviceId, d.day, d.zone, d.as_of, d.dropped, now);
      clear.run(deviceId, d.day);
      for (const e of d.entries) if (opts.keep(e.package) && !isCrisis(e.domain)) add.run(deviceId, d.day, e.package, e.domain, e.lookups);
      out.stored++;
    }
    return out;
  }).immediate();
}

export interface NetworkEntryView {
  package: string;
  /** The app's developer's choice: untrusted. */
  domain: string;
  lookups: number;
}

export interface NetworkDayView {
  day: string;
  zone: string;
  /** The newest lookup counted (the phone's clock). */
  asOf: number;
  /** Entries the phone cut to stay under 5000 that day. */
  dropped: number;
  receivedAt: number;
  /** Most looked up first. */
  entries: NetworkEntryView[];
}

/** The days a phone sent, newest first: from `from` to `to` ("YYYY-MM-DD", both included) when given. */
export function networkDays(db: DB, deviceId: string, opts: { from?: string; to?: string; limit?: number } = {}): NetworkDayView[] {
  const rows = db
    .prepare<[string, string, string, number], { day: string; zone: string; as_of: number; dropped: number; received_at: number }>(
      "SELECT day, zone, as_of, dropped, received_at FROM network_days WHERE device_id = ? AND day >= ? AND day <= ? ORDER BY day DESC LIMIT ?",
    )
    .all(deviceId, opts.from ?? "0000-00-00", opts.to ?? "9999-99-99", opts.limit ?? 100);
  const entries = db.prepare<[string, string], NetworkEntryView>(
    "SELECT package, domain, lookups FROM network_lookups WHERE device_id = ? AND day = ? ORDER BY lookups DESC, package, domain",
  );
  return rows.map((r) => ({ day: r.day, zone: r.zone, asOf: r.as_of, dropped: r.dropped, receivedAt: r.received_at, entries: entries.all(deviceId, r.day) }));
}

/** How many days the server keeps for the phone, and the oldest. */
export function networkKept(db: DB, deviceId: string): { days: number; oldest: string | null } {
  const row = db.prepare<[string], { n: number; oldest: string | null }>("SELECT COUNT(*) AS n, MIN(day) AS oldest FROM network_days WHERE device_id = ?").get(deviceId);
  return { days: row?.n ?? 0, oldest: row?.oldest ?? null };
}

/**
 * Deletes days older than the family keeps (`days` days, 30 by default), with their lookups, and a
 * day no phone can have counted yet. Returns the days deleted.
 */
export function pruneNetwork(db: DB, now: number, days: number): number {
  return db.prepare("DELETE FROM network_days WHERE day < ? OR day > ?").run(networkCutoff(now, days), latestUsageDay(now, "")).changes;
}
