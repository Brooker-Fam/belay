/**
 * Phase 5's pure parts: which numbers always work (911, emergency numbers, 988, in any form), and
 * whether a change to a phone's calls tightens or loosens them, in both directions, including what
 * only a parent decides (on or off, recording, private numbers) and what a parent contact keeps for
 * a parent. And the proposal's patch: what it changes, and when it's out of date. Made-up numbers
 * only (555-01xx).
 */
import { describe, expect, it } from "vitest";
import { type CallsSide, classifyCallsChange } from "../src/family/calls/classify.js";
import { alwaysAllowed, numberProblem } from "../src/family/calls/numbers.js";
import { applyPatch, emptyPatch, patchOf, patchSides, settle, sideProblem } from "../src/family/calls/patch.js";
import { DEFAULT_CALL_RULES } from "../src/family/calls/store.js";
import { callChangeSentence } from "../src/family/calls/words.js";

const MOM = "+15555550100";
const COACH = "+15555550142";
const STRANGER = "+15555550199";

const side = (over: Partial<CallsSide> = {}): CallsSide => ({
  enabled: true,
  rules: { ...DEFAULT_CALL_RULES, mode: "contacts" },
  contacts: [
    { id: "c-mom", name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true },
    { id: "c-coach", name: "Coach Lee", numbers: [COACH], calls: true, texts: true, parent: false },
  ],
  privateNumbers: [],
  blockedNumbers: [],
  ...over,
});

const effects = (before: CallsSide, after: CallsSide) => classifyCallsChange(before, after).changes.map((c) => [c.kind, c.effect]);

describe("numbers that always work", () => {
  it("knows 911, emergency numbers and 988 in the forms people type, and 988's full number", () => {
    for (const n of ["911", "112", "999", "000", "08", "110", "119", " 9 1 1 ", "+1 911", "+44 999", "+61000", "1-911"]) expect(alwaysAllowed(n), n).toBe("emergency");
    for (const n of ["988", "+1988", "1-988", "+1 (988)", "+1 800 273 8255", "1-800-273-8255", "(800) 273-8255", "+18002738255"]) expect(alwaysAllowed(n), n).toBe("988");
    for (const n of [MOM, COACH, "+44 20 7946 0123", "5911", "+15559110100", "", "call me"]) expect(alwaysAllowed(n), n).toBeNull();
  });

  it("never blocks one, saying why; a contact or private number must be E.164, which no short number is", () => {
    expect(numberProblem("911", "blocked")).toBe("Belay never blocks 911 or any other emergency number: they always work, in and out, whatever the rules say.");
    expect(numberProblem("+1 988", "blocked")).toBe("Belay never blocks 988: the crisis line always works, in and out, whatever the rules say.");
    expect(numberProblem("+18002738255", "blocked")).toBe("Belay never blocks 988: the crisis line always works, in and out, whatever the rules say.");
    expect(numberProblem("988", "private")).toBe("Calls and texts with 988 are always private: Belay never records them, so there's no need to add it.");
    expect(numberProblem("112", "contact")).toBe("911 and every emergency number always work without being a contact, and Belay never records them.");
    // 988's full number is a real number the phone may not know as 988: a parent may make it a contact, or private.
    expect(numberProblem("+18002738255", "private")).toBeNull();
    expect(numberProblem("+18002738255", "contact")).toBeNull();
    expect(numberProblem("555-0100", "blocked")).toBe("555-0100 isn't a phone number in international form: start with + and the country code, like +15555550100.");
    expect(numberProblem("+1 555 555 0100", "blocked")).toBeNull();
  });
});

