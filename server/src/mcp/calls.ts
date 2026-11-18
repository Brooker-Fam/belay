/**
 * Phase 5 over MCP (docs/design/phase5-calls-texts.md, "MCP"): get_contacts, the call rules and
 * the contacts, always (names under `untrusted`; other people's numbers only with the `calls`
 * scope); get_calls, the call records, under the `calls` scope, which is off for every family until
 * a parent turns it on; and change_calls, which applies a change only when every part of it
 * tightens, and otherwise records a proposal a parent approves. No tool turns calls on or off,
 * changes whether they're recorded or the private numbers, or answers the kid's contact request:
 * those are a parent's. Every call is in the activity log, and so is each change refused (once an
 * hour per reason).
 *
 * With the scope off, nothing here says anything about a number: change_calls takes none (its
 * answer about a guessed number would say whose it is: a contact's, on the emergency card, blocked),
 * and the proposals waiting name no number or contact.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { e164, ruleId } from "../device/schemas.js";
import { type CallsOps, applyCallsPatch, applyOps } from "../family/calls/changes.js";
import { classifyCallsChange } from "../family/calls/classify.js";
import { CALL_LIMITS } from "../family/calls/numbers.js";
import { patchOf, settle, sideOf, sideProblem } from "../family/calls/patch.js";
import { listCallRecords } from "../family/calls/records.js";
import { callSettings, listContacts, listNumbers, proposedContactId } from "../family/calls/store.js";
import { OUTCOME_WORDS, REASON_WORDS, callChangeSentence, callsSummary, rulesInWords } from "../family/calls/words.js";
import { type DeviceRow, findDeviceByName, listDevices } from "../family/devices.js";
import { parentNumbersFor } from "../family/kidside.js";
import { type Changer, type PolicyContext, RuleRefused } from "../family/policy.js";
import { MAX_PENDING_PROPOSALS, changeWords, createProposal, listProposals } from "../family/proposals.js";
import { recentRequests } from "../family/requests.js";
import { notifyParents, proposalNotice } from "../push.js";
import { AI_SCOPES, getSettings } from "../settings.js";
import { durations, formatDuration, isoInZone, parseWhen } from "../time.js";
import { type RefusedWhy, aiRefused } from "./limits.js";
import type { Caller } from "./server.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const TIGHTEN = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const deviceParam = z.string().min(1).max(100).describe("The phone's name, as list_devices shows it");
const action = z.enum(["reject", "voicemail", "ring"]);
/** The most days get_calls reads at once. */
const MAX_DAYS = 92;

export const ALWAYS = "911, 988 and every emergency number always work, in and out, in Belay's own code on the phone, whatever these rules say, and Belay never records them.";

/** The Calls category's name in Settings. */
const CALLS = AI_SCOPES.calls.split(":")[0] ?? "Calls";

/**
 * change_calls' one answer to a change that names a number while the Calls category is off: the
 * same whatever the number, since anything else (whose it is, on the emergency card, blocked or
 * not) would tell an AI app what a parent keeps from it.
 */
const NUMBERS_OFF = `Not done: a parent turned off AI access to calls in Belay's settings (it starts off), so change_calls takes no phone numbers: none to block or unblock, and no contact's numbers. You can still change the call rules, and change or remove contacts by id without their numbers. A parent can block a number or add a contact on the phone's Calls tab, or tick "${CALLS}" in Settings to let AI apps see calls.`;

