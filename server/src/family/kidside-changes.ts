/**
 * Phase 7's changes, each through family/policy.ts's changePolicy (or changePolicies, for a
 * family setting every phone gets): one transaction, the activity log, and a new policy version
 * when what the phone would see changed. All of them are a person's: a parent on the parent page,
 * or the server's CLI. No AI app sees a help request seen, or answers any request.
 */
import type { DB } from "../db.js";
import { e164 } from "../device/schemas.js";
import { type ParentNumber, type Settings, type SettingsChange, getSettings, parentNumbersProblem, updateSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { phoneHelp } from "./kidside.js";
import { type Changed, type Person, type PolicyContext, RuleRefused, changePolicies, changePolicy, kidWords, LIMITS } from "./policy.js";

function onlyPeople(who: { kind: string }): void {
  if (who.kind === "ai") throw new Error("Only a person changes this");
}

const parentOf = (who: Person): string | null => (who.kind === "parent" ? who.parentId : null);

export interface Seen {
  /** It was seen before: nothing changed. */
  already: boolean;
  seenAt: number;
}

/**
 * A parent saw the kid's help request ("I've seen it"): the kid's phone shows "Your parent saw this
 * at 4:05 pm" (the policy's help_seen), and it leaves the top of the Requests page. A pending one
 * is answered with it, so the kid can't withdraw it after; an optional note goes to the phone with
 * the answer. One the kid withdrew is still marked seen. Null when there's no such help request.
 */
export function markHelpSeen(ctx: PolicyContext, deviceId: string, requestId: string, who: Person, noteText: string | null = null): Changed<Seen | null> {
  onlyPeople(who);
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    const row = db
      .prepare<[string, string], { kind: string; status: string; seen_at: number | null }>("SELECT kind, status, seen_at FROM requests WHERE device_id = ? AND id = ?")
      .get(deviceId, requestId);
    if (!row || row.kind !== "help") return null;
    if (row.seen_at !== null) return { already: true, seenAt: row.seen_at };
    // Shown to the kid with the answer: nothing hidden or reordered.
    const note = kidWords(noteText, LIMITS.answerNote);
    db.prepare("UPDATE requests SET seen_at = ?, seen_by = ? WHERE device_id = ? AND id = ?").run(now, parentOf(who), deviceId, requestId);
    if (row.status === "pending") {
      db.prepare("UPDATE requests SET status = 'approved', note = ?, answered_by = ?, answered_at = ? WHERE device_id = ? AND id = ?").run(note, parentOf(who), now, deviceId, requestId);
    }
    log("request.seen", { kind: "help", ...(row.status === "withdrawn" ? { withdrawn: true } : {}), note: note ?? undefined });
    return { already: false, seenAt: now };
  });
}

/** The kid's own number, for "Call" beside a help request on the parent page. It's never sent to the phone. Null clears it. */
export function setKidNumber(ctx: PolicyContext, deviceId: string, number: string | null, who: Person): Changed<{ number: string | null }> {
  onlyPeople(who);
  if (number !== null && !e164.safeParse(number).success) {
    throw new RuleRefused("Write the number in international form: + and the country code, then the number, like +15555550123.");
  }
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    const before = phoneHelp(db, deviceId);
    if (before.kidNumber === number) return { number };
    db.prepare(
      "INSERT INTO phone_help (device_id, kid_number, changed_at) VALUES (?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET kid_number = excluded.kid_number, changed_at = excluded.changed_at",
    ).run(deviceId, number, now);
    log("help.kid_number", { set: number !== null });
    return { number };
  });
}

/** A list of numbers as a person typed them: names on one line, at most 40 characters. */
export function cleanNumbers(list: ParentNumber[]): ParentNumber[] {
  return list.map((p) => ({ name: oneLine(p.name, 40), number: p.number.replace(/[\s().-]/g, "") }));
}

/**
 * The numbers on this phone's emergency card: its own list, or null to use the family's (from
 * Settings). At most 4, each with a name.
 */