describe("whether a change to calls tightens or loosens", () => {
  it("each rule, in both directions", () => {
    const open = side({ rules: { ...DEFAULT_CALL_RULES, mode: "open" } });
    const contacts = side();
    expect(effects(open, contacts)).toEqual([["mode", "tightens"]]);
    expect(effects(contacts, open)).toEqual([["mode", "loosens"]]);
    for (const key of ["unknown", "withheld"] as const) {
      const at = (value: "ring" | "voicemail" | "reject") => side({ rules: { ...contacts.rules, [key]: value } });
      expect(effects(at("ring"), at("voicemail"))).toEqual([[key, "tightens"]]);
      expect(effects(at("voicemail"), at("reject"))).toEqual([[key, "tightens"]]);
      expect(effects(at("ring"), at("reject"))).toEqual([[key, "tightens"]]);
      expect(effects(at("reject"), at("voicemail"))).toEqual([[key, "loosens"]]);
      expect(effects(at("voicemail"), at("ring"))).toEqual([[key, "loosens"]]);
    }
    const out = (outgoing: "any" | "contacts") => side({ rules: { ...contacts.rules, outgoing } });
    expect(effects(out("any"), out("contacts"))).toEqual([["outgoing", "tightens"]]);
    expect(effects(out("contacts"), out("any"))).toEqual([["outgoing", "loosens"]]);
    const quiet = (on: boolean) => side({ rules: { ...contacts.rules, quiet: on } });
    expect(effects(quiet(false), quiet(true))).toEqual([["quiet", "tightens"]]);
    expect(effects(quiet(true), quiet(false))).toEqual([["quiet", "loosens"]]);
  });

  it("fewer contacts allowed to call tightens; adding one, or a number, or calls, loosens", () => {
    const before = side();
    const noCoach = side({ contacts: before.contacts.filter((c) => c.id !== "c-coach") });
    expect(effects(before, noCoach)).toEqual([["contact_removed", "tightens"]]);
    expect(effects(noCoach, before)).toEqual([["contact_added", "loosens"]]);
    const coach = (over: object) => side({ contacts: before.contacts.map((c) => (c.id === "c-coach" ? { ...c, ...over } : c)) });
    expect(effects(before, coach({ calls: false }))).toEqual([["contact_calls", "tightens"]]);
    expect(effects(coach({ calls: false }), before)).toEqual([["contact_calls", "loosens"]]);
    expect(effects(before, coach({ texts: false }))).toEqual([["contact_texts", "tightens"]]);
    expect(effects(before, coach({ numbers: [COACH, STRANGER] }))).toEqual([["contact_numbers_added", "loosens"]]);
    expect(effects(coach({ numbers: [COACH, STRANGER] }), before)).toEqual([["contact_numbers_removed", "tightens"]]);
    // A new number in place of the old one: one part loosens, so the whole does.
    const swapped = classifyCallsChange(before, coach({ numbers: [STRANGER] }));
    expect(swapped.changes.map((c) => c.effect)).toEqual(["loosens", "tightens"]);
    expect(swapped).toMatchObject({ onlyTightens: false, effect: "loosens" });
    expect(effects(before, coach({ parent: true }))).toEqual([["contact_parent", "loosens"]]);
  });

  it("anything that takes from a parent contact, and a new name, is neither: a parent decides", () => {
    const before = side();
    const mom = (over: object) => side({ contacts: before.contacts.map((c) => (c.id === "c-mom" ? { ...c, ...over } : c)) });
    expect(effects(before, side({ contacts: before.contacts.filter((c) => c.id !== "c-mom") }))).toEqual([["contact_removed", "neither"]]);
    expect(effects(before, mom({ parent: false }))).toEqual([["contact_parent", "neither"]]);
    expect(effects(before, mom({ calls: false }))).toEqual([["contact_calls", "neither"]]);
    expect(effects(mom({ numbers: [MOM, "+15555550101"] }), before)).toEqual([["contact_numbers_removed", "neither"]]);
    expect(effects(before, mom({ name: "Stranger" }))).toEqual([["contact_renamed", "neither"]]);
    expect(classifyCallsChange(before, mom({ parent: false }))).toMatchObject({ onlyTightens: false, effect: "neither", collection: false });
  });

  it("blocking a number tightens, unblocking loosens", () => {
    expect(effects(side(), side({ blockedNumbers: [STRANGER] }))).toEqual([["blocked", "tightens"]]);
    expect(effects(side({ blockedNumbers: [STRANGER] }), side())).toEqual([["unblocked", "loosens"]]);
  });

  it("on or off, recording and private numbers are collection: neither, and never an AI app's", () => {
    for (const [before, after, kind] of [
      [side({ enabled: false }), side(), "enabled"],
      [side(), side({ enabled: false }), "enabled"],
      [side(), side({ rules: { ...side().rules, log: true } }), "log"],
      [side({ rules: { ...side().rules, log: true } }), side(), "log"],
      [side(), side({ privateNumbers: [STRANGER] }), "private_added"],
      [side({ privateNumbers: [STRANGER] }), side(), "private_removed"],
    ] as const) {
      const c = classifyCallsChange(before, after);
      expect(c.changes.map((x) => [x.kind, x.effect]), kind).toEqual([[kind, "neither"]]);
      expect(c, kind).toMatchObject({ collection: true, onlyTightens: false });
    }
  });

  it("only tightens when every part does; a mix loosens; nothing is none", () => {
    const before = side({ rules: { ...DEFAULT_CALL_RULES, mode: "open" } });
    expect(classifyCallsChange(before, side({ rules: { ...DEFAULT_CALL_RULES, mode: "contacts", quiet: true }, blockedNumbers: [STRANGER] }))).toMatchObject({
      onlyTightens: true,
      effect: "tightens",
      collection: false,
    });
    expect(classifyCallsChange(before, side({ rules: { ...DEFAULT_CALL_RULES, mode: "contacts", outgoing: "any", unknown: "ring" } }))).toMatchObject({ onlyTightens: false, effect: "loosens" });
    expect(classifyCallsChange(before, before)).toMatchObject({ none: true, onlyTightens: false, effect: "none" });
  });

  it("says each change in a parent's words", () => {
    const before = side();
    const after = side({
      rules: { ...before.rules, unknown: "reject", quiet: true },
      contacts: [...before.contacts, { id: "c-gran", name: "Grandma", numbers: ["+15555550123"], calls: true, texts: false, parent: false }],
      blockedNumbers: [STRANGER],
    });
    expect(classifyCallsChange(before, after).changes.map(callChangeSentence)).toEqual([
      "Callers who aren't contacts are refused (they go to voicemail now)",
      "At bedtime and school times, only parents ring",
      'Add "Grandma" (+15555550123) as a contact, who can call (not text)',
      "Block +15555550199",
    ]);
  });
});

