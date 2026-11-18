/**
 * Phase 12: what parents change about caregivers, and what caregivers do
 * (docs/design/phase12-caregivers.md).
 *
 * A parent adds, changes, renews, ends and removes a caregiver on the parent page; never an AI app,
 * not even as a proposal: giving someone access to the kid's phone is a parent's decision. The
 * server's command line (admin.ts) adds, renews and ends one too, through the same functions,
 * logged as the server's, like its other changes. Each change gives the phones it touches a new
 * policy (the kid's screen lists who has access, with what and until when), and is in the activity
 * log. The hourly clean-up ends access whose time came.
 *
 * A caregiver only pauses or locks a phone (only ever tighter, never "until a parent resumes it",
 * and with no note: the kid's phone says their name) and checks where it is, while their access
 * lasts, on their phones, with that capability on, at most 6 times an hour per phone, like an AI
 * app. Nothing a caregiver does loosens anything.
 */
import { audit } from "../../audit.js";
import { createCareLink, endCaregiverSessions } from "../../auth/caregivers.js";
import { newId } from "../../crypto.js";
import type { DB } from "../../db.js";
import type { Deps } from "../../deps.js";
import { CARE_PER_HOUR } from "../../ratelimit.js";
import { nameLine } from "../../text.js";
import { locateNow } from "../location/changes.js";
import { type CaregiverActor, type Changed, type Person, type PolicyContext, RuleRefused, changePolicies, lockPhone, pausePhone } from "../policy.js";
import {
  CAREGIVER_CAN,
  type Caregiver,
  type CaregiverCan,
  MAX_ACCESS_MS,
  MAX_CAREGIVERS,
  NAME_MAX,
  accessCurrent,
  careAccess,
  caregiverCount,
  caregiverNameTaken,
  getCaregiver,
} from "./store.js";

type Parent = { kind: "parent"; parentId: string };

/** The parent who did it, as a caregiver's row and link keep them; null for the server's command line. */
const parentOf = (who: Person): string | null => (who.kind === "parent" ? who.parentId : null);

/** How long a caregiver may pause the phone for, in minutes: 15 minutes to 4 hours. */
export const CARE_PAUSE_MINUTES = [15, 30, 60, 120, 240] as const;

export interface CaregiverInput {
  /** The parent's words for them. */
  name: string;
  /** The phones it covers, by id. */
  phones: string[];
  can: Record<CaregiverCan, boolean>;
}

/**
 * A caregiver's name as it's kept and shown: one line, without a control, invisible or format
 * character, its spaces one each (text.ts's nameLine), so two caregivers who look alike to the kid
 * are one name, and taken (the seventh review's J5).
 */
export function cleanCaregiverName(text: string): string {
  return nameLine(text, 200);
}

const canList = (can: Record<CaregiverCan, boolean>): CaregiverCan[] => CAREGIVER_CAN.filter((k) => can[k]);

function phoneNames(db: DB, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const row = db.prepare<[string], { name: string }>("SELECT name FROM devices WHERE id = ?").get(id);
    return row ? [row.name] : [];
  });
}

/** Why a caregiver's name, phones or choices won't do, or null. */
export function caregiverProblem(db: DB, input: CaregiverInput, exceptId?: string): string | null {
  const name = cleanCaregiverName(input.name);
  if (!name || name.length > NAME_MAX) return `Name them in 1 to ${NAME_MAX} characters, like Grandma. Your kid sees this name.`;
  if (caregiverNameTaken(db, name, exceptId)) return "Another caregiver has that name already. Give each one a name your kid can tell apart.";
  if (input.phones.length === 0) return "Choose at least one phone.";
  if (input.phones.some((id) => !db.prepare("SELECT 1 FROM devices WHERE id = ?").get(id))) return "Choose phones from the list.";
  if (!CAREGIVER_CAN.some((k) => input.can[k])) return "Choose at least one thing they may do.";
  return null;
}

/** Why an end time won't do, or null: from a minute from now to 30 days from now. */
export function endProblem(endsAt: number | null, now: number): string | null {
  if (endsAt === null || !Number.isFinite(endsAt)) return "Choose when their access ends: a date and a time.";
  if (endsAt <= now + 60_000) return "Choose an end later than now.";
  if (endsAt > now + MAX_ACCESS_MS) return "Access lasts at most 30 days. Choose an earlier end: you can renew it before then.";
  return null;
}