export function setPhoneParentNumbers(ctx: PolicyContext, deviceId: string, list: ParentNumber[] | null, who: Person): Changed<{ numbers: ParentNumber[] }> {
  onlyPeople(who);
  const numbers = list === null ? null : cleanNumbers(list);
  const problem = numbers === null ? null : parentNumbersProblem(numbers);
  if (problem) throw new RuleRefused(problem);
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    const before = phoneHelp(db, deviceId).ownParentNumbers;
    if (JSON.stringify(before) === JSON.stringify(numbers)) return { numbers: numbers ?? getSettings(db).parentNumbers };
    db.prepare(
      "INSERT INTO phone_help (device_id, parent_numbers, changed_at) VALUES (?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET parent_numbers = excluded.parent_numbers, changed_at = excluded.changed_at",
    ).run(deviceId, numbers === null ? null : JSON.stringify(numbers), now);
    log("help.parent_numbers", numbers === null ? { family: true } : { count: numbers.length });
    return { numbers: numbers ?? getSettings(db).parentNumbers };
  });
}

/**
 * Adds a number to this phone's emergency card, or changes the number of the one with that name
 * (the CLI's parent-number). A phone using the family's numbers gets its own list, starting from
 * them.
 */
export function putPhoneParentNumber(ctx: PolicyContext, deviceId: string, entry: ParentNumber, who: Person): Changed<{ numbers: ParentNumber[] }> {
  const { db } = ctx;
  const [clean] = cleanNumbers([entry]);
  if (!clean) throw new RuleRefused("Give the number a name.");
  const current = phoneHelp(db, deviceId).ownParentNumbers ?? getSettings(db).parentNumbers;
  const index = current.findIndex((p) => p.name.toLowerCase() === clean.name.toLowerCase());
  const next = index < 0 ? [...current, clean] : current.map((p, i) => (i === index ? clean : p));
  return setPhoneParentNumbers(ctx, deviceId, next, who);
}

/** Removes the number with that name from this phone's own list. */
export function removePhoneParentNumber(ctx: PolicyContext, deviceId: string, name: string, who: Person): Changed<{ numbers: ParentNumber[]; removed: boolean }> {
  const { db } = ctx;
  const current = phoneHelp(db, deviceId).ownParentNumbers ?? getSettings(db).parentNumbers;
  const next = current.filter((p) => p.name.toLowerCase() !== name.trim().toLowerCase());
  const done = setPhoneParentNumbers(ctx, deviceId, next, who);
  return { ...done, result: { ...done.result, removed: next.length !== current.length } };
}

/** Every phone, connected or not: a family setting reaches each one's policy. */
const allPhones = (db: DB): string[] =>
  db
    .prepare<[], { id: string }>("SELECT id FROM devices ORDER BY rowid")
    .all()
    .map((r) => r.id);

/**
 * Changes the family's settings. Some reach every phone's policy (what AI apps may read is its
 * `ai_reads`; the family's parent numbers are the emergency card of each phone without its own),
 * so each phone whose policy changed gets a new version, at once. In the activity log as
 * settings.changed, with before and after. A person's action.
 */
export function changeFamilySettings(ctx: PolicyContext, change: SettingsChange, who: Person): { before: Settings; after: Settings; phonesChanged: number } {
  onlyPeople(who);
  const { db } = ctx;
  if (change.parentNumbers !== undefined) {
    change = { ...change, parentNumbers: cleanNumbers(change.parentNumbers) };
    const problem = parentNumbersProblem(change.parentNumbers ?? []);
    if (problem) throw new RuleRefused(problem);
  }
  const before = getSettings(db);
  const done = changePolicies(ctx, allPhones(db), who, (log) => {
    const after = updateSettings(db, change);
    log("settings.changed", { before, after });
    return after;
  });
  return { before, after: done.result, phonesChanged: done.changed.length };
}
