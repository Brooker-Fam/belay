/**
 * Phase 5's changes, each through family/policy.ts's changePolicy: one transaction, the activity
 * log, and a new policy version when what the phone would see changed. Who may change what is
 * checked here as well as in the callers:
 *
 * - Turning calls on or off, recording them (`log`) and the private numbers decide what Belay
 *   collects: a parent's alone (the parent page, or the server's CLI acting as one). An AI app
 *   can't change them, and can't propose to either.
 * - Who may call, whom the kid may call, quiet times, the contacts and the blocked numbers: a
 *   parent's, or an AI app's when every part of the change tightens (classify.ts). An AI app's
 *   other changes are proposals a parent approves (family/proposals.ts, with patch.ts's patch).
 *
 * 911, every emergency number and 988 are never in any of it: the phone allows them in its own
 * code, and the server refuses to block one (numbers.ts).
 */
import { parentNumbersFor } from "../kidside.js";
import { type Changed, type Changer, type Person, type PolicyContext, RuleRefused, changePolicy } from "../policy.js";
import { canonical } from "../screentime/rules.js";
import { type CallsSide, type Classification, classifyCallsChange } from "./classify.js";
import { type NumberUse, cleanNumber, numberProblem } from "./numbers.js";
import { type By, type CallsPatch, applyPatch, settle, sideOf, sideProblem, writeSide } from "./patch.js";
import { type CallAction, type CallMode, type CallRules, type Contact, type Outgoing, getContact, newContactId } from "./store.js";
import { callChangeSentence } from "./words.js";

/** The types already say so; this keeps it true at run time too. */
function onlyPeople(who: { kind: string }): void {
  if (who.kind === "ai") throw new Error("Only a parent turns calls on or off, decides whether they're recorded, or which numbers are private, or loosens a call rule: an AI app proposes");
}

const MODES: ReadonlySet<string> = new Set<CallMode>(["open", "contacts"]);
const ACTIONS: ReadonlySet<string> = new Set<CallAction>(["reject", "voicemail", "ring"]);
const OUTGOING: ReadonlySet<string> = new Set<Outgoing>(["contacts", "any"]);

const byOf = (who: Changer): By => ({ parentId: who.kind === "server" ? null : who.parentId, clientName: who.kind === "ai" ? who.clientName : null });

/** Numbers as a person typed them, each checked first, so a refusal quotes what they wrote. */
function typed(numbers: string[], use: NumberUse): void {
  for (const n of numbers) {
    const problem = numberProblem(n, use);
    if (problem) throw new RuleRefused(problem);
  }
}

export interface CallsDone {
  classification: Classification;
  /** Each change in words (classify.ts and words.ts), for the caller to show. */
  changes: string[];
  /** Numbers a contact gained that were blocked, and are unblocked now. */
  unblocked: string[];
}

/**
 * Every change to a phone's calls is made here: the side the caller wants, settled (numbers
 * cleaned, a blocked number a contact gains unblocked), checked (or refused, with why), classified
 * (an AI app's must only tighten, and never be about collecting), saved, and logged.
 */
function change(
  ctx: PolicyContext,
  deviceId: string,
  who: Changer,
  want: (current: CallsSide) => CallsSide,
  opts: { proposalId?: string; requestOf?: (contactId: string) => string | null } = {},
): Changed<CallsDone> {
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    const current = sideOf(db, deviceId);
    const { side, unblocked } = settle(current, want(current));
    const problem = sideProblem(current, side, { emergencyCard: parentNumbersFor(db, deviceId).map((p) => p.number) });
    if (problem) throw new RuleRefused(problem);
    const classification = classifyCallsChange(current, side);
    if (who.kind === "ai" && (classification.collection || !classification.onlyTightens)) {
      throw new Error("An AI app can only tighten a phone's calls: anything else is a proposal, and turning calls on or off, recording them and private numbers are a parent's alone");
    }
    if (canonical(current) === canonical(side)) return { classification, changes: [], unblocked: [] };
    writeSide(db, deviceId, current, side, now, byOf(who), opts.requestOf);
    const changes = classification.changes.map(callChangeSentence);
    const turned = classification.changes.find((c) => c.kind === "enabled");
    const detail = {
      changes,
      ...(unblocked.length ? { unblocked } : {}),
      ...(opts.proposalId ? { proposal: opts.proposalId } : {}),
    };
    if (turned?.kind === "enabled") log(turned.to ? "calls.on" : "calls.off", detail);
    else if (changes.length) log("calls.changed", detail);
    return { classification, changes, unblocked };
  });
}

/** Checked at run time: the CLI and the forms pass words people typed. */
function rulesProblem(input: Partial<CallRules>): string | null {
  if (input.mode !== undefined && !MODES.has(input.mode)) return "Choose who can call: anyone, or only contacts.";
  for (const key of ["unknown", "withheld"] as const) {
    const value = input[key];
    if (value !== undefined && !ACTIONS.has(value)) return "Choose ring, voicemail or refuse.";
  }
  if (input.outgoing !== undefined && !OUTGOING.has(input.outgoing)) return "Choose whom the kid can call: only contacts, or any number.";
  return null;
}

