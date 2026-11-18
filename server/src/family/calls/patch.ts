/**
 * Phase 5: a phone's calls as one value (a "side": on or off, the rules, the contacts, the private
 * and blocked numbers), so every change is made the same way. Its caller works out the side it
 * wants; then `settle` and `sideProblem` make it right or say why not, `classifyCallsChange` says
 * whether it tightens, and `writeSide` saves what differs.
 *
 * An AI app's proposal keeps a patch: each part it changes, with what that part was when it was
 * proposed. When a parent approves, each part must still be as it was (otherwise the proposal is
 * out of date and nothing is applied); the rest may have changed meanwhile. A patch never holds
 * the parts that are a parent's alone: on or off, recording, and the private numbers.
 *
 * Nothing here imports family/policy.ts, which uses it (a contact request a parent approves);
 * problems come back as words for the caller to refuse with.
 */
import type { DB } from "../../db.js";
import { canonical } from "../screentime/rules.js";
import { oneLine } from "../../text.js";
import type { CallsSide } from "./classify.js";
import { CALL_LIMITS, cleanNumber, numberProblem } from "./numbers.js";
import {
  type CallRules,
  type ContactData,
  callSettings,
  dataOf,
  deleteContact,
  deleteNumber,
  insertNumber,
  listContacts,
  numbersOf,
  rulesOf,
  saveCallSettings,
  writeContact,
} from "./store.js";

/** The rules an AI app's change may touch (never `log`: recording is a parent's). */
export const PATCH_RULES = ["mode", "unknown", "withheld", "outgoing", "quiet"] as const;
type PatchRule = (typeof PATCH_RULES)[number];

export interface CallsPatch {
  rules: { [K in PatchRule]?: { before: CallRules[K]; after: CallRules[K] } };
  contacts: { id: string; before: ContactData | null; after: ContactData | null }[];
  blocked: { number: string; before: boolean; after: boolean }[];
}

const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);
const sorted = (list: Iterable<string>) => [...new Set(list)].sort();

/** The phone's calls now. */
export function sideOf(db: DB, deviceId: string): CallsSide {
  const s = callSettings(db, deviceId);
  return {
    enabled: s?.enabled ?? false,
    rules: rulesOf(s),
    contacts: listContacts(db, deviceId).map((c) => ({ id: c.id, ...dataOf(c) })),
    privateNumbers: numbersOf(db, deviceId, "private"),
    blockedNumbers: numbersOf(db, deviceId, "blocked"),
  };
}

/** The parts that differ from `before` to `after`, leaving out what's a parent's alone. */
export function patchOf(before: CallsSide, after: CallsSide): CallsPatch {
  const patch: CallsPatch = { rules: {}, contacts: [], blocked: [] };
  for (const key of PATCH_RULES) {
    if (before.rules[key] !== after.rules[key]) (patch.rules as Record<string, unknown>)[key] = { before: before.rules[key], after: after.rules[key] };
  }
  const was = new Map(before.contacts.map((c) => [c.id, c]));
  const now = new Map(after.contacts.map((c) => [c.id, c]));
  for (const c of before.contacts) {
    const next = now.get(c.id);
    if (!next || !same(dataOf(next), dataOf(c))) patch.contacts.push({ id: c.id, before: dataOf(c), after: next ? dataOf(next) : null });
  }
  for (const c of after.contacts) if (!was.has(c.id)) patch.contacts.push({ id: c.id, before: null, after: dataOf(c) });
  const blockedBefore = new Set(before.blockedNumbers);
  const blockedAfter = new Set(after.blockedNumbers);
  for (const n of sorted([...blockedBefore, ...blockedAfter])) {
    if (blockedBefore.has(n) !== blockedAfter.has(n)) patch.blocked.push({ number: n, before: blockedBefore.has(n), after: blockedAfter.has(n) });
  }
  return patch;
}

export const emptyPatch = (p: CallsPatch): boolean => Object.keys(p.rules).length === 0 && p.contacts.length === 0 && p.blocked.length === 0;

/**
 * The side with the patch applied, or why it's out of date: a part it changes isn't as it was when
 * it was proposed.
 */