describe("a calls proposal's patch", () => {
  it("holds only what it changes, never on or off, recording or private numbers", () => {
    const before = side();
    const after = side({ enabled: false, rules: { ...before.rules, log: true, unknown: "ring" }, privateNumbers: [STRANGER], blockedNumbers: [STRANGER] });
    const patch = patchOf(before, after);
    expect(patch).toEqual({ rules: { unknown: { before: "voicemail", after: "ring" } }, contacts: [], blocked: [{ number: STRANGER, before: false, after: true }] });
    expect(emptyPatch(patchOf(before, before))).toBe(true);
    const { before: was, after: will } = patchSides(patch);
    expect(classifyCallsChange(was, will).changes.map((c) => [c.kind, c.effect])).toEqual([
      ["unknown", "loosens"],
      ["blocked", "tightens"],
    ]);
  });

  it("applies while each part is as it was; else it's out of date, saying what changed", () => {
    const before = side();
    const added = { id: "c-gran", name: "Grandma", numbers: ["+15555550123"], calls: true, texts: true, parent: false };
    const patch = patchOf(before, side({ contacts: [...before.contacts, added], rules: { ...before.rules, unknown: "ring" } }));
    const applied = applyPatch(before, patch);
    expect("side" in applied && applied.side.contacts.map((c) => c.id)).toEqual(["c-mom", "c-coach", "c-gran"]);
    // Something else changed meanwhile: still applies.
    expect("side" in applyPatch(side({ blockedNumbers: [STRANGER] }), patch)).toBe(true);
    expect(applyPatch(side({ rules: { ...before.rules, unknown: "reject" } }), patch)).toEqual({ outdated: "The phone's call rules changed after this was proposed." });
    const removeCoach = patchOf(before, side({ contacts: before.contacts.filter((c) => c.id !== "c-coach") }));
    const renamed = side({ contacts: before.contacts.map((c) => (c.id === "c-coach" ? { ...c, name: "Coach" } : c)) });
    expect(applyPatch(renamed, removeCoach)).toEqual({ outdated: 'The contact "Coach Lee" changed after this was proposed.' });
    const unblock = patchOf(side({ blockedNumbers: [STRANGER] }), side());
    expect(applyPatch(side(), unblock)).toEqual({ outdated: "+15555550199 was unblocked after this was proposed." });
  });
});

