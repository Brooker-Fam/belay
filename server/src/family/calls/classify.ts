/**
 * Whether a change to a phone's calls tightens or loosens them (docs/design/phase5-calls-texts.md,
 * "On the server"). An AI app may apply a change only when every part of it tightens; anything else
 * is a proposal for a parent (Phase 2's rule).
 *
 * Tightening: fewer contacts allowed to call (a contact removed, or its calls or texts turned off,
 * or a number taken off it), "contacts only" (`mode: contacts`), a stricter rule for callers who
 * aren't contacts or have no caller id (ring, then voicemail, then reject), the kid calling only
 * contacts (`outgoing: contacts`), quiet times on, and blocking a number. The reverse loosens, and
 * so does adding a contact (or a number to one, or making one a parent).
 *
 * A parent contact always rings and is on the kid's emergency card, so anything that takes from
 * one (removing it, un-marking it, its calls or a number) is neither: a parent decides. So is a new
 * name for a contact: the kid sees the name.
 *
 * Turning calls on or off, recording them (`log`) and the private numbers are neither too: they
 * decide what Belay collects, so they're a parent's alone, never an AI app's, not even as a
 * proposal (`collection`).
 */
import type { CallAction, CallMode, CallRules, ContactData, Outgoing } from "./store.js";

export type Effect = "tightens" | "loosens" | "neither";

/** One side of a change: a phone's calls as they are, or as a change would leave them. */
export interface CallsSide {
  enabled: boolean;
  rules: CallRules;
  contacts: (ContactData & { id: string })[];
  privateNumbers: string[];
  blockedNumbers: string[];
}

interface Base {
  effect: Effect;
  /** The contact it's about, if it's about one. */
  about: string | null;
}

export type CallChange = Base &
  (
    | { kind: "enabled"; to: boolean }
    | { kind: "log"; to: boolean }
    | { kind: "private_added" | "private_removed"; numbers: string[] }
    | { kind: "mode"; to: CallMode }
    | { kind: "unknown" | "withheld"; from: CallAction; to: CallAction }
    | { kind: "outgoing"; to: Outgoing }
    | { kind: "quiet"; to: boolean }
    | { kind: "contact_added"; name: string; numbers: string[]; calls: boolean; texts: boolean; parent: boolean }
    | { kind: "contact_removed"; name: string; parent: boolean }
    | { kind: "contact_renamed"; from: string; to: string }
    | { kind: "contact_numbers_added" | "contact_numbers_removed"; name: string; numbers: string[] }
    | { kind: "contact_calls" | "contact_texts" | "contact_parent"; name: string; to: boolean }
    | { kind: "blocked" | "unblocked"; numbers: string[] }
  );

export interface Classification {
  /** In order: on or off, recording, private numbers, the rules, contacts, blocked numbers. */
  changes: CallChange[];
  /** Nothing changes. */
  none: boolean;
  /** Every part tightens (and something does): an AI app may apply it. */
  onlyTightens: boolean;
  /** It turns calls on or off, recording, or the private numbers: a parent's alone, either way. */
  collection: boolean;
  /** "loosens" when any part does, "tightens" when every part does, else "neither"; "none" for no change. */
  effect: Effect | "none";
}

/** How strict a rule for callers is: reject is the strictest, ring the least. */
const STRICTNESS: Record<CallAction, number> = { reject: 2, voicemail: 1, ring: 0 };

const minus = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const drop = new Set(b);
  return [...new Set(a)].filter((x) => !drop.has(x)).sort();
};

/** A flag going on loosens, going off tightens; going off on a parent contact is a parent's to decide. */
const flag = (to: boolean, parent: boolean): Effect => (to ? "loosens" : parent ? "neither" : "tightens");

