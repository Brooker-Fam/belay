/**
 * The CLI's Phase 5 commands, in the exact shapes CI's emulator test reads: calls (on with its
 * rules, or --off), contact (prints only the id; --remove <id>), block-number, unblock-number,
 * private-number (and --remove), answer for a contact request, and status --json's calls,
 * contacts, private_numbers, blocked_numbers and call_records. Each acts as a person (the
 * server), in the activity log, and bumps the policy. Made-up names and 555-01xx numbers only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, testServer, T0, type TestServer } from "./helpers.js";

const MOM = "+15555550100";
const COACH = "+15555550142";
const STRANGER = "+15555550199";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const phone = await enrollPhone(t, "CI phone");
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, phone, policy };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(""),
    interactive: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const status = async (t: TestServer) => (JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, any>[] }).phones[0] ?? {};

describe("the CLI's calls commands", () => {
  it('calls "<phone>" --mode … [--unknown] [--withheld] [--outgoing] [--quiet] [--log]: turns calls on with these rules', async () => {
    const { t, policy } = await family();
    const on = await cli(t, "calls", "CI phone", "--mode", "contacts", "--unknown", "reject", "--withheld", "voicemail", "--outgoing", "contacts", "--quiet", "on", "--log", "on");
    expect(on.code).toBe(0);
    expect(on.out).toBe("CI phone: calls are on: only contacts can call, the kid can call only contacts, quiet at bedtime and school times, calls recorded (rules version 1).");
    expect(policy()).toMatchObject({ version: 1, calls: { mode: "contacts", unknown: "reject", withheld: "voicemail", outgoing: "contacts", quiet: true, log: true } });
    // Once on, one rule can change alone.
    expect((await cli(t, "calls", "CI phone", "--log", "off")).out).toBe("CI phone: calls are on: only contacts can call, the kid can call only contacts, quiet at bedtime and school times, no record of calls (rules version 2).");
    expect(listAudit(t.deps.db, { limit: 2, includeReads: false }).map((e) => [e.actor, e.action])).toEqual([
      ["server", "calls.changed"],
      ["server", "calls.on"],
    ]);
    for (const bad of [
      ["calls", "CI phone", "--mode", "everyone"],
      ["calls", "CI phone", "--unknown", "maybe"],
      ["calls", "CI phone", "--outgoing", "some"],
      ["calls", "CI phone", "--quiet", "yes"],
      ["calls", "CI phone", "--log"],
      ["calls", "CI phone", "--colour", "red"],
      ["calls", "CI phone", "--off", "--mode", "open"],
      ["calls", "CI phone"],
      ["calls", "No phone", "--mode", "open"],
    ]) {
      const res = await cli(t, ...bad);
      expect(res.code, bad.join(" ")).toBe(1);
      expect(res.out, bad.join(" ")).toBe("");
    }
    expect(policy().version).toBe(2);
  });

  it('calls "<phone>" --off; turning on needs --mode', async () => {
    const { t, policy } = await family();
    const needs = await cli(t, "calls", "CI phone", "--log", "on");
    expect(needs.code).toBe(1);
    expect(needs.err).toContain("Turning calls on needs --mode.");
    expect((await cli(t, "calls", "CI phone", "--off")).out).toBe("CI phone: calls were already off.");
    await cli(t, "calls", "CI phone", "--mode", "open");
    expect(policy().calls).toEqual({ mode: "open", unknown: "voicemail", withheld: "voicemail", outgoing: "any", quiet: false, log: false });
    expect((await cli(t, "calls", "CI phone", "--off")).out).toBe("CI phone: calls are off: Belay isn't the phone app, so it leaves calls alone (rules version 2).");
    expect(policy().calls).toBeNull();
  });

  it("warns when an emergency-card number isn't a contact under contacts only", async () => {
    const { t } = await family();
    await cli(t, "parent-number", "CI phone", "--name", "Mom", "--number", MOM);
    const res = await cli(t, "calls", "CI phone", "--mode", "contacts");
    expect(res.code).toBe(0);
    expect(res.err).toBe("On the emergency card but not a contact: Mom (+15555550100). With only contacts, their calls follow --unknown. Add them with contact --parent.");
    await cli(t, "contact", "CI phone", "--name", "Mom", "--number", MOM, "--parent");
    expect((await cli(t, "calls", "CI phone", "--quiet", "on")).err).toBe("");
  });

  it('contact "<phone>" --name --number [--calls] [--texts] [--parent] prints only the id; the same name again gains the number; --remove <id> prints the id', async () => {
    const { t, policy } = await family();
    const mom = await cli(t, "contact", "CI phone", "--name", "Mom", "--number", MOM, "--parent");
    expect(mom.code).toBe(0);
    expect(mom.out).toMatch(/^c-[A-Za-z0-9_-]{12}$/);
    expect(mom.err).toBe("CI phone: Mom (+15555550100) can call and text, as a parent (rules version 1).");
    const coach = await cli(t, "contact", "CI phone", "--name", "Coach Lee", "--number", COACH, "--calls", "on", "--texts", "off");
    expect(coach.err).toBe("CI phone: Coach Lee (+15555550142) can call, not text (rules version 2).");
    const again = await cli(t, "contact", "CI phone", "--name", "coach lee", "--number", "+15555550143");
    expect(again.out).toBe(coach.out);
    expect(policy().contacts).toEqual([
      { id: coach.out, name: "Coach Lee", numbers: [COACH, "+15555550143"], calls: true, texts: false, parent: false },
      { id: mom.out, name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true },
    ]);
    for (const bad of [
      ["contact", "CI phone", "--name", "Dad"],
      ["contact", "CI phone", "--number", STRANGER],
      ["contact", "CI phone", "--name", "Dad", "--number", "555-0199"],
      ["contact", "CI phone", "--name", "Dad", "--number", "911"],
      ["contact", "CI phone", "--name", "Dad", "--number", MOM],
      ["contact", "CI phone", "--name", "Dad", "--number", STRANGER, "--calls", "yes"],
      ["contact", "CI phone", "--remove", "c-nobody"],
      ["contact", "CI phone", "--remove"],
    ]) {
      const res = await cli(t, ...bad);
      expect(res.code, bad.join(" ")).toBe(1);
      expect(res.out, bad.join(" ")).toBe("");
    }
    const removed = await cli(t, "contact", "CI phone", "--remove", coach.out);
    expect(removed.out).toBe(coach.out);
    expect(removed.err).toBe("CI phone: Coach Lee isn't a contact any more (rules version 4).");
    expect(policy().contacts.map((c) => c.name)).toEqual(["Mom"]);
  });

  it('block-number and unblock-number "<phone>" <E.164>: never 911, 988 or a contact\'s number', async () => {
    const { t, policy } = await family();
    const off = await cli(t, "block-number", "CI phone", STRANGER);
    expect(off.out).toBe("CI phone: +15555550199 is blocked (rules version 1).");
    expect(off.err).toBe("Calls are off on this phone: Belay blocks it once calls are on.");
    expect((await cli(t, "block-number", "CI phone", STRANGER)).out).toBe("CI phone: +15555550199 was blocked already.");
    expect(policy().blocked_numbers).toEqual([STRANGER]);
    await cli(t, "contact", "CI phone", "--name", "Mom", "--number", MOM);
    const refused: [string, string][] = [
      ["911", "Belay never blocks 911 or any other emergency number"],
      ["988", "Belay never blocks 988"],
      ["+1 988", "Belay never blocks 988"],
      [MOM, "is Mom's number, a contact"],
      ["", "Usage: block-number"],
    ];
    for (const [n, words] of refused) {
      const res = await cli(t, "block-number", "CI phone", n);
      expect(res.code, n).toBe(1);
      expect(res.err, n).toContain(words);
    }
    expect((await cli(t, "unblock-number", "CI phone", STRANGER)).out).toBe("CI phone: +15555550199 is unblocked (rules version 3).");
    expect((await cli(t, "unblock-number", "CI phone", STRANGER)).out).toBe("CI phone: +15555550199 wasn't blocked.");
    expect(policy().blocked_numbers).toEqual([]);
  });

  it('private-number "<phone>" <E.164>, and --remove <E.164>', async () => {
    const { t, policy } = await family();
    expect((await cli(t, "private-number", "CI phone", "+15555550177")).out).toBe("CI phone: Belay never records calls with +15555550177 (rules version 1).");
    expect(policy().private_numbers).toEqual(["+15555550177"]);
    expect((await cli(t, "private-number", "CI phone", "988")).code).toBe(1);
    expect((await cli(t, "private-number", "CI phone", "--remove")).code).toBe(1);
    expect((await cli(t, "private-number", "CI phone", "--remove", "+15555550177")).out).toBe("CI phone: +15555550177 isn't a private number any more (rules version 2).");
    expect(policy().private_numbers).toEqual([]);
  });

  it('answer "<phone>" <id> approve for a contact request adds the contact, with --name, --calls and --texts', async () => {
    const { t, phone, policy } = await family();
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "contact", contact_name: "Coach", contact_number: COACH, asked_at: t.now() }] });
    const res = await cli(t, "answer", "CI phone", "request-0001", "approve", "--name", "Coach Lee", "--texts", "off");
    expect(res.out).toBe("CI phone: request request-0001 is approved: Coach Lee is a contact now (rules version 1).");
    expect(policy().contacts).toMatchObject([{ name: "Coach Lee", numbers: [COACH], calls: true, texts: false }]);
    expect((await cli(t, "answer", "CI phone", "request-0001", "approve", "--calls", "maybe")).code).toBe(1);
  });

  it("status --json gains calls, contacts, private_numbers, blocked_numbers and call_records (newest first, at most 50)", async () => {
    const { t, phone } = await family();
    expect(await status(t)).toMatchObject({ calls: null, contacts: [], private_numbers: [], blocked_numbers: [], call_records: [] });
    await cli(t, "calls", "CI phone", "--mode", "contacts", "--log", "on");
    const mom = (await cli(t, "contact", "CI phone", "--name", "Mom", "--number", MOM, "--parent")).out;
    await cli(t, "block-number", "CI phone", STRANGER);
    await deviceCall(t, phone.token, "calls", {
      calls: [
        ...Array.from({ length: 55 }, (_, i) => ({ id: `call-${String(i).padStart(8, "0")}`, at: T0 - (i + 10) * 60_000, direction: "in", number: STRANGER, duration_s: 0, outcome: "rejected", reason: "unknown" })),
        { id: "call-newest01", at: T0, direction: "out", contact_id: mom, duration_s: 42, outcome: "answered" },
      ],
    });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "contact", contact_name: "Coach", contact_number: COACH, asked_at: t.now() }] });
    const s = await status(t);
    expect(s.calls).toEqual({ mode: "contacts", unknown: "voicemail", withheld: "voicemail", outgoing: "any", quiet: false, log: true });
    expect(s.contacts).toEqual([{ id: mom, name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }]);
    expect(s.blocked_numbers).toEqual([STRANGER]);
    expect(s.private_numbers).toEqual([]);
    expect(s.call_records).toHaveLength(50);
    expect(s.call_records[0]).toEqual({ id: "call-newest01", at: T0, direction: "out", contact_id: mom, number: null, duration_s: 42, outcome: "answered", reason: null });
    expect(s.call_records[1]).toEqual({ id: "call-00000000", at: T0 - 600_000, direction: "in", contact_id: null, number: STRANGER, duration_s: 0, outcome: "rejected", reason: "unknown" });
    expect(s.requests).toEqual([expect.objectContaining({ id: "request-0001", kind: "contact", status: "pending", contact_name: "Coach", contact_number: COACH, contact_id: null })]);
    const text = (await cli(t, "status")).out;
    expect(text).toContain("  calls: on: only contacts can call, the kid can call any number, calls recorded; 1 contact, 1 blocked");
  });
});