describe("a side as it can be saved", () => {
  it("cleans numbers, and unblocks a number a contact gains", () => {
    const before = side({ blockedNumbers: [STRANGER] });
    const { side: settled, unblocked } = settle(before, {
      ...before,
      contacts: [...before.contacts, { id: "c-new", name: " Neighbor ", numbers: ["+1 555 555 0199", "+15555550199"], calls: true, texts: true, parent: false }],
    });
    expect(settled.contacts.at(-1)).toMatchObject({ name: "Neighbor", numbers: [STRANGER] });
    expect(settled.blockedNumbers).toEqual([]);
    expect(unblocked).toEqual([STRANGER]);
  });

  it("refuses what can't be saved, with why", () => {
    const before = side();
    const contact = (over: object) => ({ ...before, contacts: [...before.contacts, { id: "c-new", name: "New", numbers: [STRANGER], calls: true, texts: true, parent: false, ...over }] });
    expect(sideProblem(before, contact({ name: " " }))).toBe("Give the contact a name, like Grandma.");
    expect(sideProblem(before, contact({ name: "x".repeat(61) }))).toBe("Keep a contact's name to 60 characters: the kid sees it.");
    expect(sideProblem(before, contact({ name: "coach lee" }))).toBe("There's already a contact called coach lee.");
    expect(sideProblem(before, contact({ numbers: [] }))).toBe("Give New a number.");
    expect(sideProblem(before, contact({ numbers: ["+15555550001", "+15555550002", "+15555550003", "+15555550004", "+15555550005", "+15555550006"] }))).toBe(
      "A contact can have at most 5 numbers.",
    );
    expect(sideProblem(before, contact({ numbers: [COACH] }))).toBe("+15555550142 is already Coach Lee's number.");
    expect(sideProblem(before, contact({ numbers: ["988"] }))).toBe("988 always works without being a contact, and Belay never records it.");
    expect(sideProblem(before, { ...before, blockedNumbers: ["911"] })).toBe("Belay never blocks 911 or any other emergency number: they always work, in and out, whatever the rules say.");
    expect(sideProblem(before, { ...before, blockedNumbers: [COACH] })).toBe("+15555550142 is Coach Lee's number, a contact: take it off the contact first, then block it.");
    expect(sideProblem(before, { ...before, blockedNumbers: [STRANGER] }, { emergencyCard: [STRANGER] })).toBe("+15555550199 is on the kid's emergency card: take it off the card first, then block it.");
    expect(sideProblem(before, { ...before, privateNumbers: ["988"] })).toBe("Calls and texts with 988 are always private: Belay never records them, so there's no need to add it.");
    expect(sideProblem(before, { ...before, privateNumbers: Array.from({ length: 51 }, (_, i) => `+1555555${String(1000 + i)}`) })).toBe("A phone can have at most 50 private numbers.");
    expect(sideProblem(before, { ...before, blockedNumbers: [STRANGER] })).toBeNull();
  });
});
