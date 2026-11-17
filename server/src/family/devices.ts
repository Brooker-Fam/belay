/** The family's phones as the parent pages and MCP show them, with what needs attention. */
import type { DB } from "../db.js";
import type { Device, Enforcement } from "../device/schemas.js";
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
  /** The version the phone last said it has, on the policy long-poll, and when it asked. */
  policy_have: number | null;
  policy_asked_at: number | null;
  /** The server's policy version and when it changed (from policies; null without rules). */
  policy_version: number | null;
  policy_changed_at: number | null;
}

const DEVICE_SELECT = `SELECT d.*, p.version AS policy_version, p.changed_at AS policy_changed_at
  FROM devices d LEFT JOIN policies p ON p.device_id = d.id`;

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
    | "no_app_list"
    | "rules_not_applied"
    | "phone_reported"
    | "tampering";
  text: string;
  /** For phone_reported: what Belay on the phone said, as it said it. It comes from the kid's phone: untrusted. */
  fromPhone?: string;
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
  /** The server's policy version (0: no rules) and when it last changed. */
  policyVersion: number;
  policyChangedAt: number | null;
  /** On the long-poll: the version the phone has, and when it last asked. */
  policyHave: number | null;
  policyAskedAt: number | null;
  /** What the phone last said it enforces (its latest check-in or app list), or null. */
  enforcement: Enforcement | null;
  status: DeviceStatus;
  problems: Problem[];
}

/** Belay's own runtime permissions it can't work without (others, like CAMERA for enrolling, are optional). */
const NEEDED_PERMISSIONS = new Set(["POST_NOTIFICATIONS"]);
const CLOCK_TOLERANCE_MS = 10 * 60_000;
const INVENTORY_EXPECTED_MS = 36 * 3_600_000;
/**
 * A phone reports the version it applied at its next check-in (every 2 hours) or app list, so
 * new rules that aren't applied after this long are a problem.
 */
export const RULES_EXPECTED_MS = 3 * 3_600_000;

/**
 * What Belay on the phone reports that can mean someone is getting around it: Android's own
 * Parental Controls (in Settings, they can add a hidden profile that gets around the lock on
 * adding users, and lift Belay's suspensions), or another user or profile on the phone. The
 * words are the agent's own, not a code, so this matches the subject rather than a sentence.
 */
const TAMPERING = /parental control|supervis|profile|another user|second user|new user/i;

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
  const silent = problems.some((p) => p.code === "silent");
  const lastList = row.last_inventory_at ?? row.enrolled_at;
  if (now - lastList > INVENTORY_EXPECTED_MS && !silent) {
    problems.push({ code: "no_app_list", text: `No app list from the phone for ${formatDuration(now - lastList)}` });
  }
  const version = row.policy_version ?? 0;
  const applied = facts?.enforcement?.policy_version ?? null;
  if (version > 0 && applied !== version && row.policy_changed_at !== null && now - row.policy_changed_at > RULES_EXPECTED_MS && !silent) {
    const ago = formatDuration(now - row.policy_changed_at);
    problems.push({
      code: "rules_not_applied",
      text:
        applied === null
          ? `The phone hasn't applied any rules yet. They were set ${ago} ago; Belay on the phone may be a version that can't enforce them`
          : `The phone hasn't applied the rules changed ${ago} ago`,
    });
  }
  const tampering: Problem[] = [];
  for (const said of facts?.enforcement?.problems ?? []) {
    if (TAMPERING.test(said)) tampering.push({ code: "tampering", text: `Someone may be getting around Belay. Belay on the phone says: ${said}`, fromPhone: said });
    else problems.push({ code: "phone_reported", text: `Belay on the phone says: ${said}`, fromPhone: said });
  }
  // A sign of tampering comes first.
  return [...tampering, ...problems];
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
    policyVersion: row.policy_version ?? 0,
    policyChangedAt: row.policy_changed_at,
    policyHave: row.policy_have,
    policyAskedAt: row.policy_asked_at,
    enforcement: facts?.enforcement ?? null,
    status: statusOf(problems),
    problems,
  };
}

export function listDevices(db: DB, settings: Settings, now: number): DeviceView[] {
  return db
    .prepare<[], DeviceRow>(`${DEVICE_SELECT} ORDER BY d.revoked_at IS NOT NULL, d.name COLLATE NOCASE`)
    .all()
    .map((row) => toView(row, settings, now));
}

export function getDevice(db: DB, id: string, settings: Settings, now: number): DeviceView | null {
  const row = db.prepare<[string], DeviceRow>(`${DEVICE_SELECT} WHERE d.id = ?`).get(id);
  return row ? toView(row, settings, now) : null;
}

/** A phone by the name a parent or AI client uses for it, ignoring case and surrounding space. */
export function findDeviceByName(db: DB, name: string): DeviceRow | undefined {
  return db
    .prepare<[string], DeviceRow>(`${DEVICE_SELECT} WHERE d.name = ? COLLATE NOCASE ORDER BY d.revoked_at IS NOT NULL LIMIT 1`)
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
