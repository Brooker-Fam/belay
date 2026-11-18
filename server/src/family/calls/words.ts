/**
 * Phase 5's calls in words, for the parent pages, MCP, the CLI and the activity log. Contact names
 * are the family's words (or the kid's, from a request a parent approved): the pages escape them,
 * and MCP puts every sentence that holds one under `untrusted`.
 */
import { oneLine } from "../../text.js";
import type { CallChange } from "./classify.js";
import type { CallAction, CallRules, CallSettings } from "./store.js";

export const ACTION_WORDS: Record<CallAction, string> = {
  ring: "ring",
  voicemail: "go to voicemail",
  reject: "are refused",
};

/** "Unknown callers go to voicemail", for each rule. */
export const UNKNOWN_WORDS: Record<CallAction, string> = {
  ring: "Callers who aren't contacts ring",
  voicemail: "Callers who aren't contacts go to voicemail",
  reject: "Callers who aren't contacts are refused",
};

export const WITHHELD_WORDS: Record<CallAction, string> = {
  ring: "Callers with no caller ID ring",
  voicemail: "Callers with no caller ID go to voicemail",
  reject: "Callers with no caller ID are refused",
};

/**
 * Phase 5's texts aren't built yet: a contact's `texts` is kept for when they are, and the phone
 * ignores it, so wherever it's shown or chosen, it says so.
 */
export const TEXTS_NOT_ENFORCED = "not enforced yet: for now, texting works with anyone";

const name = (text: string) => `"${oneLine(text, 60)}"`;
const list = (numbers: string[]) => (numbers.length <= 3 ? numbers.join(", ") : `${numbers.slice(0, 3).join(", ")} and ${numbers.length - 3} more`);
const can = (calls: boolean, texts: boolean) =>
  calls && texts ? "who can call and text" : calls ? "who can call (not text)" : texts ? "who can text (not call)" : "who can't call or text";

/** The rules in words, one sentence each: who rings, whom the kid can call, quiet times, recording. */
export function rulesInWords(r: CallRules): string[] {
  return [
    r.mode === "open" ? "Anyone can call." : `Only contacts can call. ${UNKNOWN_WORDS[r.unknown]}.`,
    r.mode === "open" ? "Callers with no caller ID ring like anyone else." : `${WITHHELD_WORDS[r.withheld]}.`,
    r.outgoing === "contacts" ? "The kid can call only contacts." : "The kid can call any number.",
    r.quiet ? "At bedtime and school times, only parents ring." : "Calls ring at bedtime and school times too.",
    r.log ? "Belay keeps a record of calls: who, when and how long, never what's said." : "Belay keeps no record of calls.",
  ];
}

/** "on: only contacts can call", for lists and the CLI. */
export function callsSummary(s: CallSettings | null): string {
  if (!s?.enabled) return "off: Belay isn't the phone app, so it leaves calls alone";
  return `on: ${s.mode === "open" ? "anyone can call" : "only contacts can call"}, the kid can call ${s.outgoing === "contacts" ? "only contacts" : "any number"}${s.quiet ? ", quiet at bedtime and school times" : ""}, ${s.log ? "calls recorded" : "no record of calls"}`;
}

/** "a number", "3 numbers". */
const howMany = (numbers: string[]) => (numbers.length === 1 ? "a number" : `${numbers.length} numbers`);

/**
 * One change, as a parent reads it ("Add "Coach Lee" (+15555550142), who can call and text").
 * With `numbers` false, for an AI app while a parent keeps calls from AI apps (the Calls category
 * off), it names no number and no contact: "Add a contact, who can call and text".
 */
export function callChangeSentence(c: CallChange, opts: { numbers?: boolean } = {}): string {
  if (opts.numbers === false) {
    switch (c.kind) {
      case "contact_added":
        return `Add a contact, ${can(c.calls, c.texts)}${c.parent ? ", as a parent: always rings, and on the emergency card" : ""}`;
      case "contact_removed":
        return `Remove a contact${c.parent ? " (a parent, on the emergency card)" : ""}`;
      case "contact_renamed":
        return "Rename a contact";
      case "contact_numbers_added":
        return `Add ${howMany(c.numbers)} to a contact`;
      case "contact_numbers_removed":
        return `Take ${howMany(c.numbers)} off a contact`;
      case "contact_calls":
        return c.to ? "A contact can call" : "A contact can't call";
      case "contact_texts":
        return c.to ? "A contact can text" : "A contact can't text";
      case "contact_parent":
        return c.to ? "A contact is a parent: always rings, and on the emergency card" : "A contact isn't a parent any more: off the emergency card";
      case "blocked":
        return `Block ${howMany(c.numbers)}`;
      case "unblocked":
        return `Unblock ${howMany(c.numbers)}`;
      default:
        // The rest name no one.
        break;
    }
  }
  switch (c.kind) {
    case "enabled":
      return c.to ? "Turn calls on: Belay becomes the phone app" : "Turn calls off: Belay stops being the phone app";
    case "log":
      return c.to ? "Keep a record of calls" : "Stop keeping a record of calls";
    case "private_added":
      return `Never record ${c.numbers.length === 1 ? "a private number" : `${c.numbers.length} private numbers`}`;
    case "private_removed":
      return `Take ${c.numbers.length === 1 ? "a number" : `${c.numbers.length} numbers`} off the private numbers`;
    case "mode":
      return c.to === "contacts" ? "Only contacts can call" : "Anyone can call";
    case "unknown":
      return `${UNKNOWN_WORDS[c.to]} (they ${ACTION_WORDS[c.from]} now)`;
    case "withheld":
      return `${WITHHELD_WORDS[c.to]} (they ${ACTION_WORDS[c.from]} now)`;
    case "outgoing":
      return c.to === "contacts" ? "The kid can call only contacts" : "The kid can call any number";
    case "quiet":
      return c.to ? "At bedtime and school times, only parents ring" : "Calls ring at bedtime and school times too";
    case "contact_added":
      return `Add ${name(c.name)} (${list(c.numbers)}) as a contact, ${can(c.calls, c.texts)}${c.parent ? ", as a parent: always rings, and on the emergency card" : ""}`;
    case "contact_removed":
      return `Remove ${name(c.name)} from the contacts${c.parent ? " (a parent, on the emergency card)" : ""}`;
    case "contact_renamed":
      return `Rename the contact ${name(c.from)} to ${name(c.to)}`;
    case "contact_numbers_added":
      return `Add ${list(c.numbers)} to ${name(c.name)}`;
    case "contact_numbers_removed":
      return `Take ${list(c.numbers)} off ${name(c.name)}`;
    case "contact_calls":
      return c.to ? `${name(c.name)} can call` : `${name(c.name)} can't call`;
    case "contact_texts":
      return c.to ? `${name(c.name)} can text` : `${name(c.name)} can't text`;
    case "contact_parent":
      return c.to ? `${name(c.name)} is a parent: always rings, and on the emergency card` : `${name(c.name)} isn't a parent any more: off the emergency card`;
    case "blocked":
      return `Block ${list(c.numbers)}`;
    case "unblocked":
      return `Unblock ${list(c.numbers)}`;
  }
}

export const OUTCOME_WORDS = {
  answered: "answered",
  missed: "missed",
  rejected: "refused",
  voicemail: "went to voicemail",
  not_placed: "not placed: Belay didn't allow it",
} as const;

export const REASON_WORDS = {
  unknown: "not a contact",
  withheld: "no caller ID",
  quiet: "quiet time",
  not_allowed: "not a contact the kid may call",
} as const;
