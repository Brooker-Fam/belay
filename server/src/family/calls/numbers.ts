/**
 * Phase 5: phone numbers as the server takes them. Every number the family stores (a contact's, a
 * private one, a blocked one) is E.164 (`+` and the country code, then the number), and never an
 * emergency number or 988.
 *
 * The phone decides 911, Android's emergency numbers and 988 in its own code (`AlwaysAllowed`),
 * never from the policy, so no rule can block them. The server can't ask Android which numbers are
 * emergency numbers where the phone is, so it knows the common ones the world dials, and 988's own
 * full number: it refuses to block any of them (saying why, rather than only "not E.164"), never
 * stores one as a contact or a private number, and drops a call record that names one.
 */
import { e164 } from "../../device/schemas.js";

export const CALL_LIMITS = {
  /** The policy's limits (docs/protocol.md, "Policy"). */
  maxContacts: 500,
  contactName: 60,
  numbersPerContact: 5,
  maxPrivate: 50,
  maxBlocked: 500,
} as const;

/**
 * Emergency numbers people dial around the world (Android's own list, per SIM and network, is the
 * phone's to check): North America's 911, GSM's 112 and 08, the UK's 999, Australia's 000, New
 * Zealand's 111, and the police, fire and ambulance numbers of other countries.
 */
const EMERGENCY = new Set([
  "911",
  "112",
  "08",
  "999",
  "000",
  "111",
  "110",
  "118",
  "119",
  "120",
  "122",
  "100",
  "101",
  "102",
  "108",
  "15",
  "17",
  "18",
  "190",
  "192",
  "193",
  "199",
  "1122",
  "10111",
  "10177",
]);

/** The 988 Suicide and Crisis Lifeline: 988 itself, and its earlier full number, which still reaches it. */
const CRISIS_SHORT = new Set(["988"]);
const CRISIS_FULL = new Set(["+18002738255"]);

export type AlwaysAllowed = "emergency" | "988";

/**
 * Whether a number, as a person typed it or a phone sent it, is an emergency number or 988: the
 * number itself (911), after a country code (+1 911, +44 999) or North America's leading 1
 * (1-988), or 988's full number in any form.
 */
export function alwaysAllowed(text: string): AlwaysAllowed | null {
  const trimmed = text.trim();
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;
  const plus = trimmed.startsWith("+");
  // 988's full number: +1 800 273 8255, 1-800-273-8255, or (800) 273-8255.
  const full = plus ? `+${digits}` : digits.length === 11 && digits.startsWith("1") ? `+${digits}` : digits.length === 10 ? `+1${digits}` : null;
  if (full !== null && CRISIS_FULL.has(full)) return "988";
  const tails = [digits];
  // A short number after a country code (up to 3 digits), or after North America's 1.
  if (digits.length <= 8) {
    if (plus) for (let cut = 1; cut <= 3 && cut < digits.length; cut++) tails.push(digits.slice(cut));
    else if (digits.startsWith("1") && digits.length > 1) tails.push(digits.slice(1));
  }
  if (tails.some((t) => CRISIS_SHORT.has(t))) return "988";
  if (tails.some((t) => EMERGENCY.has(t))) return "emergency";
  return null;
}

/** A number as people write it, ready to check: without spaces, dashes, dots and parentheses. */
export function cleanNumber(text: string): string {
  return text.trim().replace(/[\s().-]/g, "");
}

export const isE164 = (number: string): boolean => e164.safeParse(number).success;

export type NumberUse = "contact" | "private" | "blocked";

const ALWAYS_WORDS: Record<NumberUse, Record<AlwaysAllowed, string>> = {
  blocked: {
    emergency: "Belay never blocks 911 or any other emergency number: the kid can always call them, and their calls always ring, whatever the rules say.",
    "988": "Belay never blocks 988: the kid can always call and text the crisis line, whatever the rules say.",
  },
  private: {
    emergency: "Calls with 911 and every emergency number are always private: Belay never records them, so there's no need to add one.",
    "988": "Calls and texts with 988 are always private: Belay never records them, so there's no need to add it.",
  },
  contact: {
    emergency: "911 and every emergency number always work without being a contact, and Belay never records them.",
    "988": "988 always works without being a contact, and Belay never records it.",
  },
};

/**
 * Why a number won't do for this use, or null. Blocking refuses an emergency number or 988 in any
 * form, with why. A contact or a private number must be E.164, which no emergency number or 988 is
 * (they're short): those are refused with why too. 988's full number is a real E.164 number the
 * phone may not know as 988, so it can be a contact or a private number, and is never blocked.
 */
export function numberProblem(text: string, use: NumberUse): string | null {
  const always = alwaysAllowed(text);
  const number = cleanNumber(text);
  if (always && (use === "blocked" || !isE164(number))) return ALWAYS_WORDS[use][always];
  if (!isE164(number)) {
    const typed = text.trim().slice(0, 30);
    return `${typed ? `${typed} isn't` : "That isn't"} a phone number in international form: start with + and the country code, like +15555550100.`;
  }
  return null;
}