export interface CallsSettingsChange extends Partial<CallRules> {
  /** Calls on: Belay becomes the phone app. Off: the policy's `calls` is null again. */
  enabled?: boolean;
}

/**
 * Turns calls on or off, and sets their rules, recording included: a parent's alone. The rules
 * are kept while calls are off, for next time.
 */
export function setCalls(ctx: PolicyContext, deviceId: string, input: CallsSettingsChange, who: Person): Changed<CallsDone> {
  onlyPeople(who);
  const problem = rulesProblem(input);
  if (problem) throw new RuleRefused(problem);
  // Only the rules given change: one left out (or undefined) keeps its value.
  const given: Partial<Record<keyof CallRules, unknown>> = {};
  for (const key of ["mode", "unknown", "withheld", "outgoing", "quiet", "log"] as const) if (input[key] !== undefined) given[key] = input[key];
  return change(ctx, deviceId, who, (current) => ({ ...current, enabled: input.enabled ?? current.enabled, rules: { ...current.rules, ...(given as Partial<CallRules>) } }));
}

export interface ContactInput {
  /** Changes this contact; left out: a new one. */
  id?: string;
  name: string;
  numbers: string[];
  calls: boolean;
  texts: boolean;
  parent: boolean;
}

/**
 * Adds a contact, or changes one: a parent's (adding one loosens, so an AI app only proposes it).
 * Names are the family's words, at most 60 characters, one per phone; each number (E.164, at most
 * 5) is one contact's. A number it gains that was blocked is unblocked.
 */
export function saveContact(ctx: PolicyContext, deviceId: string, input: ContactInput, who: Person): Changed<CallsDone & { contact: Contact; added: boolean }> {
  onlyPeople(who);
  const { db } = ctx;
  if (input.id !== undefined && !getContact(db, deviceId, input.id)) throw new RuleRefused("That contact isn't there any more. Reload the page.");
  typed(input.numbers, "contact");
  const id = input.id ?? newContactId();
  const data = { name: input.name, numbers: input.numbers, calls: input.calls, texts: input.texts, parent: input.parent };
  const done = change(ctx, deviceId, who, (current) => ({
    ...current,
    contacts: input.id === undefined ? [...current.contacts, { id, ...data }] : current.contacts.map((c) => (c.id === id ? { id, ...data } : c)),
  }));
  const contact = getContact(db, deviceId, id);
  if (!contact) throw new Error("contact vanished");
  return { ...done, result: { ...done.result, contact, added: input.id === undefined } };
}

/**
 * The CLI's `contact`: the contact with this name (in any case) gains the number, and the flags
 * given; or a new one, with calls and texts on unless they're turned off, a parent only with
 * `parent`.
 */
export function putContact(
  ctx: PolicyContext,
  deviceId: string,
  input: { name: string; number: string; calls?: boolean; texts?: boolean; parent?: boolean },
  who: Person,
): Changed<CallsDone & { contact: Contact; added: boolean }> {
  const { db } = ctx;
  const same = sideOf(db, deviceId).contacts.find((c) => c.name.trim().toLowerCase() === input.name.trim().toLowerCase());
  const number = cleanNumber(input.number);
  return saveContact(
    ctx,
    deviceId,
    same
      ? {
          id: same.id,
          name: same.name,
          numbers: same.numbers.includes(number) ? same.numbers : [...same.numbers, number],
          calls: input.calls ?? same.calls,
          texts: input.texts ?? same.texts,
          parent: input.parent ?? same.parent,
        }
      : { name: input.name, numbers: [number], calls: input.calls ?? true, texts: input.texts ?? true, parent: input.parent ?? false },
    who,
  );
}

/** Removes a contact: a parent's. Calls with it stay in the records, with its name, until they age out. */
export function removeContact(ctx: PolicyContext, deviceId: string, id: string, who: Person): Changed<CallsDone & { removed: Contact | null }> {
  onlyPeople(who);
  const removed = getContact(ctx.db, deviceId, id);
  const done = change(ctx, deviceId, who, (current) => ({ ...current, contacts: current.contacts.filter((c) => c.id !== id) }));
  return { ...done, result: { ...done.result, removed } };
}

/**
 * Blocks a number: Belay, as the phone app, puts it on Android's block list, which blocks its calls
 * and texts. Tightening, so an AI app may (it's in the activity log). Never an emergency number or
 * 988, a contact's number, or one on the emergency card: refused, with why.
 */
export function blockNumber(ctx: PolicyContext, deviceId: string, number: string, who: Changer): Changed<CallsDone> {
  typed([number], "blocked");
  return change(ctx, deviceId, who, (current) => ({ ...current, blockedNumbers: [...current.blockedNumbers, number] }));
}

