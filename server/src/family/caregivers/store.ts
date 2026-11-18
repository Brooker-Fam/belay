/**
 * Phase 12: caregivers (docs/design/phase12-caregivers.md), as the server keeps them: someone a
 * parent gave limited access to some of the family's phones, until a time at most 30 days ahead,
 * like a grandparent for a weekend or a coach on a trip. A caregiver is never a parent: their
 * sign-in is auth/caregivers.ts, their pages care/, and what they may see and do goes through
 * careAccess, here. Reads only: what parents change, and what caregivers do, are in changes.ts.
 */
import type { DB } from "../../db.js";
import { LIMITS, type Policy } from "../../device/schemas.js";
import { oneLine } from "../../text.js";
import { locationSettings, takesChecks } from "../location/store.js";

/** What a parent may let a caregiver see and do, each a choice per caregiver, in this order. */
export const CAREGIVER_CAN = ["status", "pause", "help", "locate"] as const;
export type CaregiverCan = (typeof CAREGIVER_CAN)[number];

/** The recommended choices: the phone's status, pausing and locking it, and the kid's "I need help"; not where it is. */
export const DEFAULT_CAN: Readonly<Record<CaregiverCan, boolean>> = { status: true, pause: true, help: true, locate: false };

/**
 * Each choice in plain words: `detail` for the parent's form, `yours` for the caregiver's own pages
 * (the join page and their page), which speak to them.
 */
export const CAN_WORDS: Readonly<Record<CaregiverCan, { title: string; detail: string; yours: string }>> = {
  status: {
    title: "See whether the phone is on",
    detail: "Whether it's online or when it was last heard from, its battery, whether it's paused, and the schedule on now (like Bedtime).",
    yours: "Whether it's online or when it was last heard from, its battery, whether it's paused, and the schedule on now (like Bedtime).",
  },
  pause: {
    title: "Pause it, or lock it now",
    detail: "For 15 minutes to 4 hours, only ever longer than a pause already on. Calls, texts, 911 and 988 still work. Only a parent can end a pause early.",
    yours: "For 15 minutes to 4 hours, only ever longer than a pause already on. Calls, texts, 911 and 988 still work. Only a parent can end a pause early.",
  },
  help: {
    title: "Get the kid's \"I need help\"",
    detail:
      "A notification at once, and on their page: what the kid wrote, where the phone was if the kid shared it, and Call, with the kid's number if you added it. Only what the kid asks from when you give them this for a phone, never earlier help requests.",
    yours:
      "On your caregiver page, and as a notification at once if you turn them on there: what the kid wrote, where the phone was if the kid shared it, and Call, with the kid's number if a parent added it. Only what the kid asks from when a parent gave you this for that phone.",
  },
  locate: {
    title: "Check where the phone is now",
    detail: "Only while this phone's location is on. One check at a time, never where it has been, or your places' list. The kid gets a notification naming them each time.",
    yours: "Only while the phone's location is on: where it is at that moment, never where it has been. The kid gets a notification naming you each time.",
  },
};

/** Access lasts at most this long from when a parent sets (or renews) it. */
export const MAX_ACCESS_MS = 30 * 86_400_000;
/** The add form suggests access ending this long from now. */
export const SUGGESTED_ACCESS_MS = 3 * 86_400_000;
/** A caregiver's name, the parent's words: the kid sees it. */
export const NAME_MAX = 40;
/** Caregivers on a server, ended ones included: a phone's policy lists at most this many. */
export const MAX_CAREGIVERS = LIMITS.maxCaregivers;
/** A one-time link works this long at most, and never after access ends. */
export const LINK_TTL_MS = 7 * 86_400_000;
/** A caregiver's page shows the help requests the kid asked since their help began (getsHelpAsked), received at most this far back. */
export const HELP_WINDOW_MS = 7 * 86_400_000;
/** A phone that asked for its rules this recently is online now: it asks about once a minute while it is. */
export const ONLINE_MS = 5 * 60_000;