/**
 * The phones a caregiver's access covers, and when each one's help requests began for them
 * (`help_from`, the seventh security review's H1): a phone they keep keeps its start, a phone added
 * with help on starts `now`, and so does each phone when help is turned on; with help off, none
 * has one. Only the help requests the kid asks from then on are theirs (store.ts's getsHelpAsked).
 */
function setPhones(db: DB, caregiverId: string, phones: string[], help: boolean, now: number): void {
  const wanted = [...new Set(phones)];
  const remove = db.prepare("DELETE FROM caregiver_phones WHERE caregiver_id = ? AND device_id = ?");
  for (const r of db.prepare<[string], { device_id: string }>("SELECT device_id FROM caregiver_phones WHERE caregiver_id = ?").all(caregiverId)) {
    if (!wanted.includes(r.device_id)) remove.run(caregiverId, r.device_id);
  }
  const add = db.prepare("INSERT INTO caregiver_phones (caregiver_id, device_id, help_from) VALUES (?, ?, ?) ON CONFLICT (caregiver_id, device_id) DO NOTHING");
  for (const id of wanted) add.run(caregiverId, id, help ? now : null);
  if (help) db.prepare("UPDATE caregiver_phones SET help_from = ? WHERE caregiver_id = ? AND help_from IS NULL").run(now, caregiverId);
  else db.prepare("UPDATE caregiver_phones SET help_from = NULL WHERE caregiver_id = ?").run(caregiverId);
}

function mustGet(db: DB, id: string): Caregiver {
  const c = getCaregiver(db, id);
  if (!c) throw new RuleRefused("That caregiver isn't here any more.");
  return c;
}

/**
 * Adds a caregiver whose access ends at `endsAt` (at most 30 days away), with a one-time link to
 * choose a username and password, which the parent page (or the command line) shows once. Their
 * phones' policies list them from now.
 */