/** Unblocks a number: loosening, so a parent's (an AI app proposes it). */
export function unblockNumber(ctx: PolicyContext, deviceId: string, number: string, who: Person): Changed<CallsDone & { was: boolean }> {
  onlyPeople(who);
  const clean = cleanNumber(number);
  const was = sideOf(ctx.db, deviceId).blockedNumbers.includes(clean);
  const done = change(ctx, deviceId, who, (current) => ({ ...current, blockedNumbers: current.blockedNumbers.filter((n) => n !== clean) }));
  return { ...done, result: { ...done.result, was } };
}

/**
 * A number Belay never records or reads (beyond 988 and emergency numbers, which it never does),
 * like a helpline the kid may call: a parent's alone, either way. At most 50.
 */
export function setPrivateNumber(ctx: PolicyContext, deviceId: string, number: string, on: boolean, who: Person): Changed<CallsDone & { was: boolean }> {
  onlyPeople(who);
  if (on) typed([number], "private");
  const clean = cleanNumber(number);
  const was = sideOf(ctx.db, deviceId).privateNumbers.includes(clean);
  const done = change(ctx, deviceId, who, (current) => ({
    ...current,
    privateNumbers: on ? [...current.privateNumbers, clean] : current.privateNumbers.filter((n) => n !== clean),
  }));
  return { ...done, result: { ...done.result, was } };
}

/**
 * An AI app's change that only tightens, applied at once; or a proposal a parent approved, applied
 * in their name. Each part must still be as it was when the change was worked out (or proposed),
 * else it's refused as out of date and nothing changes.
 */
export function applyCallsPatch(ctx: PolicyContext, deviceId: string, patch: CallsPatch, who: Changer, opts: { proposalId?: string } = {}): Changed<CallsDone> {
  return change(
    ctx,
    deviceId,
    who,
    (current) => {
      const applied = applyPatch(current, patch);
      if ("outdated" in applied) throw new RuleRefused(applied.outdated);
      return applied.side;
    },
    opts,
  );
}

// ── An AI app's change, in its own terms (MCP's change_calls) ────────

export interface CallsOps {
  mode?: CallMode;
  unknown?: CallAction;
  withheld?: CallAction;
  outgoing?: Outgoing;
  quiet?: boolean;
  add_contacts?: { name: string; numbers: string[]; calls?: boolean; texts?: boolean; parent?: boolean }[];
  change_contacts?: { id: string; name?: string; numbers?: string[]; calls?: boolean; texts?: boolean; parent?: boolean }[];
  remove_contacts?: string[];
  block_numbers?: string[];
  unblock_numbers?: string[];
}

/**
 * The side a change would leave, or why it can't (a contact id that isn't there). Nothing is saved.
 * `makeId` names a contact it adds (MCP's is proposedContactId, so the same contact proposed again is
 * the same proposal).
 */
export function applyOps(
  current: CallsSide,
  ops: CallsOps,
  makeId: (contact: { name: string; numbers: string[] }) => string = () => newContactId(),
): { side: CallsSide } | { problem: string } {
  const rules = { ...current.rules };
  if (ops.mode !== undefined) rules.mode = ops.mode;
  if (ops.unknown !== undefined) rules.unknown = ops.unknown;
  if (ops.withheld !== undefined) rules.withheld = ops.withheld;
  if (ops.outgoing !== undefined) rules.outgoing = ops.outgoing;
  if (ops.quiet !== undefined) rules.quiet = ops.quiet;
  const problem = rulesProblem(rules);
  if (problem) return { problem };
  let contacts = current.contacts.map((c) => ({ ...c, numbers: [...c.numbers] }));
  for (const input of ops.change_contacts ?? []) {
    const index = contacts.findIndex((c) => c.id === input.id);
    const found = contacts[index];
    if (!found) return { problem: `No contact has the id ${input.id}. get_contacts lists them.` };
    contacts[index] = {
      ...found,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.numbers !== undefined ? { numbers: [...input.numbers] } : {}),
      ...(input.calls !== undefined ? { calls: input.calls } : {}),
      ...(input.texts !== undefined ? { texts: input.texts } : {}),
      ...(input.parent !== undefined ? { parent: input.parent } : {}),
    };
  }
  for (const id of ops.remove_contacts ?? []) {
    if (!contacts.some((c) => c.id === id)) return { problem: `No contact has the id ${id}. get_contacts lists them.` };
    contacts = contacts.filter((c) => c.id !== id);
  }
  for (const input of ops.add_contacts ?? []) {
    // An id a contact has already (one added the same way, and renamed since) is never reused.
    const made = makeId(input);
    const id = contacts.some((c) => c.id === made) ? newContactId() : made;
    contacts.push({ id, name: input.name, numbers: [...input.numbers], calls: input.calls ?? true, texts: input.texts ?? true, parent: input.parent ?? false });
  }
  const unblock = new Set((ops.unblock_numbers ?? []).map(cleanNumber));
  const blocked = [...current.blockedNumbers.filter((n) => !unblock.has(n)), ...(ops.block_numbers ?? []).map(cleanNumber)];
  return { side: { ...current, rules, contacts, blockedNumbers: blocked } };
}