function contacts(from: CallsSide["contacts"], to: CallsSide["contacts"]): CallChange[] {
  const before = new Map(from.map((c) => [c.id, c]));
  const after = new Map(to.map((c) => [c.id, c]));
  const out: CallChange[] = [];
  for (const now of to) {
    const old = before.get(now.id);
    if (!old) {
      out.push({ kind: "contact_added", effect: "loosens", about: now.id, name: now.name, numbers: [...now.numbers], calls: now.calls, texts: now.texts, parent: now.parent });
      continue;
    }
    const name = now.name;
    if (old.name !== now.name) out.push({ kind: "contact_renamed", effect: "neither", about: now.id, from: old.name, to: now.name });
    const more = minus(now.numbers, old.numbers);
    const fewer = minus(old.numbers, now.numbers);
    if (more.length) out.push({ kind: "contact_numbers_added", effect: "loosens", about: now.id, name, numbers: more });
    if (fewer.length) out.push({ kind: "contact_numbers_removed", effect: old.parent ? "neither" : "tightens", about: now.id, name, numbers: fewer });
    if (old.calls !== now.calls) out.push({ kind: "contact_calls", effect: flag(now.calls, old.parent), about: now.id, name, to: now.calls });
    if (old.texts !== now.texts) out.push({ kind: "contact_texts", effect: flag(now.texts, old.parent), about: now.id, name, to: now.texts });
    if (old.parent !== now.parent) out.push({ kind: "contact_parent", effect: now.parent ? "loosens" : "neither", about: now.id, name, to: now.parent });
  }
  for (const old of from) {
    if (!after.has(old.id)) out.push({ kind: "contact_removed", effect: old.parent ? "neither" : "tightens", about: old.id, name: old.name, parent: old.parent });
  }
  return out;
}

/** Whether a change to a phone's calls tightens or loosens them: see the top of this file. */
export function classifyCallsChange(before: CallsSide, after: CallsSide): Classification {
  const changes: CallChange[] = [];
  if (before.enabled !== after.enabled) changes.push({ kind: "enabled", effect: "neither", about: null, to: after.enabled });
  if (before.rules.log !== after.rules.log) changes.push({ kind: "log", effect: "neither", about: null, to: after.rules.log });
  const privateAdded = minus(after.privateNumbers, before.privateNumbers);
  const privateRemoved = minus(before.privateNumbers, after.privateNumbers);
  if (privateAdded.length) changes.push({ kind: "private_added", effect: "neither", about: null, numbers: privateAdded });
  if (privateRemoved.length) changes.push({ kind: "private_removed", effect: "neither", about: null, numbers: privateRemoved });
  const a = before.rules;
  const b = after.rules;
  if (a.mode !== b.mode) changes.push({ kind: "mode", effect: b.mode === "contacts" ? "tightens" : "loosens", about: null, to: b.mode });
  for (const key of ["unknown", "withheld"] as const) {
    if (a[key] === b[key]) continue;
    changes.push({ kind: key, effect: STRICTNESS[b[key]] > STRICTNESS[a[key]] ? "tightens" : "loosens", about: null, from: a[key], to: b[key] });
  }
  if (a.outgoing !== b.outgoing) changes.push({ kind: "outgoing", effect: b.outgoing === "contacts" ? "tightens" : "loosens", about: null, to: b.outgoing });
  if (a.quiet !== b.quiet) changes.push({ kind: "quiet", effect: b.quiet ? "tightens" : "loosens", about: null, to: b.quiet });
  changes.push(...contacts(before.contacts, after.contacts));
  const blocked = minus(after.blockedNumbers, before.blockedNumbers);
  const unblocked = minus(before.blockedNumbers, after.blockedNumbers);
  if (blocked.length) changes.push({ kind: "blocked", effect: "tightens", about: null, numbers: blocked });
  if (unblocked.length) changes.push({ kind: "unblocked", effect: "loosens", about: null, numbers: unblocked });
  const none = changes.length === 0;
  const onlyTightens = !none && changes.every((c) => c.effect === "tightens");
  return {
    changes,
    none,
    onlyTightens,
    collection: changes.some((c) => c.kind === "enabled" || c.kind === "log" || c.kind === "private_added" || c.kind === "private_removed"),
    effect: none ? "none" : onlyTightens ? "tightens" : changes.some((c) => c.effect === "loosens") ? "loosens" : "neither",
  };
}