export function addCaregiver(ctx: PolicyContext, input: CaregiverInput & { endsAt: number }, who: Person): { caregiver: Caregiver; link: string } {
  const { db, now } = ctx;
  const problem =
    caregiverProblem(db, input) ??
    endProblem(input.endsAt, now) ??
    (caregiverCount(db) >= MAX_CAREGIVERS ? `Belay keeps at most ${MAX_CAREGIVERS} caregivers. Remove one whose access ended, then add this one.` : null);
  if (problem) throw new RuleRefused(problem);
  const id = newId();
  const name = cleanCaregiverName(input.name);
  const phones = [...new Set(input.phones)];
  const { result: link } = changePolicies(ctx, phones, who, (log) => {
    db.prepare(
      `INSERT INTO caregivers (id, name, can_status, can_pause, can_help, can_locate, access_from, ends_at, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(id, name, input.can.status ? 1 : 0, input.can.pause ? 1 : 0, input.can.help ? 1 : 0, input.can.locate ? 1 : 0, now, input.endsAt, parentOf(who), now, now);
    setPhones(db, id, phones, input.can.help, now);
    log("caregiver.added", { caregiver: name, phones: phoneNames(db, phones), can: canList(input.can), until: input.endsAt });
    return createCareLink(db, now, id, input.endsAt, parentOf(who));
  });
  return { caregiver: mustGet(db, id), link };
}

/**
 * Changes a caregiver's name, phones or what they may do; the phones it touches get new policies.
 * A phone added, or help turned on, gets them only the help requests the kid asks from now.
 */
export function changeCaregiver(ctx: PolicyContext, id: string, input: CaregiverInput, who: Parent): Caregiver {
  const { db, now } = ctx;
  const before = mustGet(db, id);
  const problem = caregiverProblem(db, input, id);
  if (problem) throw new RuleRefused(problem);
  const name = cleanCaregiverName(input.name);
  const phones = [...new Set(input.phones)];
  changePolicies(ctx, [...new Set([...before.phones, ...phones])], who, (log) => {
    db.prepare("UPDATE caregivers SET name = ?, can_status = ?, can_pause = ?, can_help = ?, can_locate = ?, updated_at = ? WHERE id = ?").run(
      name,
      input.can.status ? 1 : 0,
      input.can.pause ? 1 : 0,
      input.can.help ? 1 : 0,
      input.can.locate ? 1 : 0,
      now,
      id,
    );
    setPhones(db, id, phones, input.can.help, now);
    log("caregiver.changed", { caregiver: name, ...(name !== before.name ? { from: before.name } : {}), phones: phoneNames(db, phones), can: canList(input.can) });
  });
  return mustGet(db, id);
}

/**
 * Renews a caregiver's access to end at `endsAt`, at most 30 days away. For one whose access
 * ended, it's access again from now: the help requests from between don't show.
 */
export function renewCaregiver(ctx: PolicyContext, id: string, endsAt: number, who: Person): Caregiver {
  const { db, now } = ctx;
  const before = mustGet(db, id);
  const problem = endProblem(endsAt, now);
  if (problem) throw new RuleRefused(problem);
  const again = !accessCurrent(before, now);
  changePolicies(ctx, before.phones, who, (log) => {
    if (again) {
      // Its time may have come before the hourly clean-up ended it: what goes when access ends goes now.
      forgetAccess(db, id);
      db.prepare("UPDATE caregivers SET ends_at = ?, access_from = ?, ended_at = NULL, ended_by = NULL, updated_at = ? WHERE id = ?").run(endsAt, now, now, id);
      // Help begins again too: what the kid asked while they had no access is never theirs.
      db.prepare("UPDATE caregiver_phones SET help_from = ? WHERE caregiver_id = ? AND help_from IS NOT NULL").run(now, id);
    } else {
      db.prepare("UPDATE caregivers SET ends_at = ?, updated_at = ? WHERE id = ?").run(endsAt, now, id);
    }
    log("caregiver.renewed", { caregiver: before.name, until: endsAt, ...(again ? { again: true } : {}) });
  });
  return mustGet(db, id);
}

/** What goes when access ends: every session, every browser, and any link not used yet. */
function forgetAccess(db: DB, id: string): void {
  endCaregiverSessions(db, id);
  db.prepare("DELETE FROM caregiver_push WHERE caregiver_id = ?").run(id);
  db.prepare("DELETE FROM caregiver_links WHERE caregiver_id = ? AND used_at IS NULL").run(id);
}

/**
 * Ends a caregiver's access: a parent's "End access now" (or the command line's `caregiver-end`),
 * or, `atItsEnd`, the hourly clean-up once its time came (the server's, recorded as ended at its
 * end time). Their sessions, browsers and unused link go at once, and their phones' policies stop
 * listing them. False when it had ended already.
 */
export function endCaregiver(ctx: PolicyContext, id: string, who: Person, opts: { atItsEnd?: boolean } = {}): boolean {
  const { db, now } = ctx;
  const before = mustGet(db, id);
  if (before.endedAt !== null) return false;
  const atItsEnd = opts.atItsEnd === true;
  changePolicies(ctx, before.phones, who, (log) => {
    db.prepare("UPDATE caregivers SET ended_at = ?, ended_by = ?, updated_at = ? WHERE id = ?").run(atItsEnd ? Math.min(before.endsAt, now) : now, parentOf(who), now, id);
    forgetAccess(db, id);
    log(atItsEnd ? "caregiver.access_ended" : "caregiver.ended", { caregiver: before.name });
  });
  return true;
}

/** Removes a caregiver whose access ended, account and all; the activity log keeps their name. */
export function removeCaregiver(ctx: PolicyContext, id: string, who: Parent): void {
  const { db, now } = ctx;
  const before = mustGet(db, id);
  if (accessCurrent(before, now)) throw new RuleRefused(`End ${before.name}'s access first, then remove them.`);
  changePolicies(ctx, before.phones, who, (log) => {
    db.prepare("DELETE FROM caregivers WHERE id = ?").run(id);
    log("caregiver.removed", { caregiver: before.name });
  });
}

/**
 * A new one-time link for a caregiver, while their access lasts: to join, or to choose a new
 * password. It replaces any link of theirs not used yet; using it signs them out everywhere else.
 */
export function newCaregiverLink(ctx: PolicyContext, id: string, who: Parent): string {
  const { db, now } = ctx;
  const c = mustGet(db, id);
  if (!accessCurrent(c, now)) throw new RuleRefused(`${c.name}'s access has ended. Give access again first, then make a link.`);
  const token = createCareLink(db, now, id, c.endsAt, who.parentId);
  audit(db, now, who, "caregiver.link", { detail: { caregiver: c.name, ...(c.joined ? { joined: true } : {}) } });
  return token;
}

/** The hourly clean-up: ends every caregiver's access whose time came. Their phones get new policies. */
export function endExpiredCaregivers(ctx: PolicyContext): number {
  const due = ctx.db.prepare<[number], { id: string }>("SELECT id FROM caregivers WHERE ended_at IS NULL AND ends_at <= ?").all(ctx.now);
  return due.filter((r) => endCaregiver(ctx, r.id, { kind: "server" }, { atItsEnd: true })).length;
}

// ── What a caregiver does ────────────────────────────────────────────

export type CareAction = "pause" | "lock" | "locate";
const KIND = { pause: "locks", lock: "locks", locate: "checks" } as const satisfies Record<CareAction, keyof typeof CARE_PER_HOUR>;

/** The activity log's (and the policy's) actor for a caregiver: their id, and the name the parent gave them. */
export function careActor(c: Pick<Caregiver, "id" | "name">): CaregiverActor {
  return { kind: "caregiver", caregiverId: c.id, name: c.name };
}

const careKey = (c: Caregiver, deviceId: string) => `${c.id} ${deviceId}`;
const limiter = (deps: Deps, action: CareAction) => (KIND[action] === "checks" ? deps.limits.careChecks : deps.limits.careLocks);

/**
 * Null when the caregiver may do this to the phone now, by the hourly limits; else why not, and
 * when to try again. The activity log says so once an hour, however often they try. Counts nothing.
 */
export function careLimited(deps: Deps, c: Caregiver, action: CareAction, phone: { id: string; name: string }): string | null {
  const verdict = limiter(deps, action).check(careKey(c, phone.id));
  if (verdict.ok) return null;
  const kind = KIND[action];
  if (deps.limits.careLimitedLog.hit(`${careKey(c, phone.id)} ${kind}`).ok) {
    audit(deps.db, deps.now(), careActor(c), "caregiver.limited", { deviceId: phone.id, detail: { what: kind, limit: CARE_PER_HOUR[kind] } });
  }
  const minutes = Math.max(1, Math.ceil(verdict.retryAfterSeconds / 60));
  const again = `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
  return kind === "checks"
    ? `You can check where ${phone.name} is at most ${CARE_PER_HOUR.checks} times an hour, and you have. ${again}`
    : `You can pause or lock ${phone.name} at most ${CARE_PER_HOUR.locks} times an hour, and you have. ${again}`;
}

/** Counts something a caregiver did to the phone, against their hourly limit for it. */
export function careCounted(deps: Deps, c: Caregiver, action: CareAction, deviceId: string): void {
  limiter(deps, action).hit(careKey(c, deviceId));
}

/** Not theirs to do now: their access ended, the phone isn't theirs, or a parent didn't choose it. */
export class CareRefused extends Error {
  override name = "CareRefused";
}

/**
 * A caregiver pauses the phone for `minutes`, or pauses it and locks the screen now (`lock`, the
 * lock_now command): as an AI app's, only ever longer than a pause in force (a pause at least as
 * long is `kept`), and with no note. The kid's phone says the caregiver's name.
 */
export function carePause(ctx: PolicyContext, c: Caregiver, deviceId: string, minutes: number, lock: boolean): Changed<{ until: number | null; kept: boolean }> {
  if (!careAccess(c, deviceId, "pause", ctx.now)) throw new CareRefused("Pausing this phone isn't something you can do now.");
  if (!(CARE_PAUSE_MINUTES as readonly number[]).includes(minutes)) throw new CareRefused("Choose 15 minutes to 4 hours.");
  return lock ? lockPhone(ctx, deviceId, { minutes }, careActor(c)) : pausePhone(ctx, deviceId, { minutes }, careActor(c));
}

/** A caregiver checks where the phone is now: the locate_now a parent's "Check now" sends, naming them for the kid. */
export function careLocate(ctx: PolicyContext, c: Caregiver, deviceId: string): Changed<{ command: string; expiresAt: number }> {
  if (!careAccess(c, deviceId, "locate", ctx.now)) throw new CareRefused("Checking where this phone is isn't something you can do now.");
  return locateNow(ctx, deviceId, careActor(c));
}
