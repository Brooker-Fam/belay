/** The family's phones as the parent pages and MCP show them, with what needs attention. */
import type { DB } from "../db.js";
import type { Device } from "../device/schemas.js";
import type { Settings } from "../settings.js";
import { formatDuration } from "../time.js";

export interface DeviceRow {
  id: string;
  name: string;
  token_hash: string | null;
  enrolled_at: number;
  revoked_at: number | null;
  last_seen_at: number | null;
  last_checkin_at: number | null;
  last_inventory_at: number | null;
  facts: string | null;
  facts_at: number | null;
}

/** Something about a phone a parent should know, in plain words. */
export interface Problem {
  code:
    | "disconnected"
    | "silent"
    | "not_device_owner"
    | "uninstall_allowed"
    | "service_stopped"
    | "usage_access_off"
    | "battery_optimized"
    | "notifications_off"
    | "background_restricted"
    | "permission_missing"
    | "clock_off"
    | "no_app_list";
  text: string;
}

export type DeviceStatus = "ok" | "attention" | "silent" | "disconnected";

export interface DeviceView {
  id: string;
  name: string;
  enrolledAt: number;
  revokedAt: number | null;
  lastSeenAt: number | null;
  lastCheckinAt: number | null;
  lastInventoryAt: number | null;
  facts: Device | null;
  factsAt: number | null;
  status: DeviceStatus;
  problems: Problem[];
}

/** Belay's own runtime permissions it can't work without (others, like CAMERA for enrolling, are optional). */
const NEEDED_PERMISSIONS = new Set(["POST_NOTIFICATIONS"]);
const CLOCK_TOLERANCE_MS = 10 * 60_000;
const INVENTORY_EXPECTED_MS = 36 * 3_600_000;

function parseFacts(json: string | null): Device | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Device;
  } catch {
    return null;
  }
}

export function problemsOf(row: DeviceRow, facts: Device | null, settings: Settings, now: number): Problem[] {
  if (row.revoked_at !== null) return [{ code: "disconnected", text: "Disconnected: a parent removed this phone's access" }];
  const problems: Problem[] = [];
  const lastContact = row.last_seen_at ?? row.enrolled_at;
  if (now - lastContact > settings.silentHours * 3_600_000) {
    problems.push({ code: "silent", text: `Silent for ${formatDuration(now - lastContact)}` });
  }
  if (facts) {
    const h = facts.health;
    if (!h.device_owner) problems.push({ code: "not_device_owner", text: "Belay is no longer the device owner" });
    else if (h.uninstall_blocked === false) problems.push({ code: "uninstall_allowed", text: "Belay can be uninstalled" });
    if (!h.service_running) problems.push({ code: "service_stopped", text: "Belay's background service isn't running" });
    if (!h.usage_access) problems.push({ code: "usage_access_off", text: "Usage access for Belay is turned off" });
    if (!h.battery_exempt) problems.push({ code: "battery_optimized", text: "Battery optimization is on for Belay, so it may miss changes" });
    if (!h.notifications_shown) problems.push({ code: "notifications_off", text: "Belay's notifications are turned off" });
    if (h.background_restricted) problems.push({ code: "background_restricted", text: "Background use is restricted for Belay" });
    for (const p of h.permissions) {
      const name = p.name.replace(/^android\.permission\./, "");
      if (!p.granted && NEEDED_PERMISSIONS.has(name)) problems.push({ code: "permission_missing", text: `Belay is missing the ${name} permission` });
    }
    if (row.facts_at !== null && Math.abs(facts.device_time - row.facts_at) > CLOCK_TOLERANCE_MS) {
      const off = facts.device_time - row.facts_at;
      problems.push({ code: "clock_off", text: `The phone's clock is ${formatDuration(Math.abs(off))} ${off > 0 ? "ahead" : "behind"}` });
    }
  }
  const lastList = row.last_inventory_at ?? row.enrolled_at;
  if (now - lastList > INVENTORY_EXPECTED_MS && !problems.some((p) => p.code === "silent")) {
    problems.push({ code: "no_app_list", text: `No app list from the phone for ${formatDuration(now - lastList)}` });
  }
  return problems;
}

function statusOf(problems: Problem[]): DeviceStatus {
  if (problems.some((p) => p.code === "disconnected")) return "disconnected";
  if (problems.some((p) => p.code === "silent")) return "silent";
  return problems.length ? "attention" : "ok";
}

export function toView(row: DeviceRow, settings: Settings, now: number): DeviceView {
  const facts = parseFacts(row.facts);
  const problems = problemsOf(row, facts, settings, now);
  return {
    id: row.id,
    name: row.name,
    enrolledAt: row.enrolled_at,
    revokedAt: row.revoked_at,
    lastSeenAt: row.last_seen_at,
    lastCheckinAt: row.last_checkin_at,
    lastInventoryAt: row.last_inventory_at,
    facts,
    factsAt: row.facts_at,
    status: statusOf(problems),
    problems,
  };
}

export function listDevices(db: DB, settings: Settings, now: number): DeviceView[] {
  return db
    .prepare<[], DeviceRow>("SELECT * FROM devices ORDER BY revoked_at IS NOT NULL, name COLLATE NOCASE")
    .all()
    .map((row) => toView(row, settings, now));
}

export function getDevice(db: DB, id: string, settings: Settings, now: number): DeviceView | null {
  const row = db.prepare<[string], DeviceRow>("SELECT * FROM devices WHERE id = ?").get(id);
  return row ? toView(row, settings, now) : null;
}

/** A phone by the name a parent or AI client uses for it, ignoring case and surrounding space. */
export function findDeviceByName(db: DB, name: string): DeviceRow | undefined {
  return db
    .prepare<[string], DeviceRow>("SELECT * FROM devices WHERE name = ? COLLATE NOCASE ORDER BY revoked_at IS NOT NULL LIMIT 1")
    .get(name.trim());
}

export function nameTaken(db: DB, name: string, exceptId?: string): boolean {
  return !!db.prepare("SELECT 1 FROM devices WHERE name = ? COLLATE NOCASE AND id != ?").get(name.trim(), exceptId ?? "");
}

export function renameDevice(db: DB, id: string, name: string): void {
  db.prepare("UPDATE devices SET name = ? WHERE id = ?").run(name.trim(), id);
}

/** The phone's token stops working at once. Its history stays; Reconnect gives it a new token. */
export function revokeDevice(db: DB, id: string, now: number): boolean {
  return db.prepare("UPDATE devices SET token_hash = NULL, revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(now, id).changes === 1;
}

/** Deletes a disconnected phone and everything recorded about it. */
export function deleteDevice(db: DB, id: string): boolean {
  return db.prepare("DELETE FROM devices WHERE id = ? AND revoked_at IS NOT NULL").run(id).changes === 1;
}

/** "37.2, patch 2026-11-05 (12 days old)" */
export function patchAgeDays(facts: Device, now: number): number | null {
  const ms = Date.parse(`${facts.security_patch}T00:00:00Z`);
  return Number.isNaN(ms) ? null : Math.max(0, Math.floor((now - ms) / 86_400_000));
}