export function registerCallsTools(server: McpServer, deps: Deps, caller: Caller): void {
  const { db } = deps;
  const ai: Changer = { kind: "ai", parentId: caller.parentId, clientName: caller.clientName };
  const ctx = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });
  const tz = () => getSettings(db).timezone;
  const iso = (ms: number | null | undefined) => (ms == null ? null : isoInZone(ms, tz()));
  const scopeOn = () => getSettings(db).aiScopes.calls;
  const scopeOff = (): CallToolResult | null =>
    scopeOn()
      ? null
      : refusal(
          `A parent turned off AI access to calls in Belay's settings (it starts off), so this isn't available. You can still see a phone's call rules and contacts' names, with get_contacts. To change it, a parent ticks "${CALLS}" in Settings.`,
        );
  const logRead = (what: string, deviceId: string) => {
    audit(db, deps.now(), ai, "ai.read", { deviceId, detail: { what } });
  };
  const phone = (name: string): DeviceRow | CallToolResult => {
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), deps.now()).map((d) => d.name);
    return refusal(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };
  const isRefusal = (v: DeviceRow | CallToolResult): v is CallToolResult => "content" in v;
  const parentsPage = (path: string) => `${deps.config.publicUrl}${path}`;

  // ── get_contacts ───────────────────────────────────────────────────

  server.registerTool(
    "get_contacts",
    {
      title: "A phone's call rules and contacts",
      description:
        "One phone's calls: whether Belay is its phone app (calls on or off), who may call the kid and whom the kid may call, quiet times, whether calls are recorded, the approved contacts (with ids, for change_calls: each one's name, whether they may call or text, and whether they're a parent, who always rings and is on the kid's emergency card), the blocked numbers, how many private numbers there are, and changes AI apps proposed that wait for a parent. Contacts' and blocked numbers need the Calls category. 911, 988 and emergency numbers always work, whatever the rules.",
      inputSchema: { device: deviceParam },
      annotations: READ,
    },
    ({ device }) => {
      const row = phone(device);
      if (isRefusal(row)) return row;
      const s = callSettings(db, row.id);
      const numbers = scopeOn();
      logRead("the phone's call rules and contacts", row.id);
      const contacts = listContacts(db, row.id);
      const blocked = listNumbers(db, row.id, "blocked");
      const requests = getSettings(db).aiScopes.requests ? recentRequests(db, deps.now(), { deviceId: row.id, kind: "contact", status: "pending" }).length : null;
      const card = parentNumbersFor(db, row.id);
      return result({
        phone: row.name,
        calls: callsSummary(s),
        ...(s?.enabled ? { rules: rulesInWords(s) } : { rules: "Calls are off: Belay isn't the phone app on this phone, so it doesn't decide who rings. Only a parent turns calls on, on the phone's Calls tab." }),
        always: ALWAYS,
        contacts: contacts.map((c) => ({
          id: c.id,
          can_call: c.calls,
          can_text: c.texts,
          ...(c.parent ? { parent: "always rings, even at quiet times, and is on the kid's emergency card" } : {}),
          ...(numbers ? {} : { numbers: c.numbers.length }),
          untrusted: { name: c.name, ...(numbers ? { numbers: c.numbers } : {}) },
        })),
        ...(numbers
          ? {}
          : {
              note: "Contacts' numbers and blocked numbers are hidden: a parent turned off AI access to calls (it starts off). So are the numbers and contacts in proposals waiting, and change_calls takes no numbers.",
            }),
        blocked_numbers: numbers ? blocked.map((b) => ({ number: b.number, blocked: iso(b.addedAt), by: b.clientName ? `${b.clientName}, through ${b.addedBy ?? "a parent"}'s connection` : (b.addedBy ?? "the server's admin command") })) : blocked.length,
        private_numbers: `${listNumbers(db, row.id, "private").length} (Belay never records them; only a parent sees which)`,
        ...(card.length ? { emergency_card: `${card.length} number${card.length === 1 ? "" : "s"} from the family's emergency card, besides the parent contacts` } : {}),
        ...(requests !== null ? { contact_requests_waiting: requests } : {}),
        proposals_waiting: listProposals(db, { deviceId: row.id, status: "pending" })
          .filter((p) => p.change.kind === "calls")
          .map((p) => ({ proposed: iso(p.createdAt), by: p.clientName, untrusted: { change: changeWords(p.change, p.label, undefined, { numbers }).title } })),
        how_to_change: `change_calls applies a change at once only when it only tightens; anything else becomes a proposal a parent approves on the parent page (${parentsPage("/proposals")}). Only a parent turns calls on or off, decides whether they're recorded, or which numbers are private, and only a parent answers the kid's contact requests.`,
      });
    },
  );

  // ── get_calls ──────────────────────────────────────────────────────

  server.registerTool(
    "get_calls",
    {
      title: "Calls",
      description:
        "A phone's calls, newest first: when, incoming or outgoing, what happened (answered, missed, refused, voicemail, or not placed because Belay didn't allow it) and why, how long, and the contact (or the number, for someone who isn't one). Never what was said, and never calls with 911, 988, an emergency number or a private number: Belay doesn't record those. Only while the phone records calls. Times may be a date (2026-11-10, midnight in the family's timezone) or a date and time; the last 7 days by default, at most 92. Needs the Calls category, which is off until a parent turns it on.",
      inputSchema: {
        device: deviceParam,
        from: z.string().max(40).optional().describe("Start, like 2026-11-10 or 2026-11-10T15:00. Default: 7 days ago."),
        to: z.string().max(40).optional().describe("End (exclusive). Default: now."),
      },
      annotations: READ,
    },
    ({ device, from, to }) => {
      const off = scopeOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      const zone = tz();
      const now = deps.now();
      const start = from ? parseWhen(from, zone) : now - 7 * durations.DAY;
      const end = to ? parseWhen(to, zone) : now;
      if (start === null) return refusal("from must be a date like 2026-11-10 or a date and time like 2026-11-10T15:00.");
      if (end === null) return refusal("to must be a date like 2026-11-10 or a date and time like 2026-11-10T15:00.");
      if (end <= start) return refusal("to must be after from.");
      if (end - start > MAX_DAYS * durations.DAY) return refusal(`Ask for at most ${MAX_DAYS} days at a time.`);
      const s = callSettings(db, row.id);
      const records = listCallRecords(db, row.id, { from: start, to: end, limit: 500 });
      const names = new Map(listContacts(db, row.id).map((c) => [c.id, c.name]));
      logRead(`calls from ${iso(start) ?? ""} to ${iso(end) ?? ""}`, row.id);
      return result({
        phone: row.name,
        from: iso(start),
        to: iso(end),
        calls: callsSummary(s),
        records: records.map((r) => ({
          when: iso(r.at),
          direction: r.direction === "in" ? "incoming" : "outgoing",
          outcome: OUTCOME_WORDS[r.outcome],
          ...(r.reason ? { why: REASON_WORDS[r.reason] } : {}),
          ...(r.durationS > 0 ? { duration: formatDuration(r.durationS * 1000) } : {}),
          ...(r.contactId !== null
            ? { who: names.has(r.contactId) ? "a contact" : "a contact who has been removed since", untrusted: { contact: names.get(r.contactId) ?? r.contactName ?? "" } }
            : r.number !== null
              ? { who: "someone who isn't a contact", number: r.number }
              : { who: "no caller ID" }),
        })),
        ...(records.length === 0 ? { note: s?.enabled && s.log ? "No calls in that time." : "The phone records calls only while a parent has turned that on; then calls show here." } : {}),
        reminder: "A call is a fact, not a verdict about the kid: report it plainly, and don't guess who someone is or why they called. Other people's numbers are private: share them only with the parent who asked.",
      });
    },
  );

  // ── change_calls ───────────────────────────────────────────────────

  const contactInput = z.strictObject({
    name: z.string().min(1).max(CALL_LIMITS.contactName).describe("The family's name for them, like Grandma: the kid sees it"),
    numbers: z.array(e164).min(1).max(CALL_LIMITS.numbersPerContact).describe("E.164, like +15555550100"),
    calls: z.boolean().optional().describe("May call and be called. Default true."),
    texts: z.boolean().optional().describe("May text. Default true."),
    parent: z.boolean().optional().describe("A parent: always rings, and on the kid's emergency card. Default false."),
  });
  const contactChange = z.strictObject({
    id: ruleId.describe("The contact's id, as get_contacts shows it"),
    name: z.string().min(1).max(CALL_LIMITS.contactName).optional(),
    numbers: z.array(e164).min(1).max(CALL_LIMITS.numbersPerContact).optional().describe("The whole list"),
    calls: z.boolean().optional(),
    texts: z.boolean().optional(),
    parent: z.boolean().optional(),
  });

  server.registerTool(
    "change_calls",
    {
      title: "Change calls",
      description:
        "Changes who may call the kid and whom the kid may call, on a phone whose calls are on: only contacts or anyone (mode), what happens to callers who aren't contacts (unknown) or have no caller ID (withheld): ring, voicemail or reject; whom the kid can call (outgoing: contacts or any); quiet times (quiet: only parents ring at bedtime and school times); add, change or remove contacts (by id from get_contacts); block or unblock numbers. The server decides: a change that only tightens (only contacts, a stricter rule for unknown or withheld callers, outgoing to contacts only, quiet on, fewer contacts allowed to call, blocking a number) applies at once, within seconds when the phone is online; use it only when the parent asks. Anything else, or a mix, or anything that takes from a parent contact, becomes a proposal a parent approves or rejects on the parent page: then say it's waiting for them, never that it's done. Turning calls on or off, recording them and private numbers are a parent's alone. 911, 988 and emergency numbers can't be blocked: they always work. With the Calls category off (it starts off), it takes no phone numbers: blocking, unblocking and a contact's numbers need that category; the rules, and contacts by id without their numbers, don't. A change it refuses is in the activity log.",
      inputSchema: {
        device: deviceParam,
        change: z
          .strictObject({
            mode: z.enum(["open", "contacts"]).optional().describe("open: anyone can call; contacts: only contacts who may call"),
            unknown: action.optional().describe("With only contacts: callers who aren't contacts"),
            withheld: action.optional().describe("Callers with no caller ID"),
            outgoing: z.enum(["contacts", "any"]).optional().describe("Whom the kid can call: only contacts, or any number"),
            quiet: z.boolean().optional().describe("At bedtime and school times, only parents (and emergency numbers) ring"),
            add_contacts: z.array(contactInput).max(50).optional().describe("Needs the Calls category: their numbers"),
            change_contacts: z.array(contactChange).max(50).optional().describe("A contact's numbers need the Calls category"),
            remove_contacts: z.array(ruleId).max(50).optional().describe("Ids of contacts to remove"),
            block_numbers: z.array(z.string().min(1).max(40)).max(50).optional().describe("Numbers to block, E.164; needs the Calls category"),
            unblock_numbers: z.array(z.string().min(1).max(40)).max(50).optional().describe("Numbers to unblock; needs the Calls category"),
            on: z.boolean().optional().describe("Not yours to change: only a parent turns calls on or off"),
            log: z.boolean().optional().describe("Not yours to change: only a parent decides whether calls are recorded"),
            private_numbers: z.array(z.string().max(40)).max(50).optional().describe("Not yours to change: only a parent chooses private numbers"),
          })
          .describe("What to change"),
        reason: z.string().min(1).max(1000).describe("Why, in a sentence or two, for the parent"),
      },
      annotations: { ...TIGHTEN, idempotentHint: false },
    },
    ({ device, change, reason }) => {
      const row = phone(device);
      if (isRefusal(row)) return row;
      // What the server refuses is in the activity log, once an hour per reason: a parent sees what an AI app tried.
      const refused = (why: RefusedWhy, text: string): CallToolResult => {
        aiRefused(deps, caller, "change_calls", row.id, why);
        return refusal(text);
      };
      if (row.revoked_at !== null) return refused("other", `${row.name} is disconnected, so Belay can't change anything on it.`);
      if (change.on !== undefined || change.log !== undefined || change.private_numbers !== undefined) {
        return refused("parents_only", "Only a parent turns calls on or off, decides whether calls are recorded, or which numbers are private, on the phone's Calls tab: you can't, and can't propose it.");
      }
      // Before anything looks at a number: the answer is the same whatever it is.
      const namesNumbers = !!(change.block_numbers?.length || change.unblock_numbers?.length || change.add_contacts?.length || change.change_contacts?.some((c) => c.numbers !== undefined));
      if (namesNumbers && !scopeOn()) return refused("numbers", NUMBERS_OFF);
      const s = callSettings(db, row.id);
      if (!s?.enabled) {
        return refused(
          "other",
          `Calls are off for ${row.name}: Belay isn't its phone app, so it doesn't decide who rings or block numbers. Only a parent turns calls on, on the phone's Calls tab; you can't, and can't propose it.`,
        );
      }
      const now = deps.now();
      const current = sideOf(db, row.id);
      const ops: CallsOps = change;
      const wanted = applyOps(current, ops, (contact) => proposedContactId(row.id, contact.name, contact.numbers));
      if ("problem" in wanted) return refused("other", wanted.problem);
      const { side } = settle(current, wanted.side);
      const problem = sideProblem(current, side, { emergencyCard: parentNumbersFor(db, row.id).map((p) => p.number) });
      if (problem) return refused("other", `Nothing changed. ${problem}`);
      const classification = classifyCallsChange(current, side);
      const patch = patchOf(current, side);
      if (classification.none) return refusal(`Nothing to change: ${row.name}'s calls are already like that.`);
      const changes = classification.changes.map((c) => ({ effect: c.effect, untrusted: { change: callChangeSentence(c) } }));
      if (classification.onlyTightens) {
        try {
          const done = applyCallsPatch(ctx(), row.id, patch, ai);
          return result({
            phone: row.name,
            status: "done: it only tightens, so it applies at once",
            changes,
            version: done.version,
            what_happens: "The phone gets it within seconds if it's online, or as soon as it's back online.",
            always: ALWAYS,
            reminder: "Only a parent can loosen it again, on the parent page. To suggest that, use change_calls: it becomes a proposal.",
          });
        } catch (error) {
          if (error instanceof RuleRefused) return refused("other", error.message);
          throw error;
        }
      }
      if (listProposals(db, { deviceId: row.id, status: "pending", limit: MAX_PENDING_PROPOSALS }).length >= MAX_PENDING_PROPOSALS) {
        return refused("other", `${MAX_PENDING_PROPOSALS} proposals for ${row.name} are already waiting. Ask the parent to look at them on the Proposals page first.`);
      }
      const made = createProposal(db, now, row.id, { kind: "calls", patch }, reason, { parentId: caller.parentId, clientName: caller.clientName });
      const words = changeWords(made.proposal.change, null);
      if (!made.duplicate && deps.limits.noticesPerPhone.hit(row.id).ok) notifyParents(deps, proposalNotice(row.name, caller.clientName, words.gerund));
      return result({
        phone: row.name,
        status: "proposed: waiting for a parent to approve or reject it",
        why:
          classification.effect === "loosens"
            ? "Part of it loosens who may call the kid or whom they may call, so a parent decides."
            : "It doesn't only tighten the rules (a new name, or something about a parent contact), so a parent decides.",
        changes,
        ...(made.duplicate ? { note: "The same change was already proposed, and is still waiting." } : {}),
        where: parentsPage("/proposals"),
        reminder: "Nothing has changed yet. Tell the parent it's waiting for them on the Proposals page; don't say it's done.",
      });
    },
  );
}