export function applyPatch(current: CallsSide, patch: CallsPatch): { side: CallsSide } | { outdated: string } {
  const rules = { ...current.rules };
  for (const key of PATCH_RULES) {
    const part = patch.rules[key];
    if (!part) continue;
    if (current.rules[key] !== part.before) return { outdated: "The phone's call rules changed after this was proposed." };
    (rules as Record<string, unknown>)[key] = part.after;
  }
  const contacts = current.contacts.map((c) => ({ ...c, numbers: [...c.numbers] }));
  for (const change of patch.contacts) {
    const index = contacts.findIndex((c) => c.id === change.id);
    const found = index < 0 ? null : (contacts[index] ?? null);
    if (!same(found ? dataOf(found) : null, change.before)) {
      const name = oneLine(change.before?.name ?? change.after?.name ?? "", 60);
      return { outdated: `The contact "${name}" changed after this was proposed.` };
    }
    if (change.after === null) contacts.splice(index, 1);
    else if (index < 0) contacts.push({ id: change.id, ...dataOf(change.after) });
    else contacts[index] = { id: change.id, ...dataOf(change.after) };
  }
  const blocked = new Set(current.blockedNumbers);
  for (const part of patch.blocked) {
    if (blocked.has(part.number) !== part.before) return { outdated: `${part.number} was ${part.before ? "unblocked" : "blocked"} after this was proposed.` };
    if (part.after) blocked.add(part.number);
    else blocked.delete(part.number);
  }
  return { side: { ...current, rules, contacts, blockedNumbers: sorted(blocked) } };
}

/** Whether the phone's calls are already as the patch would leave them (a parent made the same change). */
export function alreadyApplied(current: CallsSide, patch: CallsPatch): boolean {
  if (emptyPatch(patch)) return true;
  for (const key of PATCH_RULES) {
    const part = patch.rules[key];
    if (part && current.rules[key] !== part.after) return false;
  }
  for (const change of patch.contacts) {
    const found = current.contacts.find((c) => c.id === change.id);
    if (!same(found ? dataOf(found) : null, change.after)) return false;
  }
  return patch.blocked.every((part) => current.blockedNumbers.includes(part.number) === part.after);
}

/** The patch's parts alone, as two sides of a change, for its words and its effect. */
export function patchSides(patch: CallsPatch, base: CallRules = rulesOf(null)): { before: CallsSide; after: CallsSide } {
  const side = (which: "before" | "after"): CallsSide => {
    const rules = { ...base };
    for (const key of PATCH_RULES) {
      const part = patch.rules[key];
      if (part) (rules as Record<string, unknown>)[key] = part[which];
    }
    return {
      enabled: true,
      rules,
      contacts: patch.contacts.flatMap((c) => {
        const data = c[which];
        return data ? [{ id: c.id, ...dataOf(data) }] : [];
      }),
      privateNumbers: [],
      blockedNumbers: patch.blocked.filter((b) => b[which]).map((b) => b.number),
    };
  };
  return { before: side("before"), after: side("after") };
}

/**
 * The side as it can be saved: a contact's names on one line, its numbers once each, the lists
 * sorted; and a number a contact gains that was blocked, unblocked (a parent who adds it as a
 * contact wants it to ring). `unblocked` lists those.
 */
export function settle(current: CallsSide, desired: CallsSide): { side: CallsSide; unblocked: string[] } {
  const before = new Map(current.contacts.map((c) => [c.id, new Set(c.numbers)]));
  const contacts = desired.contacts.map((c) => ({ ...c, name: oneLine(c.name, 200), numbers: [...new Set(c.numbers.map(cleanNumber).filter(Boolean))] }));
  const gained = new Set(contacts.flatMap((c) => c.numbers.filter((n) => !before.get(c.id)?.has(n))));
  const wasBlocked = new Set(current.blockedNumbers);
  const unblocked = [...gained].filter((n) => wasBlocked.has(n)).sort();
  const blocked = sorted(desired.blockedNumbers.map(cleanNumber)).filter((n) => !(gained.has(n) && wasBlocked.has(n)));
  return { side: { ...desired, contacts, privateNumbers: sorted(desired.privateNumbers.map(cleanNumber)), blockedNumbers: blocked }, unblocked };
}

