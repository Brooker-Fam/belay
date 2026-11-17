/**
 * What the server knows about each phone's apps, kept up to date from the phone's events and
 * snapshots (docs/protocol.md).
 *
 * Both are applied in the order they arrive: the agent sends events and inventories in the
 * order it made them. Each snapshot is compared with the current state, and any change no
 * event reported is recorded ("found by snapshot", backfilled = 1). When the phone's own
 * event for that change arrives later, it takes the backfill's place, so a change is listed
 * once.
 */
import { newId } from "../crypto.js";
import type { DB } from "../db.js";
import type { Event, InventoryRequest, Package } from "./schemas.js";

export type ChangeKind = Event["kind"];

export interface AppRow {
  device_id: string;
  package: string;
  label: string;
  version_name: string | null;
  version_code: number;
  first_install_time: number | null;
  last_update_time: number | null;
  system: number;
  updated_system: number;
  enabled: number;
  launchable: number;
  target_sdk: number | null;
  category: number | null;
  source: string;
  installer: string | null;
  permissions: string;
  details_known: number;
  present: number;
  first_seen_at: number;
  install_seen_at: number;
  removed_at: number | null;
}

const COLUMNS = [
  "device_id",
  "package",
  "label",
  "version_name",
  "version_code",
  "first_install_time",
  "last_update_time",
  "system",
  "updated_system",
  "enabled",
  "launchable",
  "target_sdk",
  "category",
  "source",
  "installer",
  "permissions",
  "details_known",
  "present",
  "first_seen_at",
  "install_seen_at",
  "removed_at",
] as const satisfies readonly (keyof AppRow)[];

function writeApp(db: DB, row: AppRow): void {
  const names = COLUMNS.join(", ");
  const values = COLUMNS.map((c) => `@${c}`).join(", ");
  const updates = COLUMNS.filter((c) => c !== "device_id" && c !== "package")
    .map((c) => `${c} = excluded.${c}`)
    .join(", ");
  db.prepare(`INSERT INTO apps (${names}) VALUES (${values}) ON CONFLICT (device_id, package) DO UPDATE SET ${updates}`).run(row);
}

