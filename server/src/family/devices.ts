/** The family's phones as the parent pages and MCP show them, with what needs attention. */
import type { DB } from "../db.js";
import type { Device, Enforcement } from "../device/schemas.js";
import type { Settings } from "../settings.js";
import { formatAgo, formatDuration } from "../time.js";

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
  /** Phase 6: the first signing certificate the phone reported (pinned). */
  agent_signing_sha256: string | null;
  agent_signing_at: number | null;
  /** Phase 6: the update offered to the phone (agent_offers, agent_files), if any. */
  update_version_code: number | null;
  update_version_name: string | null;
  update_offered_at: number | null;
  update_state: UpdateView["state"];
  update_problem: string | null;
  update_state_at: number | null;
  update_installing_at: number | null;
  update_done_at: number | null;
  /** Phase 6: when the phone's newest recovery key was used, by the phone's clock (null: not used, or none). */
  recovery_used_at: number | null;
  /** Phase 3: whether the phone's rules measure screen time (1), and what they do when Belay can't count. */
  st_measure: number | null;
  st_if_unmeasured: "pause_limited" | "keep_open";
  /** Phase 4: whether the phone shares where it is, keeps location on, and is in lost mode (null: no location settings). */
  loc_mode: "off" | "on_demand" | "periodic" | null;
  loc_keep_on: number | null;
  loc_lost_since: number | null;
  /** Phase 5: whether calls are on (Belay should be the phone app); null: never turned on. */
  calls_on: number | null;
  /** Phase 3: whether network logging is on; null: never turned on. */
  net_on: number | null;
}

const DEVICE_SELECT = `SELECT d.*, p.version AS policy_version, p.changed_at AS policy_changed_at,
    f.version_code AS update_version_code, f.version_name AS update_version_name, o.offered_at AS update_offered_at, o.state AS update_state,
    o.problem AS update_problem, o.state_at AS update_state_at, o.installing_at AS update_installing_at, o.done_at AS update_done_at,
    (SELECT k.used_at FROM recovery_keys k WHERE k.device_id = d.id ORDER BY k.version DESC LIMIT 1) AS recovery_used_at,
    st.measure AS st_measure,
    COALESCE(st.if_unmeasured, json_extract(sg.rules, '$.if_unmeasured'), 'pause_limited') AS st_if_unmeasured,
    ls.mode AS loc_mode, ls.keep_on AS loc_keep_on, ls.lost_since AS loc_lost_since,
    cs.enabled AS calls_on,
    ns.enabled AS net_on
  FROM devices d LEFT JOIN policies p ON p.device_id = d.id
  LEFT JOIN agent_offers o ON o.device_id = d.id LEFT JOIN agent_files f ON f.sha256 = o.sha256
  LEFT JOIN screen_time_rules st ON st.device_id = d.id
  LEFT JOIN phone_stages ps ON ps.device_id = d.id LEFT JOIN stages sg ON sg.id = ps.stage_id
  LEFT JOIN location_settings ls ON ls.device_id = d.id
  LEFT JOIN call_settings cs ON cs.device_id = d.id
  LEFT JOIN network_settings ns ON ns.device_id = d.id`;

/** Phase 6: the update a parent offered the phone, and what the phone last said about it. */
export interface UpdateView {
  versionCode: number;
  versionName: string | null;
  /** "0.4.0 (version 4)" */
  words: string;
  offeredAt: number;
  state: "downloading" | "checking" | "installing" | "failed" | "done" | null;
  /** The phone's words when it failed: untrusted. */
  problem: string | null;
  stateAt: number | null;
  installingAt: number | null;
  /** When the phone first ran this version or a newer one. */
  doneAt: number | null;
}

/** How long after an update the server watches for silence, and how much silence then is a problem. */
export const UPDATE_WATCH_MS = 3_600_000;
export const UPDATE_SILENCE_MS = 30 * 60_000;

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
    | "tampering"
    | "signing_changed"
    | "update_failed"
    | "update_silent"
    | "recovery_used"
    | "other_users"
    | "screen_time_unmeasured"
    | "location_permission"
    | "location_off"
    | "calls_not_dialer"
    | "network_log_paused";
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
  /** Phase 6: the update offered to the phone, if any. */
  update: UpdateView | null;
  /** Phase 6: the signing certificate pinned for the phone, and whether it reports another one now. */
  signing: { pinned: string | null; pinnedAt: number | null; reported: string | null; changed: boolean };
  status: DeviceStatus;
  problems: Problem[];
}

function updateOf(row: DeviceRow): UpdateView | null {
  if (row.update_version_code === null || row.update_offered_at === null) return null;
  return {
    versionCode: row.update_version_code,
    versionName: row.update_version_name,
    words: row.update_version_name ? `${row.update_version_name} (version ${row.update_version_code})` : `version ${row.update_version_code}`,
    offeredAt: row.update_offered_at,
    state: row.update_state,
    problem: row.update_problem,
    stateAt: row.update_state_at,
    installingAt: row.update_installing_at,
    doneAt: row.update_done_at,
  };
}