/**
 * What an AI app is told about a number it may not block that it can't see: one on the emergency
 * card, or a private one. The same words for both, and nothing that says which, since AI apps see
 * only how many of each there are.
 */
export const aiMayNotBlock = (number: string): string => `Belay doesn't let an AI app block ${number}: only a parent decides about that number, on the phone's Calls tab.`;

/**
 * Why the side can't be saved, in words, or null. Only what the change touches is checked: a new
 * or changed contact's name (1 to 60 characters, one per phone) and numbers (1 to 5, E.164, never
 * an emergency number or 988, each one contact's), how many there are, and each number newly
 * blocked (never an emergency number or 988, a contact's, one on the emergency card or a private
 * one) or private. For an AI app (`ai`), a number on the card and a private one get the same words.
 *
 * A private number is one the family keeps out of every record, like a helpline the kid may call.
 * Blocking it would stop its calls and texts reaching the kid, and doing that while it stays private
 * hides that the kid can't be reached by it, so even a parent takes it off the private numbers first,
 * a choice of its own in the activity log, as for a contact's number or one on the card. Unmarking
 * it as part of the block instead would start recording the kid's calls with it unasked.
 */
/**
 * `askParent`: an AI app's blocks that become a proposal whatever the numbers (mcp/calls.ts), so
 * the numbers an AI app doesn't see aren't checked here, where its answer could tell them apart:
 * the parent's approval checks them, with the reason.
 */
export function sideProblem(current: CallsSide, desired: CallsSide, opts: { emergencyCard?: string[]; ai?: boolean; askParent?: boolean } = {}): string | null {
  const before = new Map(current.contacts.map((c) => [c.id, c]));
  const owner = new Map<string, string>();
  for (const c of desired.contacts) for (const n of c.numbers) if (!owner.has(n)) owner.set(n, c.name);
  if (desired.contacts.length > CALL_LIMITS.maxContacts && desired.contacts.length > current.contacts.length) {
    return `A phone can have at most ${CALL_LIMITS.maxContacts} contacts. Remove one first.`;
  }
  const fold = (name: string) => name.trim().toLowerCase();
  const named = new Map<string, string[]>();
  for (const c of desired.contacts) named.set(fold(c.name), [...(named.get(fold(c.name)) ?? []), c.id]);
  for (const c of desired.contacts) {
    const was = before.get(c.id);
    if (was && same(dataOf(was), dataOf(c))) continue;
    if (!c.name.trim()) return "Give the contact a name, like Grandma.";
    if (c.name.length > CALL_LIMITS.contactName) return `Keep a contact's name to ${CALL_LIMITS.contactName} characters: the kid sees it.`;
    if ((named.get(fold(c.name)) ?? []).some((id) => id !== c.id)) return `There's already a contact called ${oneLine(c.name, 60)}.`;
    if (c.numbers.length === 0) return `Give ${oneLine(c.name, 60)} a number.`;
    if (c.numbers.length > CALL_LIMITS.numbersPerContact) return `A contact can have at most ${CALL_LIMITS.numbersPerContact} numbers.`;
    for (const n of c.numbers) {
      const problem = numberProblem(n, "contact");
      if (problem) return problem;
      const other = desired.contacts.find((x) => x.id !== c.id && x.numbers.includes(n));
      if (other) return `${n} is already ${oneLine(other.name, 60)}'s number.`;
    }
  }
  const wasBlocked = new Set(current.blockedNumbers);
  const newlyBlocked = desired.blockedNumbers.filter((n) => !wasBlocked.has(n));
  if (desired.blockedNumbers.length > CALL_LIMITS.maxBlocked && newlyBlocked.length) return `A phone can have at most ${CALL_LIMITS.maxBlocked} blocked numbers. Unblock one first.`;
  const card = new Set(opts.emergencyCard ?? []);
  const kept = new Set(desired.privateNumbers);
  for (const n of newlyBlocked) {
    const problem = numberProblem(n, "blocked");
    if (problem) return problem;
    const name = owner.get(n);
    if (name !== undefined) return `${n} is ${oneLine(name, 60)}'s number, a contact: take it off the contact first, then block it.`;
    if (opts.ai) {
      if (!opts.askParent && (card.has(n) || kept.has(n))) return aiMayNotBlock(n);
      continue;
    }
    if (card.has(n)) return `${n} is on the kid's emergency card: take it off the card first, then block it.`;
    if (kept.has(n)) return `${n} is one of the private numbers, which Belay never records, like a helpline the kid may call: take it off the private numbers first if you mean to block it.`;
  }
  const wasPrivate = new Set(current.privateNumbers);
  const newlyPrivate = desired.privateNumbers.filter((n) => !wasPrivate.has(n));
  if (desired.privateNumbers.length > CALL_LIMITS.maxPrivate && newlyPrivate.length) return `A phone can have at most ${CALL_LIMITS.maxPrivate} private numbers.`;
  for (const n of newlyPrivate) {
    const problem = numberProblem(n, "private");
    if (problem) return problem;
  }
  return null;
}

