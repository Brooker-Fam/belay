/** Apps, reviews and the timeline, as the parent pages and MCP read them. */
import type { DB } from "../db.js";
import type { AppRow } from "../device/apps.js";

export interface Review {
  id: number;
  reviewedAt: number;
  parentName: string | null;
  /** "web", or the AI client's name. */
  via: string;
  note: string | null;
  versionCode: number | null;
  permissions: string[];
}

export type UnreviewedReason =
  | { kind: "new" }
  | { kind: "reinstalled" }
  | { kind: "permissions"; gained: string[] };

export interface App {
  package: string;
  label: string;
  versionName: string | null;
  versionCode: number;
  firstInstallTime: number | null;
  lastUpdateTime: number | null;
  system: boolean;
  updatedSystem: boolean;
  enabled: boolean;
  launchable: boolean;
  targetSdk: number | null;
  source: string;
  installer: Record<string, unknown> | null;
  permissions: string[];
  detailsKnown: boolean;
  present: boolean;
  firstSeenAt: number;
  installSeenAt: number;
  removedAt: number | null;
  review: Review | null;
  /** Null when a parent has reviewed it since it was installed and it gained nothing since. */
  unreviewed: UnreviewedReason | null;
}

interface ReviewRow {
  id: number;
  package: string;
  reviewed_at: number;
  parent_name: string | null;
  via: string;
  note: string | null;
  version_code: number | null;
  permissions: string;
}