function getApp(db: DB, deviceId: string, pkg: string): AppRow | undefined {
  return db.prepare<[string, string], AppRow>("SELECT * FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg);
}

/** The row's details from a full Package object. */
function withDetails(row: AppRow, pkg: Package): AppRow {
  return {
    ...row,
    label: pkg.label,
    version_name: pkg.version_name ?? null,
    version_code: pkg.version_code,
    first_install_time: pkg.first_install_time,
    last_update_time: pkg.last_update_time,
    system: pkg.system ? 1 : 0,
    updated_system: pkg.updated_system ? 1 : 0,
    enabled: pkg.enabled ? 1 : 0,
    launchable: pkg.launchable ? 1 : 0,
    target_sdk: pkg.target_sdk,
    category: pkg.category,
    source: pkg.source,
    installer: JSON.stringify(pkg.installer),
    permissions: JSON.stringify(pkg.permissions),
    details_known: 1,
  };
}

/** A row for a package the server has no details for yet (until the next snapshot). */
function bareRow(deviceId: string, pkg: string, label: string, now: number): AppRow {
  return {
    device_id: deviceId,
    package: pkg,
    label,
    version_name: null,
    version_code: 0,
    first_install_time: null,
    last_update_time: null,
    system: 0,
    updated_system: 0,
    enabled: 1,
    launchable: 1,
    target_sdk: null,
    category: null,
    source: "unknown",
    installer: null,
    permissions: "[]",
    details_known: 0,
    present: 1,
    first_seen_at: now,
    install_seen_at: now,
    removed_at: null,
  };
}

interface NewEvent {
  id: string;
  kind: ChangeKind;
  package: string;
  label: string;
  from?: { name?: string | null; code: number } | null;
  to?: { name?: string | null; code: number } | null;
  happened_at?: number | null;
  detected_at: number;
  detection: string;
  backfilled: boolean;
}

/** When a change happened, as best known: the package's own time, never later than the server heard of it. */
export function eventTime(happenedAt: number | null | undefined, detectedAt: number, receivedAt: number): number {
  return Math.min(happenedAt ?? detectedAt, receivedAt);
}

function insertEvent(db: DB, deviceId: string, e: NewEvent, now: number): void {
  db.prepare(
    `INSERT INTO app_events (device_id, id, kind, package, label, from_name, from_code, to_name, to_code,
       happened_at, detected_at, detection, backfilled, received_at, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    deviceId,
    e.id,
    e.kind,
    e.package,
    e.label,
    e.from?.name ?? null,
    e.from?.code ?? null,
    e.to?.name ?? null,
    e.to?.code ?? null,
    e.happened_at ?? null,
    e.detected_at,
    e.detection,
    e.backfilled ? 1 : 0,
    now,
    eventTime(e.happened_at, e.detected_at, now),
  );
}

interface EventRef {
  id: string;
  backfilled: number;
  from_code: number | null;
  to_code: number | null;
  happened_at: number | null;
}

/** The snapshot backfill this phone event describes, if the server recorded the change first. */
function matchingBackfill(db: DB, deviceId: string, e: Event): EventRef | undefined {
  const latest = db
    .prepare<[string, string, string], EventRef>(
      `SELECT id, backfilled, from_code, to_code, happened_at FROM app_events
       WHERE device_id = ? AND package = ? AND kind = ? ORDER BY received_at DESC, rowid DESC LIMIT 5`,
    )
    .all(deviceId, e.package, e.kind)
    .filter((b) => b.backfilled === 1);
  if (e.kind === "removed") {
    // A removal has no time of its own: it matches a backfilled removal that is still the
    // latest thing recorded for the package.
    const newest = db
      .prepare<[string, string], { id: string }>(
        "SELECT id FROM app_events WHERE device_id = ? AND package = ? ORDER BY received_at DESC, rowid DESC LIMIT 1",
      )
      .get(deviceId, e.package);
    const candidate = latest[0];
    if (!candidate || newest?.id !== candidate.id) return undefined;
    return e.from == null || candidate.from_code == null || candidate.from_code === e.from.code ? candidate : undefined;
  }
  return latest.find((b) => b.happened_at === (e.happened_at ?? null) && (e.to == null || b.to_code === e.to.code));
}

function applyEvent(db: DB, deviceId: string, e: Event, now: number): void {
  const row = getApp(db, deviceId, e.package);
  const present = row?.present === 1;
  if (e.kind === "removed") {
    const base = row ?? { ...bareRow(deviceId, e.package, e.label, now), version_name: e.from?.name ?? null, version_code: e.from?.code ?? 0 };
    writeApp(db, { ...base, present: 0, removed_at: now });
    return;
  }

  // An older account than what the server already has (the package's own clock says so): keep it as history only.
  if (row && present && e.happened_at != null) {
    const known = e.kind === "updated" ? row.last_update_time : row.first_install_time;
    if (known != null && e.happened_at < known) return;
  }

  const isInstall = e.kind === "installed" || e.kind === "reinstalled";
  // A new install, as far as the server knows: it needs a parent's review again.
  const newInstall = !row || !present || (isInstall && (row.first_install_time == null || e.happened_at !== row.first_install_time));
  let next: AppRow = row ? { ...row } : bareRow(deviceId, e.package, e.label, now);
  if (newInstall && row) {
    // Details from before the app was removed or reinstalled no longer hold.
    next = { ...bareRow(deviceId, e.package, e.label, now), first_seen_at: row.first_seen_at };
  }
  next.label = e.label;
  next.present = 1;
  next.removed_at = null;
  if (e.to) {
    next.version_name = e.to.name ?? null;
    next.version_code = e.to.code;
  }
  if (e.happened_at != null) {
    if (isInstall) next.first_install_time = e.happened_at;
    next.last_update_time = e.happened_at;
  }
  if (newInstall) next.install_seen_at = now;
  if (e.app && e.app.package === e.package) next = withDetails(next, e.app);
  writeApp(db, next);
}

export interface EventsResult {
  accepted: number;
  duplicates: number;
}

export function applyEvents(db: DB, deviceId: string, events: Event[], now: number): EventsResult {
  return db.transaction(() => {
    let accepted = 0;
    let duplicates = 0;
    const known = db.prepare<[string, string], { id: string }>("SELECT id FROM app_events WHERE device_id = ? AND id = ?");
    for (const e of events) {
      if (known.get(deviceId, e.id)) {
        duplicates++;
        continue;
      }
      const backfill = matchingBackfill(db, deviceId, e);
      if (backfill) {
        // The server already found this change in a snapshot, and applied it then: keep the
        // phone's account of it (when and how it noticed) in the backfill's place.
        db.prepare("DELETE FROM app_events WHERE device_id = ? AND id = ?").run(deviceId, backfill.id);
        insertEvent(db, deviceId, { ...e, backfilled: false }, now);
      } else {
        insertEvent(db, deviceId, { ...e, backfilled: false }, now);
        applyEvent(db, deviceId, e, now);
      }
      accepted++;
    }
    return { accepted, duplicates };
  }).immediate();
}

export interface InventoryResult {
  duplicate: boolean;
  backfilled: number;
}

/**
 * Applies a snapshot: the phone's whole package list. The first one is the baseline and
 * records no changes. Later ones record what changed since the server last knew.
 */
export function applyInventory(db: DB, deviceId: string, req: InventoryRequest, now: number): InventoryResult {
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM snapshots WHERE device_id = ? AND snapshot_id = ?").get(deviceId, req.snapshot_id)) {
      return { duplicate: true, backfilled: 0 };
    }
    const baseline = !db.prepare("SELECT 1 FROM snapshots WHERE device_id = ? LIMIT 1").get(deviceId);
    const rows = new Map(
      db
        .prepare<[string], AppRow>("SELECT * FROM apps WHERE device_id = ?")
        .all(deviceId)
        .map((r) => [r.package, r]),
    );
    const seen = new Set<string>();
    let backfilled = 0;
    const backfill = (kind: ChangeKind, pkg: string, label: string, from: NewEvent["from"], to: NewEvent["to"], happenedAt: number | null) => {
      insertEvent(
        db,
        deviceId,
        { id: newId(), kind, package: pkg, label, from, to, happened_at: happenedAt, detected_at: req.taken_at, detection: "snapshot", backfilled: true },
        now,
      );
      backfilled++;
    };

    for (const pkg of req.packages) {
      if (seen.has(pkg.package)) continue;
      seen.add(pkg.package);
      const row = rows.get(pkg.package);
      const present = row?.present === 1;
      let kind: ChangeKind | null = null;
      if (!baseline) {
        if (!row || !present) kind = "installed";
        else if (row.first_install_time != null && pkg.first_install_time !== row.first_install_time) kind = "reinstalled";
        else if (pkg.version_code !== row.version_code || (row.last_update_time != null && pkg.last_update_time !== row.last_update_time)) {
          kind = "updated";
        }
      }
      const base = row ?? bareRow(deviceId, pkg.package, pkg.label, now);
      const next = withDetails({ ...base, present: 1, removed_at: null }, pkg);
      if (!row || !present || kind === "reinstalled") next.install_seen_at = now;
      writeApp(db, next);

      const before = row ? { name: row.version_name, code: row.version_code } : null;
      const after = { name: pkg.version_name ?? null, code: pkg.version_code };
      if (kind === "installed") backfill(kind, pkg.package, pkg.label, null, after, pkg.first_install_time);
      if (kind === "reinstalled") backfill(kind, pkg.package, pkg.label, before, after, pkg.first_install_time);
      if (kind === "updated") backfill(kind, pkg.package, pkg.label, before, after, pkg.last_update_time);
    }

    for (const row of rows.values()) {
      if (row.present !== 1 || seen.has(row.package)) continue;
      writeApp(db, { ...row, present: 0, removed_at: now });
      if (!baseline) backfill("removed", row.package, row.label, { name: row.version_name, code: row.version_code }, null, null);
    }

    db.prepare(
      `INSERT INTO snapshots (device_id, snapshot_id, taken_at, boot_count, package_count, received_at, backfilled)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(deviceId, req.snapshot_id, req.taken_at, req.boot_count ?? null, seen.size, now, backfilled);
    db.prepare("UPDATE devices SET last_inventory_at = ? WHERE id = ?").run(now, deviceId);
    return { duplicate: false, backfilled };
  }).immediate();
}