/** A different certificate than the one pinned: someone may have put another build of Belay on the phone. */
function signingChanged(row: DeviceRow, facts: Device | null): boolean {
  const reported = facts?.agent_signing_sha256 ?? null;
  return row.agent_signing_sha256 !== null && reported !== null && reported !== row.agent_signing_sha256;
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

/** What the phone said in its latest check-in or app list (or when it enrolled), or null. */
export function deviceFacts(db: DB, deviceId: string): Device | null {
  return parseFacts(db.prepare<[string], { facts: string | null }>("SELECT facts FROM devices WHERE id = ?").get(deviceId)?.facts ?? null);
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
    // Phase 3: the phone can't count screen time while it measures, or has limits to count.
    const st = facts.enforcement?.screen_time;
    if (st && !st.measured && (row.st_measure === 1 || st.limits.length > 0)) {
      const limited = st.limits.length > 0;
      const then = !limited
        ? ""
        : row.st_if_unmeasured === "keep_open"
          ? ". Apps with a time limit stay open until it's back on, as the rules say"
          : ". Apps with a time limit are paused until it's back on";
      problems.push({ code: "screen_time_unmeasured", text: `Usage access for Belay is turned off, so Belay can't count screen time${then}` });
    } else if (!h.usage_access) problems.push({ code: "usage_access_off", text: "Usage access for Belay is turned off" });
    if (!h.battery_exempt) problems.push({ code: "battery_optimized", text: "Battery optimization is on for Belay, so it may miss changes" });
    if (!h.notifications_shown) problems.push({ code: "notifications_off", text: "Belay's notifications are turned off" });
    if (h.background_restricted) problems.push({ code: "background_restricted", text: "Background use is restricted for Belay" });
    for (const p of h.permissions) {
      const name = p.name.replace(/^android\.permission\./, "");
      if (!p.granted && NEEDED_PERMISSIONS.has(name)) problems.push({ code: "permission_missing", text: `Belay is missing the ${name} permission` });
    }
    // Phase 4: while the family has the phone share where it is (or it's lost), and the phone says it can't.
    const location = facts.enforcement?.location;
    if (location && row.loc_mode !== null && (row.loc_mode !== "off" || row.loc_lost_since !== null)) {
      if (!location.permission) problems.push({ code: "location_permission", text: "Belay doesn't have location permission on the phone, so it can't share where the phone is" });
      else if (!location.location_on) {
        problems.push({
          code: "location_off",
          text: `Location is turned off on the phone, so Belay can't share where it is${row.loc_keep_on === 1 ? "" : ". Keeping location on, on the phone's Location and help tab, stops the kid turning it off"}`,
        });
      }
    }
    // Phase 5: with calls on, Belay should be the phone app. If it isn't, Telecom uses the phone's own
    // dialer, unfiltered, on purpose: calls still work, but Belay can't decide who rings.
    const calls = facts.enforcement?.calls;
    if (calls && row.calls_on === 1 && !calls.dialer) {
      problems.push({ code: "calls_not_dialer", text: "Calls are going through the phone's own app, so Belay can't decide who rings or keep a record of calls. Calls, 911 and 988 still work" });
    }
    if (calls?.problem && row.calls_on === 1) problems.push({ code: "phone_reported", text: `Belay on the phone says: ${calls.problem}`, fromPhone: calls.problem });
    // Phase 3: with network logging on, Android pauses it while another user or profile is on the phone (platform notes W1, V2).
    if (facts.enforcement?.network_log?.paused && row.net_on === 1) {
      problems.push({
        code: "network_log_paused",
        text: "Network logging is paused: Android stops it while another user or profile is on the phone, so Belay can't note which websites apps look up until it's gone",
      });
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
  // Phase 6: the update offered to the phone.
  const update = updateOf(row);
  const running = facts?.agent_version_code ?? null;
  if (update && update.doneAt === null && update.state === "failed" && (running === null || running < update.versionCode)) {
    problems.push({ code: "update_failed", text: `Belay couldn't update to ${update.words}; it can still be updated over adb in maintenance mode` });
  }
  const updatedAt = update ? (update.doneAt ?? update.installingAt) : null;
  if (update && updatedAt !== null && row.last_seen_at !== null && row.last_seen_at - updatedAt <= UPDATE_WATCH_MS && now - row.last_seen_at > UPDATE_SILENCE_MS) {
    problems.push({
      code: "update_silent",
      text: `The phone went quiet within an hour of updating Belay to ${update.words}, and hasn't been heard from for ${formatDuration(now - row.last_seen_at)}. If the new version doesn't start, update it over adb in maintenance mode`,
    });
  }
  // Phase 6: the recovery key works once; after a use, the phone needs a new one.
  if (row.recovery_used_at !== null) {
    problems.push({ code: "recovery_used", text: `The phone reports the recovery key was used on it ${formatAgo(row.recovery_used_at, now)}, so it won't work again: make a new one on the phone's page` });
  }
  const tampering: Problem[] = [];
  // Phase 10: Belay counts the users and profiles besides the kid's own; it can't see what kind they are.
  const others = facts?.health.other_users ?? 0;
  if (others > 0) {
    tampering.push({
      code: "other_users",
      text: `${others === 1 ? "Another user or profile is" : `${others} other users or profiles are`} on this phone. This usually means Android's own Parental Controls were set up in Settings`,
    });
  }
  if (signingChanged(row, facts)) {
    tampering.push({
      code: "signing_changed",
      text: "Belay on the phone is signed with a different key than when it was set up. Someone may have replaced it with another build of Belay",
    });
  }
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
    update: updateOf(row),
    signing: { pinned: row.agent_signing_sha256, pinnedAt: row.agent_signing_at, reported: facts?.agent_signing_sha256 ?? null, changed: signingChanged(row, facts) },
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