const parseList = (json: string): string[] => {
  try {
    const value = JSON.parse(json) as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
};

function toReview(r: ReviewRow): Review {
  return {
    id: r.id,
    reviewedAt: r.reviewed_at,
    parentName: r.parent_name,
    via: r.via,
    note: r.note,
    versionCode: r.version_code,
    permissions: parseList(r.permissions),
  };
}

/** Why an app needs a parent's look, or null. Only apps the kid can install count: system apps don't. */
export function unreviewedReason(row: Pick<AppRow, "present" | "system" | "install_seen_at" | "permissions">, review: Review | null): UnreviewedReason | null {
  if (row.present !== 1 || row.system === 1) return null;
  if (!review) return { kind: "new" };
  if (review.reviewedAt < row.install_seen_at) return { kind: "reinstalled" };
  const before = new Set(review.permissions);
  const gained = parseList(row.permissions).filter((p) => !before.has(p));
  return gained.length ? { kind: "permissions", gained } : null;
}

function latestReviews(db: DB, deviceId: string): Map<string, Review> {
  const rows = db
    .prepare<[string], ReviewRow>(
      `SELECT r.id, r.package, r.reviewed_at, p.name AS parent_name, r.via, r.note, r.version_code, r.permissions
       FROM reviews r LEFT JOIN parents p ON p.id = r.parent_id
       WHERE r.device_id = ? ORDER BY r.reviewed_at, r.id`,
    )
    .all(deviceId);
  const latest = new Map<string, Review>();
  for (const r of rows) latest.set(r.package, toReview(r));
  return latest;
}

function parseObject(json: string | null): Record<string, unknown> | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function toApp(row: AppRow, review: Review | null): App {
  return {
    package: row.package,
    label: row.label,
    versionName: row.version_name,
    versionCode: row.version_code,
    firstInstallTime: row.first_install_time,
    lastUpdateTime: row.last_update_time,
    system: row.system === 1,
    updatedSystem: row.updated_system === 1,
    enabled: row.enabled === 1,
    launchable: row.launchable === 1,
    targetSdk: row.target_sdk,
    source: row.source,
    installer: parseObject(row.installer),
    permissions: parseList(row.permissions),
    detailsKnown: row.details_known === 1,
    present: row.present === 1,
    firstSeenAt: row.first_seen_at,
    installSeenAt: row.install_seen_at,
    removedAt: row.removed_at,
    review,
    unreviewed: unreviewedReason(row, review),
  };
}

export interface AppFilter {
  includeSystem?: boolean;
  includeRemoved?: boolean;
  /** Matches the label or the package name, ignoring case. */
  query?: string;
  /** Only apps holding this permission category. */
  permission?: string;
  unreviewedOnly?: boolean;
}

export function listApps(db: DB, deviceId: string, filter: AppFilter = {}): App[] {
  const reviews = latestReviews(db, deviceId);
  const query = filter.query?.trim().toLowerCase();
  return db
    .prepare<[string], AppRow>("SELECT * FROM apps WHERE device_id = ? ORDER BY label COLLATE NOCASE, package")
    .all(deviceId)
    .map((row) => toApp(row, reviews.get(row.package) ?? null))
    .filter(
      (app) =>
        (filter.includeRemoved || app.present) &&
        (filter.includeSystem || !app.system) &&
        (!query || app.label.toLowerCase().includes(query) || app.package.toLowerCase().includes(query)) &&
        (!filter.permission || app.permissions.includes(filter.permission)) &&
        (!filter.unreviewedOnly || app.unreviewed !== null),
    );
}

export function getApp(db: DB, deviceId: string, pkg: string): App | null {
  const row = db.prepare<[string, string], AppRow>("SELECT * FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg);
  return row ? toApp(row, latestReviews(db, deviceId).get(pkg) ?? null) : null;
}

export function appCounts(db: DB, deviceId: string): { userApps: number; unreviewed: number } {
  const apps = listApps(db, deviceId);
  return { userApps: apps.length, unreviewed: apps.filter((a) => a.unreviewed).length };
}

export function reviewHistory(db: DB, deviceId: string, pkg: string): Review[] {
  return db
    .prepare<[string, string], ReviewRow>(
      `SELECT r.id, r.package, r.reviewed_at, p.name AS parent_name, r.via, r.note, r.version_code, r.permissions
       FROM reviews r LEFT JOIN parents p ON p.id = r.parent_id
       WHERE r.device_id = ? AND r.package = ? ORDER BY r.reviewed_at DESC, r.id DESC`,
    )
    .all(deviceId, pkg)
    .map(toReview);
}

export const NOTE_MAX = 2000;

/**
 * Records that a parent looked at these apps (on the web, or through an AI client they
 * connected). It changes nothing on the phone. Packages the phone doesn't have are returned
 * as `unknown`.
 */
export function markReviewed(
  db: DB,
  now: number,
  input: { deviceId: string; packages: string[]; note?: string | null; parentId: string; via: string },
): { marked: App[]; unknown: string[] } {
  return db.transaction(() => {
    const marked: App[] = [];
    const unknown: string[] = [];
    const note = input.note?.trim().slice(0, NOTE_MAX) || null;
    for (const pkg of [...new Set(input.packages)]) {
      const row = db.prepare<[string, string], AppRow>("SELECT * FROM apps WHERE device_id = ? AND package = ? AND present = 1").get(input.deviceId, pkg);
      if (!row) {
        unknown.push(pkg);
        continue;
      }
      db.prepare(
        "INSERT INTO reviews (device_id, package, reviewed_at, parent_id, via, note, version_code, permissions) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(input.deviceId, pkg, now, input.parentId, input.via, note, row.version_code, row.permissions);
      marked.push(toApp(row, null));
    }
    return { marked, unknown };
  }).immediate();
}

export interface Change {
  /** Opaque cursor for paging. */
  cursor: string;
  deviceId: string;
  deviceName: string;
  kind: "installed" | "updated" | "removed" | "reinstalled";
  package: string;
  label: string;
  fromName: string | null;
  fromCode: number | null;
  toName: string | null;
  toCode: number | null;
  /** When it happened, as best known (see device/apps.ts eventTime). */
  at: number;
  detectedAt: number;
  detection: string;
  backfilled: boolean;
  system: boolean;
}

interface ChangeRow {
  rowid: number;
  device_id: string;
  device_name: string;
  kind: Change["kind"];
  package: string;
  label: string;
  from_name: string | null;
  from_code: number | null;
  to_name: string | null;
  to_code: number | null;
  at: number;
  detected_at: number;
  detection: string;
  backfilled: number;
  system: number | null;
}

export interface ChangeFilter {
  deviceId?: string;
  package?: string;
  since?: number;
  until?: number;
  includeSystem?: boolean;
  /** A cursor from a previous page: only older changes. */
  before?: string;
  limit: number;
}

/** App changes, newest first. */
export function listChanges(db: DB, filter: ChangeFilter): Change[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.deviceId) {
    where.push("e.device_id = ?");
    args.push(filter.deviceId);
  }
  if (filter.package) {
    where.push("e.package = ?");
    args.push(filter.package);
  }
  if (filter.since !== undefined) {
    where.push("e.at >= ?");
    args.push(filter.since);
  }
  if (filter.until !== undefined) {
    where.push("e.at < ?");
    args.push(filter.until);
  }
  if (!filter.includeSystem) where.push("COALESCE(a.system, 0) = 0");
  const cursor = /^(\d+):(\d+)$/.exec(filter.before ?? "");
  if (cursor) {
    where.push("(e.at < ? OR (e.at = ? AND e.rowid < ?))");
    args.push(Number(cursor[1]), Number(cursor[1]), Number(cursor[2]));
  }
  const rows = db
    .prepare<(string | number)[], ChangeRow>(
      `SELECT e.rowid, e.device_id, d.name AS device_name, e.kind, e.package, e.label, e.from_name, e.from_code, e.to_name, e.to_code,
              e.at, e.detected_at, e.detection, e.backfilled, a.system
       FROM app_events e
       JOIN devices d ON d.id = e.device_id
       LEFT JOIN apps a ON a.device_id = e.device_id AND a.package = e.package
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY e.at DESC, e.rowid DESC LIMIT ?`,
    )
    .all(...args, filter.limit);
  return rows.map((r) => ({
    cursor: `${r.at}:${r.rowid}`,
    deviceId: r.device_id,
    deviceName: r.device_name,
    kind: r.kind,
    package: r.package,
    label: r.label,
    fromName: r.from_name,
    fromCode: r.from_code,
    toName: r.to_name,
    toCode: r.to_code,
    at: r.at,
    detectedAt: r.detected_at,
    detection: r.detection,
    backfilled: r.backfilled === 1,
    system: r.system === 1,
  }));
}

// ── Words for the pages and MCP ─────────────────────────────────────────

export const SOURCE_NAMES: Record<string, string> = {
  play_store: "Play Store",
  other_store: "another app store",
  other_app: "another app on the phone",
  sideloaded: "a downloaded file (sideloaded)",
  adb: "a computer over USB (adb)",
  preinstalled: "preinstalled",
  unknown: "unknown",
};

export const PERMISSION_NAMES: Record<string, string> = {
  camera: "Camera",
  microphone: "Microphone",
  location: "Location",
  contacts: "Contacts",
  sms: "Text messages",
  call_log: "Call history",
  photos_media: "Photos and media",
  nearby_devices: "Nearby devices",
  notification_access: "Reads notifications",
  accessibility: "Accessibility (can see and control the screen)",
  device_admin: "Device admin",
};

export const DETECTION_NAMES: Record<string, string> = {
  broadcast: "noticed right away",
  changed_packages: "noticed at Belay's next check",
  snapshot: "found by snapshot",
};

export function playStoreUrl(pkg: string): string {
  return `https://play.google.com/store/apps/details?id=${encodeURIComponent(pkg)}`;
}

export function versionText(name: string | null, code: number | null): string {
  if (name) return name;
  return code === null ? "unknown version" : `version ${code}`;
}