export interface Caregiver {
  id: string;
  /** The parent's words ("Grandma"), one line. */
  name: string;
  /** Chosen with their link; null until they join. */
  username: string | null;
  /** They chose a password with their link. */
  joined: boolean;
  can: Record<CaregiverCan, boolean>;
  /** The phones their access covers (ids), by name. */
  phones: string[];
  /**
   * For each of those phones with help on for them: when its help requests began for them (the
   * later of the phone being added and help being turned on, and again from when access is given
   * again). The kid's Help screen names them from then on; nothing the kid asked before is theirs.
   */
  helpFrom: Record<string, number>;
  /** When this access began. */
  accessFrom: number;
  /** When access ends by itself. */
  endsAt: number;
  /** When it ended (early, by a parent, or at endsAt, by the hourly clean-up); null while it lasts. */
  endedAt: number | null;
  /** The parent who ended it early; null when its time came. */
  endedBy: string | null;
  /** The parent who added them (their name), if still a parent. */
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  joinedAt: number | null;
  lastSignedInAt: number | null;
}

interface Row {
  id: string;
  name: string;
  username: string | null;
  password_hash: string | null;
  can_status: number;
  can_pause: number;
  can_help: number;
  can_locate: number;
  access_from: number;
  ends_at: number;
  ended_at: number | null;
  ended_by_name: string | null;
  created_by_name: string | null;
  created_at: number;
  updated_at: number;
  joined_at: number | null;
  last_signed_in_at: number | null;
}

const SELECT = `SELECT c.id, c.name, c.username, c.password_hash, c.can_status, c.can_pause, c.can_help, c.can_locate, c.access_from, c.ends_at,
    c.ended_at, e.name AS ended_by_name, p.name AS created_by_name, c.created_at, c.updated_at, c.joined_at, c.last_signed_in_at
  FROM caregivers c LEFT JOIN parents p ON p.id = c.created_by LEFT JOIN parents e ON e.id = c.ended_by`;

function phonesOf(db: DB, caregiverId: string): { device_id: string; help_from: number | null }[] {
  return db
    .prepare<[string], { device_id: string; help_from: number | null }>(
      "SELECT cp.device_id, cp.help_from FROM caregiver_phones cp JOIN devices d ON d.id = cp.device_id WHERE cp.caregiver_id = ? ORDER BY d.name COLLATE NOCASE, d.id",
    )
    .all(caregiverId);
}

function toCaregiver(db: DB, r: Row): Caregiver {
  const phones = phonesOf(db, r.id);
  return {
    id: r.id,
    name: r.name,
    username: r.username,
    joined: r.password_hash !== null,
    can: { status: r.can_status === 1, pause: r.can_pause === 1, help: r.can_help === 1, locate: r.can_locate === 1 },
    phones: phones.map((p) => p.device_id),
    helpFrom: Object.fromEntries(phones.flatMap((p) => (p.help_from === null ? [] : [[p.device_id, p.help_from] as const]))),
    accessFrom: r.access_from,
    endsAt: r.ends_at,
    endedAt: r.ended_at,
    endedBy: r.ended_by_name,
    createdBy: r.created_by_name,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    joinedAt: r.joined_at,
    lastSignedInAt: r.last_signed_in_at,
  };
}

/** Whether a caregiver's access lasts now: not ended, and before its end. Every caregiver request, notice and policy checks it. */
export function accessCurrent(c: Pick<Caregiver, "endedAt" | "endsAt">, now: number): boolean {
  return c.endedAt === null && c.endsAt > now;
}

/** Every caregiver: those whose access lasts first (the soonest end first), then ended ones (the latest first). */
export function listCaregivers(db: DB): Caregiver[] {
  return db
    .prepare<[], Row>(`${SELECT} ORDER BY c.ended_at IS NOT NULL, CASE WHEN c.ended_at IS NULL THEN c.ends_at ELSE -c.ended_at END, c.name COLLATE NOCASE`)
    .all()
    .map((r) => toCaregiver(db, r));
}

export function getCaregiver(db: DB, id: string): Caregiver | null {
  const row = db.prepare<[string], Row>(`${SELECT} WHERE c.id = ?`).get(id);
  return row ? toCaregiver(db, row) : null;
}