/** Who made a change, for the blocked numbers' "who": a parent (or whose AI connection), or the CLI. */
export interface By {
  parentId: string | null;
  clientName: string | null;
}

/**
 * Saves what differs from `current` to `desired` (checked and settled first). A contact made from
 * the kid's request remembers it (`requestOf`). The call records of a private number, and of a
 * contact who has one, are deleted.
 */
export function writeSide(db: DB, deviceId: string, current: CallsSide, desired: CallsSide, now: number, by: By, requestOf: (contactId: string) => string | null = () => null): void {
  if (current.enabled !== desired.enabled || !same(current.rules, desired.rules)) {
    const s = callSettings(db, deviceId);
    const enabledAt = desired.enabled && !current.enabled ? now : (s?.enabledAt ?? null);
    saveCallSettings(db, deviceId, { ...desired.rules, enabled: desired.enabled, enabledAt }, now);
  }
  const before = new Map(current.contacts.map((c) => [c.id, c]));
  const after = new Set(desired.contacts.map((c) => c.id));
  for (const c of current.contacts) if (!after.has(c.id)) deleteContact(db, deviceId, c.id);
  // Removed numbers go first, so a number can move from one contact to another in one change.
  for (const c of desired.contacts) {
    const was = before.get(c.id);
    if (was && !same(dataOf(was), dataOf(c))) db.prepare("DELETE FROM contact_numbers WHERE device_id = ? AND contact_id = ?").run(deviceId, c.id);
  }
  for (const c of desired.contacts) {
    const was = before.get(c.id);
    if (!was || !same(dataOf(was), dataOf(c))) writeContact(db, deviceId, c.id, dataOf(c), now, was ? null : requestOf(c.id));
  }
  for (const kind of ["blocked", "private"] as const) {
    const was = new Set(kind === "blocked" ? current.blockedNumbers : current.privateNumbers);
    const next = new Set(kind === "blocked" ? desired.blockedNumbers : desired.privateNumbers);
    for (const n of was) if (!next.has(n)) deleteNumber(db, deviceId, kind, n);
    for (const n of next) {
      if (was.has(n)) continue;
      insertNumber(db, deviceId, kind, n, now, by);
      // A number made private is never recorded: the records kept of it before go too.
      if (kind === "private") db.prepare("DELETE FROM call_records WHERE device_id = ? AND number = ?").run(deviceId, n);
    }
  }
  // Nor is a contact who has a private number, whichever came first, the number or the contact:
  // a record names the contact, not the number, and a call with them may have been with it
  // (records.ts keeps none of theirs).
  db.prepare(
    `DELETE FROM call_records WHERE device_id = ? AND contact_id IN (
       SELECT n.contact_id FROM contact_numbers n JOIN call_numbers p ON p.device_id = n.device_id AND p.number = n.number AND p.kind = 'private'
       WHERE n.device_id = ?)`,
  ).run(deviceId, deviceId);
}

