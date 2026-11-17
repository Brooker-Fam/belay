/**
 * Phase 5 in the policy: `calls` null until a parent turns calls on (and again once off), the
 * contacts, private and blocked numbers; who may change what (a parent anything; an AI app only
 * what tightens, never on or off, recording or private numbers, and the rest as a proposal a
 * parent approves, with the outdated check); the 911 and 988 refusals; and the phone's problem
 * when Belay isn't its phone app. Made-up names and 555-01xx numbers only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { applyCallsPatch, blockNumber, putContact, removeContact, saveContact, setCalls, setPrivateNumber, unblockNumber } from "../src/family/calls/changes.js";
import { patchOf, sideOf } from "../src/family/calls/patch.js";
import { getDevice } from "../src/family/devices.js";
import { setPhoneParentNumbers } from "../src/family/kidside-changes.js";
import { buildPolicy, type PolicyContext, RuleRefused } from "../src/family/policy.js";
import { approveProposal, changeWords, createProposal, getProposal, outdatedBecause } from "../src/family/proposals.js";
import { digestItems } from "../src/ops/notify.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, signIn, testServer } from "./helpers.js";

const MOM = "+15555550100";
const COACH = "+15555550142";
const STRANGER = "+15555550199";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, ai, policy };
}

describe("the policy's calls", () => {
  it("is null until a parent turns calls on, with the lists always there; null again once off, the rules kept", async () => {
    const { phone, ctx, parent, policy } = await family();
    expect(policy()).toMatchObject({ version: 0, calls: null, contacts: [], private_numbers: [], blocked_numbers: [] });
    // Saving rules while off changes nothing the phone sees about calls, but they're kept.
    setCalls(ctx(), phone.deviceId, { mode: "contacts" }, parent);
    expect(policy().calls).toBeNull();
    const on = setCalls(ctx(), phone.deviceId, { enabled: true, unknown: "reject", quiet: true }, parent);
    expect(on.changed).toBe(true);
    expect(policy().calls).toEqual({ mode: "contacts", unknown: "reject", withheld: "voicemail", outgoing: "any", quiet: true, log: false });
    const off = setCalls(ctx(), phone.deviceId, { enabled: false }, parent);
    expect(policy()).toMatchObject({ version: off.version, calls: null });
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    expect(policy().calls).toMatchObject({ mode: "contacts", unknown: "reject", quiet: true });
  });

  it("turning calls off on a phone that never had them changes nothing", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    const done = setCalls(ctx(), phone.deviceId, { enabled: false }, parent);
    expect(done).toMatchObject({ changed: false, version: 0 });
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM call_settings").get()).toEqual({ n: 0 });
    expect(policy().version).toBe(0);
  });

  it("contacts: names and E.164 numbers, each number one contact's, sent whether calls are on or not, by name", async () => {
    const { phone, ctx, parent, policy } = await family();
    const coach = saveContact(ctx(), phone.deviceId, { name: "Coach Lee", numbers: ["+1 (555) 555-0142"], calls: true, texts: false, parent: false }, parent);
    expect(coach.result).toMatchObject({ added: true, contact: { name: "Coach Lee", numbers: [COACH] } });
    expect(coach.result.contact.id).toMatch(/^c-[A-Za-z0-9_-]{12}$/);
    const mom = saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM, "+15555550101"], calls: true, texts: true, parent: true }, parent);
    expect(policy().contacts).toEqual([
      { id: coach.result.contact.id, name: "Coach Lee", numbers: [COACH], calls: true, texts: false, parent: false },
      { id: mom.result.contact.id, name: "Mom", numbers: [MOM, "+15555550101"], calls: true, texts: true, parent: true },
    ]);
    const refused = (fn: () => unknown) => {
      try {
        fn();
      } catch (error) {
        return error instanceof RuleRefused ? error.message : "not refused";
      }
      return "not refused";
    };
    const add = (name: string, numbers: string[]) => () => saveContact(ctx(), phone.deviceId, { name, numbers, calls: true, texts: true, parent: false }, parent);
    expect(refused(add("Dad", [MOM]))).toBe("+15555550100 is already Mom's number.");
    expect(refused(add("mom", ["+15555550123"]))).toBe("There's already a contact called mom.");
    expect(refused(add("Dad", ["555-0123"]))).toContain("isn't a phone number in international form");
    expect(refused(add("Emergency", ["911"]))).toBe("911 and every emergency number always work without being a contact, and Belay never records them.");
    expect(refused(() => saveContact(ctx(), phone.deviceId, { id: "c-gone", name: "X", numbers: [STRANGER], calls: true, texts: true, parent: false }, parent))).toBe(
      "That contact isn't there any more. Reload the page.",
    );
    // A number can move from one contact to another in one change.
    saveContact(ctx(), phone.deviceId, { id: mom.result.contact.id, name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, parent);
    saveContact(ctx(), phone.deviceId, { name: "Dad", numbers: ["+15555550101"], calls: true, texts: true, parent: true }, parent);
    expect(policy().contacts.map((c) => c.name)).toEqual(["Coach Lee", "Dad", "Mom"]);
    const removed = removeContact(ctx(), phone.deviceId, coach.result.contact.id, parent);
    expect(removed.result.removed?.name).toBe("Coach Lee");
    expect(removeContact(ctx(), phone.deviceId, "c-gone", parent)).toMatchObject({ changed: false, result: { removed: null } });
    expect(policy().contacts.map((c) => c.name)).toEqual(["Dad", "Mom"]);
  });

  it("putContact (the CLI's): the same name again gains the number and the flags given", async () => {
    const { phone, ctx, parent, policy } = await family();
    const first = putContact(ctx(), phone.deviceId, { name: "Mom", number: MOM, parent: true }, parent);
    const again = putContact(ctx(), phone.deviceId, { name: "MOM", number: "+15555550101", texts: false }, parent);
    expect(again.result).toMatchObject({ added: false, contact: { id: first.result.contact.id } });
    expect(policy().contacts).toEqual([{ id: first.result.contact.id, name: "Mom", numbers: [MOM, "+15555550101"], calls: true, texts: false, parent: true }]);
    const same = putContact(ctx(), phone.deviceId, { name: "Mom", number: MOM }, parent);
    expect(same.changed).toBe(false);
  });

  it("blocked numbers: never 911, 988, an emergency number, a contact's number or one on the emergency card", async () => {
    const { phone, ctx, parent, policy } = await family();
    saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, parent);
    setPhoneParentNumbers(ctx(), phone.deviceId, [{ name: "Gran", number: "+15555550123" }], parent);
    const refusal = (number: string) => {
      try {
        blockNumber(ctx(), phone.deviceId, number, parent);
        return "blocked";
      } catch (error) {
        return error instanceof RuleRefused ? error.message : "not refused";
      }
    };
    for (const n of ["911", "+1 911", "112", "999"]) expect(refusal(n), n).toBe("Belay never blocks 911 or any other emergency number: they always work, in and out, whatever the rules say.");
    for (const n of ["988", "+1988", "+18002738255", "1-800-273-8255"]) expect(refusal(n), n).toBe("Belay never blocks 988: the crisis line always works, in and out, whatever the rules say.");
    expect(refusal(MOM)).toBe("+15555550100 is Mom's number, a contact: take it off the contact first, then block it.");
    expect(refusal("+15555550123")).toBe("+15555550123 is on the kid's emergency card: take it off the card first, then block it.");
    expect(refusal("+1 555 555 0199")).toBe("blocked");
    expect(policy().blocked_numbers).toEqual([STRANGER]);
    expect(blockNumber(ctx(), phone.deviceId, STRANGER, parent).changed).toBe(false);
    expect(unblockNumber(ctx(), phone.deviceId, STRANGER, parent).result.was).toBe(true);
    expect(policy().blocked_numbers).toEqual([]);
  });

  it("adding a contact unblocks its number, in the activity log", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    blockNumber(ctx(), phone.deviceId, STRANGER, parent);
    const done = saveContact(ctx(), phone.deviceId, { name: "Neighbor", numbers: [STRANGER], calls: true, texts: true, parent: false }, parent);
    expect(done.result.unblocked).toEqual([STRANGER]);
    expect(policy()).toMatchObject({ blocked_numbers: [], contacts: [{ name: "Neighbor", numbers: [STRANGER] }] });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({
      actor: "parent",
      action: "calls.changed",
      detail: { changes: ['Add "Neighbor" (+15555550199) as a contact, who can call and text', "Unblock +15555550199"], unblocked: [STRANGER] },
    });
  });

  it("private numbers: E.164, never 988 or 911 (always private), at most 50; one made private takes its records with it", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    setCalls(ctx(), phone.deviceId, { enabled: true, log: true }, parent);
    await deviceCall(t, phone.token, "calls", { calls: [{ id: "call-00000001", at: t.now(), direction: "out", number: "+15555550177", duration_s: 60, outcome: "answered" }] });
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM call_records").get()).toEqual({ n: 1 });
    setPrivateNumber(ctx(), phone.deviceId, "+1 555 555 0177", true, parent);
    expect(policy().private_numbers).toEqual(["+15555550177"]);
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM call_records").get()).toEqual({ n: 0 });
    expect(() => setPrivateNumber(ctx(), phone.deviceId, "988", true, parent)).toThrow("Calls and texts with 988 are always private");
    // The activity log says how many, never which: they're private.
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]?.detail).toMatchObject({ changes: ["Never record a private number"] });
    expect(JSON.stringify(listAudit(t.deps.db, { limit: 10, includeReads: false }))).not.toContain("+15555550177");
    expect(setPrivateNumber(ctx(), phone.deviceId, "+15555550177", false, parent).result.was).toBe(true);
    expect(policy().private_numbers).toEqual([]);
  });

  it("each change bumps the version once, and logs as the person who made it", async () => {
    const { t, phone, ctx, policy } = await family();
    const server = { kind: "server" } as const;
    const versions = [
      setCalls(ctx(), phone.deviceId, { enabled: true, mode: "contacts" }, server).version,
      saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, server).version,
      blockNumber(ctx(), phone.deviceId, STRANGER, server).version,
    ];
    expect(versions).toEqual([1, 2, 3]);
    expect(policy().version).toBe(3);
    expect(listAudit(t.deps.db, { limit: 3, includeReads: false }).map((e) => [e.actor, e.action])).toEqual([
      ["server", "calls.changed"],
      ["server", "calls.changed"],
      ["server", "calls.on"],
    ]);
  });
});

describe("who may change calls", () => {
  it("an AI app may only tighten: never turn calls on or off, recording or private numbers, nor loosen", async () => {
    const { phone, ctx, parent, ai, policy } = await family();
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    saveContact(ctx(), phone.deviceId, { name: "Coach Lee", numbers: [COACH], calls: true, texts: true, parent: false }, parent);
    const asAi = ai as unknown as typeof parent;
    expect(() => setCalls(ctx(), phone.deviceId, { enabled: false }, asAi)).toThrow(/Only a parent/);
    expect(() => setCalls(ctx(), phone.deviceId, { log: true }, asAi)).toThrow(/Only a parent/);
    expect(() => setPrivateNumber(ctx(), phone.deviceId, STRANGER, true, asAi)).toThrow(/Only a parent/);
    expect(() => saveContact(ctx(), phone.deviceId, { name: "X", numbers: [STRANGER], calls: true, texts: true, parent: false }, asAi)).toThrow(/Only a parent/);
    expect(() => unblockNumber(ctx(), phone.deviceId, STRANGER, asAi)).toThrow(/Only a parent/);
    // A patch that loosens, or is about collecting, is refused at run time too, whatever the caller says.
    const current = sideOf(ctx().db, phone.deviceId);
    const loosen = patchOf(current, { ...current, rules: { ...current.rules, mode: "open" } });
    expect(() => applyCallsPatch(ctx(), phone.deviceId, loosen, ai)).toThrow(/An AI app can only tighten/);
    const v = policy().version;
    // Tightening applies at once, as the AI app, in the activity log.
    const tighten = patchOf(current, { ...current, rules: { ...current.rules, mode: "contacts", quiet: true }, blockedNumbers: [STRANGER] });
    expect(applyCallsPatch(ctx(), phone.deviceId, tighten, ai).version).toBe(v + 1);
    expect(blockNumber(ctx(), phone.deviceId, "+15555550198", ai).changed).toBe(true);
    expect(policy()).toMatchObject({ calls: { mode: "contacts", quiet: true }, blocked_numbers: ["+15555550198", STRANGER] });
    expect(() => blockNumber(ctx(), phone.deviceId, "988", ai)).toThrow("Belay never blocks 988");
  });

  it("a proposal: approved in the parent's name, or out of date when what it changes changed, with nothing applied", async () => {
    const { t, sam, phone, ctx, parent, policy } = await family();
    setCalls(ctx(), phone.deviceId, { enabled: true, mode: "contacts" }, parent);
    const current = sideOf(t.deps.db, phone.deviceId);
    const gran = { id: "c-gran-000001", name: "Grandma", numbers: ["+15555550123"], calls: true, texts: true, parent: false };
    const patch = patchOf(current, { ...current, rules: { ...current.rules, unknown: "ring" }, contacts: [gran] });
    const made = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "calls", patch }, "Grandma got a new phone", { parentId: sam.parent.id, clientName: "Claude" });
    expect(changeWords(made.proposal.change, null)).toEqual({
      title: "Change calls: callers who aren't contacts ring (they go to voicemail now) (and 1 more change)",
      gerund: "changing calls: callers who aren't contacts ring (they go to voicemail now) (and 1 more change)",
    });
    expect(getProposal(t.deps.db, made.proposal.id)?.change).toEqual({ kind: "calls", patch });
    const v = policy().version;
    expect(approveProposal(ctx(), made.proposal.id, sam.parent.id)).toMatchObject({ ok: true });
    expect(policy()).toMatchObject({ version: v + 1, calls: { unknown: "ring" }, contacts: [{ id: "c-gran-000001", name: "Grandma" }] });
    expect(listAudit(t.deps.db, { limit: 2, includeReads: false }).map((e) => [e.actor, e.action, e.detail?.proposal])).toEqual([
      ["parent", "proposal.approved", undefined],
      ["parent", "calls.changed", made.proposal.id],
    ]);

    // Out of date: a parent changed the rule it changes since.
    const later = sideOf(t.deps.db, phone.deviceId);
    const second = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "calls", patch: patchOf(later, { ...later, rules: { ...later.rules, outgoing: "any", withheld: "ring" } }) }, "x", {
      parentId: sam.parent.id,
      clientName: "Claude",
    });
    setCalls(ctx(), phone.deviceId, { withheld: "reject" }, parent);
    expect(outdatedBecause(t.deps.db, getProposal(t.deps.db, second.proposal.id)!, t.now())).toBe("The phone's call rules changed after this was proposed.");
    const before = policy();
    expect(approveProposal(ctx(), second.proposal.id, sam.parent.id)).toMatchObject({ ok: false, outdated: true });
    expect(policy()).toEqual(before);
  });

  it("a proposal that changes nothing now isn't one to approve", async () => {
    const { t, sam, phone, ctx, parent } = await family();
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    const current = sideOf(t.deps.db, phone.deviceId);
    const patch = patchOf(current, { ...current, rules: { ...current.rules, quiet: true } });
    const made = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "calls", patch }, "x", { parentId: sam.parent.id, clientName: "Claude" });
    setCalls(ctx(), phone.deviceId, { quiet: true }, parent);
    expect(outdatedBecause(t.deps.db, getProposal(t.deps.db, made.proposal.id)!, t.now())).toBe("The phone's calls are already like that.");
  });
});

describe("when Belay isn't the phone app", () => {
  it("with calls on: the server's own words, and the phone's kept apart; in the daily summary too", async () => {
    const { t, phone, ctx, parent } = await family();
    const report = (calls: { dialer: boolean; problem?: string } | null) =>
      deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 0, ...(calls ? { calls } : {}) } }) });
    await report({ dialer: false, problem: "Calls are going through the phone's own app" });
    // Calls off: the phone's report about calls means nothing.
    const view = () => getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now());
    expect(view()?.problems.map((p) => p.code)).not.toContain("calls_not_dialer");
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    expect(view()?.problems).toEqual(
      expect.arrayContaining([
        {
          code: "calls_not_dialer",
          text: "Calls are going through the phone's own app, so Belay can't decide who rings or keep a record of calls. Calls, 911 and 988 still work",
        },
        { code: "phone_reported", text: "Belay on the phone says: Calls are going through the phone's own app", fromPhone: "Calls are going through the phone's own app" },
      ]),
    );
    const phones = [view()!];
    expect(digestItems({ phones, requests: 0, proposals: 0, server: [], now: t.now() })).toContain("calls are going through the phone's own app on a phone");
    await report({ dialer: true });
    expect(view()?.problems.map((p) => p.code)).not.toContain("calls_not_dialer");
  });
});