export function caregiverCount(db: DB): number {
  return db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM caregivers").get()?.n ?? 0;
}

/** Whether another caregiver has this name already (names are told apart without case). */
export function caregiverNameTaken(db: DB, name: string, exceptId?: string): boolean {
  return !!db.prepare<[string, string], { id: string }>("SELECT id FROM caregivers WHERE name = ? COLLATE NOCASE AND id != ?").get(name, exceptId ?? "");
}

/**
 * The caregivers a phone's policy lists: every one covering it whose access hasn't ended (by a
 * parent, or by the hourly clean-up at its end), the soonest end first. The phone itself stops
 * listing one at its `until`, by its own clock. `locate` only while the phone's location takes
 * checks, since only then can a caregiver check (as a parent's "Check now").
 */
export function caregiversFor(db: DB, deviceId: string): Policy["caregivers"] {
  const rows = db
    .prepare<[string, number], { name: string; ends_at: number; can_status: number; can_pause: number; can_help: number; can_locate: number }>(
      `SELECT c.name, c.ends_at, c.can_status, c.can_pause, c.can_help, c.can_locate FROM caregivers c JOIN caregiver_phones cp ON cp.caregiver_id = c.id
       WHERE cp.device_id = ? AND c.ended_at IS NULL ORDER BY c.ends_at, c.name COLLATE NOCASE, c.id LIMIT ?`,
    )
    .all(deviceId, MAX_CAREGIVERS);
  if (!rows.length) return [];
  const checks = takesChecks(locationSettings(db, deviceId));
  return rows.map((r) => {
    const can: Record<CaregiverCan, boolean> = { status: r.can_status === 1, pause: r.can_pause === 1, help: r.can_help === 1, locate: r.can_locate === 1 && checks };
    return { name: oneLine(r.name, NAME_MAX) || "A caregiver", until: r.ends_at, can: CAREGIVER_CAN.filter((k) => can[k]) };
  });
}

/**
 * Whether a caregiver may do this to the phone now: access current, the phone one of theirs, and
 * the capability on. Every caregiver route asks this, and the help notices do too.
 */
export function careAccess(c: Caregiver, deviceId: string, can: CaregiverCan, now: number): boolean {
  return accessCurrent(c, now) && c.phones.includes(deviceId) && c.can[can];
}

/**
 * When the kid asked for help: by the phone's clock (which Belay keeps automatic), never later
 * than the server got the request, so a clock ahead can't make an earlier request look newer.
 */
export function helpAskedAt(r: { askedAt: number; receivedAt: number }): number {
  return Math.min(r.askedAt, r.receivedAt);
}

/**
 * Whether a caregiver gets a help request the kid asked at `askedAt` (helpAskedAt) on this phone:
 * help on for them there and access current now, and asked at or after their help began on it
 * (helpFrom), since the kid's Help screen named them from then on. A request asked before and
 * sent later (the phone was offline), and words added later to one, are never theirs. Their page,
 * the notices and the notices of updates all ask this (the seventh security review's H1).
 */
export function getsHelpAsked(c: Caregiver, deviceId: string, askedAt: number, now: number): boolean {
  const from = c.helpFrom[deviceId];
  return careAccess(c, deviceId, "help", now) && from !== undefined && askedAt >= from;
}

/** The caregivers to tell about a help request from this phone that the kid asked at `askedAt` (helpAskedAt): getsHelpAsked. */
export function helpCaregivers(db: DB, deviceId: string, now: number, askedAt: number): Caregiver[] {
  return db
    .prepare<[string, number, number], { id: string }>(
      `SELECT c.id FROM caregivers c JOIN caregiver_phones cp ON cp.caregiver_id = c.id
       WHERE cp.device_id = ? AND c.can_help = 1 AND c.ended_at IS NULL AND c.ends_at > ? AND cp.help_from <= ?`,
    )
    .all(deviceId, now, askedAt)
    .flatMap((r) => {
      const c = getCaregiver(db, r.id);
      return c && getsHelpAsked(c, deviceId, askedAt, now) ? [c] : [];
    });
}
