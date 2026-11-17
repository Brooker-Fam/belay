/**
 * The admin commands behind cli.ts, run where the server runs (same BELAY_DATA_DIR):
 *
 *   setup-link                                    a one-time link to create the first parent
 *   create-code <phone name>                      an enrollment code for a phone
 *   reset-password <username>                     a new password, read from the terminal
 *   backup <file> [--encrypt]                     a consistent copy of the database, while it runs (ops/cli.ts)
 *   verify-backup <file>                          proves a backup restores: checks a private copy, counts what's in it
 *   restore [--drill] <file>                      a checked backup into a data dir without a database (cli.ts runs it)
 *   restore-drill                                 the steps of a restore drill, for the newest backup
 *   status [--json]                               each phone's status, apps, rules, requests and latest changes
 *   protect "<phone>"                             turns protection on, as the parent page does
 *   policy "<phone>" --new-apps ask|allow [--allow-waiting] [--hold-new]
 *                                                 whether new apps wait for a parent (the flags: see docs/server.md)
 *   decide "<phone>" <package> allow|block|undecided
 *   pause "<phone>" [--minutes N] [--note text]   until a parent resumes it, without --minutes
 *   resume "<phone>"
 *   agent-add <apk> --version-code <n> [--version-name <name>]
 *                                                 stores a version of Belay; prints only its SHA-256
 *   agent-offer "<phone>" <sha256>                offers that version to the phone, as a parent would
 *   recovery-key "<phone>"                        a new recovery key for the phone; prints only the key, grouped
 *   remove-other-users "<phone>"                  asks the phone to remove every other user and profile (Phase 10)
 *   limit "<phone>" <package|*> --minutes <n> [--name <words>]
 *                                                 that phone's daily limit for the app (* : the daily total); prints only its id
 *   limit "<phone>" <package|*> --remove          removes it; prints only its id
 *   schedule "<phone>" --name <words> --start HH:MM --end HH:MM [--days mon,tue,...] [--lock] [--allow p1,p2]
 *                                                 a custom schedule, in the phone's time; prints only its id
 *   schedule "<phone>" --remove <id>
 *   lock-now "<phone>" [--minutes <n>]            locks the screen once, if the phone gets it within n minutes (10); prints only the command's id
 *   screen-time "<phone>" --measure on|off        whether the phone sends how long apps are used (Phase 3)
 *   answer "<phone>" <request id> approve|decline|talk [--minutes <n>] [--note <words>]
 *                                                 answers the kid's request; approving more time needs --minutes
 *   location "<phone>" --mode off|on_demand|periodic [--every <minutes>] [--hours HH:MM-HH:MM|all] [--provider gps|fused]
 *            [--keep-on on|off] [--fallback on|off]
 *                                                 whether and how the phone shares where it is (Phase 4)
 *   place "<phone>" --name <words> --lat <x> --lng <y> --radius <m> [--notify arrive,leave]
 *                                                 a place (the same name again changes it); prints only its id
 *   place "<phone>" --remove <id>                 removes it; prints only its id
 *   locate-now "<phone>"                          a check of where the phone is now; prints only the command's id, and doesn't wait
 *   lost "<phone>" --message <words> [--number <n>], or lost "<phone>" --off
 *                                                 lost mode: the words (and number) on the lock screen
 *   help-seen "<phone>" <request id> [--note <words>]
 *                                                 marks the kid's help request seen (Phase 7)
 *   parent-number "<phone>" --name <name> --number <E.164>, or --remove <name>
 *                                                 a number on the phone's emergency card
 *   kid-number "<phone>" <E.164>|--clear          the kid's own number, for "Call" on the parent page
 *   calls "<phone>" --mode open|contacts [--unknown reject|voicemail|ring] [--withheld reject|voicemail|ring]
 *         [--outgoing contacts|any] [--quiet on|off] [--log on|off]
 *                                                 turns calls on (Belay becomes the phone app), with these rules (Phase 5)
 *   calls "<phone>" --off                         turns calls off: the policy's calls is null again
 *   contact "<phone>" --name <words> --number <E.164> [--calls on|off] [--texts on|off] [--parent]
 *                                                 a contact (the same name again gains the number); prints only its id
 *   contact "<phone>" --remove <id>               removes it; prints only its id
 *   block-number "<phone>" <E.164>, unblock-number "<phone>" <E.164>
 *                                                 a number on Android's block list (never 911, 988 or an emergency number)
 *   private-number "<phone>" <E.164>, or private-number "<phone>" --remove <E.164>
 *                                                 a number Belay never records
 *   network "<phone>" --on|--off                  whether the phone notes which websites and services its apps look up (Phase 3)
 *   handover "<phone>"                            hands the phone over to the kid (Phase 11); prints one sentence
 *
 * Changes are logged as the server's (the activity log's "The server"). A running server sees
 * them within a second or two and passes them to the phone's long-poll. Hardening (factory
 * reset, debugging, reset protection) is only turned on on the parent page; `handover` lifts it,
 * as the phone page's "Hand this phone over" does.
 */
import { endAllSessions, newSetupToken, parentCount, passwordProblem, setPassword } from "./auth/parents.js";
import { audit } from "./audit.js";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { createEnrollmentCode } from "./device/enroll.js";
import { packageName, sha256Hex } from "./device/schemas.js";
import { AgentFileError, type Offer, addAgentFile, currentOffer, offerAgent, versionWords } from "./family/agent.js";
import { type RecoveryState, makePhoneRecoveryKey, recoveryState, usableKey } from "./family/recovery.js";
import { issueCommand, listCommands } from "./family/commands.js";
import { appCounts, listChanges } from "./family/apps.js";
import { type DeviceRow, findDeviceByName, listDevices, nameTaken } from "./family/devices.js";
import { LIMITS, RuleRefused, answerRequest, askAgainSummary, decideApp, pausePhone, protect, resumePhone, setNewApps, type PolicyContext } from "./family/policy.js";
import { recentRequests, unseenHelp } from "./family/requests.js";
import { helpSeenFor, parentNumbersFor } from "./family/kidside.js";
import { markHelpSeen, putPhoneParentNumber, removePhoneParentNumber, setKidNumber } from "./family/kidside-changes.js";
import { type LocationChange, locateNow, removePlace, savePlace, setLocation, setLost } from "./family/location/changes.js";
import { latestFix, listFixes, listPlaceEvents } from "./family/location/fixes.js";
import { type Notify, listPlaces, locationFor, locationSettings } from "./family/location/store.js";
import { locationWords } from "./mcp/location.js";
import { type CallsSettingsChange, blockNumber, putContact, removeContact, setCalls, setPrivateNumber, unblockNumber } from "./family/calls/changes.js";
import { listCallRecords } from "./family/calls/records.js";
import { callSettings, callsFor, contactsFor, listContacts, numbersOf } from "./family/calls/store.js";
import { callsSummary } from "./family/calls/words.js";
import { setNetworkLog } from "./family/network/changes.js";
import { networkDays, networkKept, networkLogFor, networkSettings } from "./family/network/store.js";
import { handOver } from "./family/offbelay/changes.js";
import { handoverOf } from "./family/offbelay/store.js";
import { setPhoneRules, setPhoneSettings } from "./family/screentime/changes.js";
import { WEEKDAYS, type Weekday, clockMinutes } from "./family/screentime/days.js";
import { newRuleId, phoneLabels, phoneRules, screenTimeFor } from "./family/screentime/rules.js";
import { usageDays } from "./family/screentime/usage.js";
import { duration } from "./family/screentime/words.js";
import { oneLine } from "./text.js";
import { runOpsCommand } from "./ops/cli.js";
import { aiReads, getSettings } from "./settings.js";
import { formatAgo, isoInZone } from "./time.js";

export interface CliIO {
  db: DB;
  config: Config;
  now: number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads one line without echoing it, when there's a terminal. */
  readSecret: (prompt: string) => Promise<string>;
  /** Whether stdin is a terminal (reset-password asks twice there). */
  interactive: boolean;
  /** For agent-add -: the APK, piped in. */
  stdin?: NodeJS.ReadableStream;
}

class CliError extends Error {}

/** status --json's agent_update: the offer, and what the phone last said about it. */
function updateStatus(offer: Offer | null, iso: (ms: number | null) => string | null) {
  if (!offer) return null;
  return {
    sha256: offer.file.sha256,
    version_code: offer.file.versionCode,
    version_name: offer.file.versionName,
    size: offer.file.size,
    offered_at: iso(offer.offeredAt),
    /** Whether the policy offers it now: false once the phone runs it or a newer version. */
    sent: offer.sent,
    phone: offer.state === null ? null : { state: offer.state, problem: offer.problem, at: iso(offer.stateAt) },
    done_at: iso(offer.doneAt),
  };
}

/** status --json's recovery: never the key or its check. */
function recoveryStatus(state: RecoveryState, iso: (ms: number | null) => string | null) {
  return {
    version: usableKey(state) ? (state.current?.version ?? null) : null,
    last_used: state.lastUse ? { version: state.lastUse.version, used_at: iso(state.lastUse.usedAt), until: iso(state.lastUse.until) } : null,
  };
}

/** status --json's handover. */
function handoverStatus(db: DB, deviceId: string) {
  const h = handoverOf(db, deviceId);
  return h ? { at: h.at, by: h.byName, version: h.version } : null;
}

/** "Of the apps without a decision, 1 is allowed and 2 wait for a parent." */
function askAgainWords(r: { grandfathered: number; stillWaiting: number }): string {
  return `Of the apps without a decision, ${r.grandfathered} ${r.grandfathered === 1 ? "is" : "are"} allowed and ${r.stillWaiting} ${r.stillWaiting === 1 ? "waits" : "wait"} for a parent.`;
}

const USAGE = `Commands:
  setup-link
  create-code <phone name>
  reset-password <username>
  backup <file> [--encrypt]
  verify-backup <file>
  restore [--drill] <file>
  restore-drill
  status [--json]
  protect "<phone>"
  policy "<phone>" --new-apps ask|allow [--allow-waiting] [--hold-new]
  decide "<phone>" <package> allow|block|undecided
  pause "<phone>" [--minutes N] [--note text]
  resume "<phone>"
  agent-add <apk> --version-code <n> [--version-name <name>]
  agent-offer "<phone>" <sha256>
  recovery-key "<phone>"
  remove-other-users "<phone>"
  limit "<phone>" <package|*> --minutes <n> [--name <words>]
  limit "<phone>" <package|*> --remove
  schedule "<phone>" --name <words> --start HH:MM --end HH:MM [--days mon,tue,...] [--lock] [--allow p1,p2]
  schedule "<phone>" --remove <id>
  lock-now "<phone>" [--minutes <n>]
  screen-time "<phone>" --measure on|off
  answer "<phone>" <request id> approve|decline|talk [--minutes <n>] [--note <words>]
  location "<phone>" --mode off|on_demand|periodic [--every <minutes>] [--hours HH:MM-HH:MM|all] [--provider gps|fused] [--keep-on on|off] [--fallback on|off]
  place "<phone>" --name <words> --lat <x> --lng <y> --radius <m> [--notify arrive,leave]
  place "<phone>" --remove <id>
  locate-now "<phone>"
  lost "<phone>" --message <words> [--number <n>]
  lost "<phone>" --off
  help-seen "<phone>" <request id> [--note <words>]
  parent-number "<phone>" --name <name> --number <E.164>
  parent-number "<phone>" --remove <name>
  kid-number "<phone>" <E.164>|--clear
  calls "<phone>" --mode open|contacts [--unknown reject|voicemail|ring] [--withheld reject|voicemail|ring] [--outgoing contacts|any] [--quiet on|off] [--log on|off]
  calls "<phone>" --off
  contact "<phone>" --name <words> --number <E.164> [--calls on|off] [--texts on|off] [--parent]
  contact "<phone>" --remove <id>
  block-number "<phone>" <E.164>
  unblock-number "<phone>" <E.164>
  private-number "<phone>" <E.164>
  private-number "<phone>" --remove <E.164>
  network "<phone>" --on|--off
  handover "<phone>"`;

/** How many of the newest call records status --json lists per phone. */
const STATUS_CALLS = 50;

/** How many of the newest fixes and place events status --json lists per phone. */
const STATUS_FIXES = 50;

/** How many of the newest usage days status --json lists per phone. */
const STATUS_USAGE_DAYS = 31;

/** How many of the newest network days status --json lists per phone. */
const STATUS_NETWORK_DAYS = 31;

/** An on|off flag: true, false, left out (undefined), or anything else ("bad"). */
function onOff(value: string | true | undefined): boolean | undefined | "bad" {
  if (value === undefined) return undefined;
  if (value === "on") return true;
  if (value === "off") return false;
  return "bad";
}

/** Positional arguments, and --name value (or --name=value, or a bare --name) flags. */
function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const next = args[i + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else flags.set(name, true);
  }
  return { positional, flags };
}

export async function runCommand(argv: string[], io: CliIO): Promise<number> {
  // backup, verify-backup and restore-drill (ops/cli.ts).
  const ops = await runOpsCommand(argv, io);
  if (ops !== null) return ops;
  try {
    await run(argv, io);
    return 0;
  } catch (error) {
    // A change the server refuses (rules too large, an app the phone never blocks…) says why.
    if (error instanceof CliError || error instanceof RuleRefused) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function run(argv: string[], io: CliIO): Promise<void> {
  const { db, config, now } = io;
  const [command, ...args] = argv;
  const { positional, flags } = parseArgs(args);
  const server = { kind: "server" } as const;
  const ctx: PolicyContext = { db, now };
  const iso = (ms: number | null) => (ms === null ? null : isoInZone(ms, getSettings(db).timezone));

  const phone = (): DeviceRow => {
    const name = positional[0]?.trim();
    if (!name) throw new CliError(`Name the phone first, in quotes, like "Sam's phone".\n\n${USAGE}`);
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), now).map((d) => `"${d.name}"`);
    throw new CliError(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };

  switch (command) {
    case "setup-link": {
      if (parentCount(db) > 0) throw new CliError("Belay is already set up. To add a parent, use Invite another parent in Settings.");
      io.out(`${config.publicUrl}/setup?token=${newSetupToken(db, now)}`);
      io.out("It works once, for 24 hours.");
      return;
    }
    case "create-code": {
      const name = args.join(" ").trim();
      if (!name || name.length > 60) throw new CliError("Usage: create-code <phone name, 1 to 60 characters>");
      if (nameTaken(db, name)) throw new CliError(`A phone is already called "${name}". Use Reconnect on its page instead.`);
      const made = createEnrollmentCode(db, now, { deviceName: name, createdBy: null });
      audit(db, now, server, "code.created", { detail: { name } });
      io.out(made.code);
      io.err(`Works once, for 30 minutes. On the computer the phone is plugged into:\n  scripts/provision.sh --server ${config.publicUrl} --code ${made.code}`);
      return;
    }
    case "reset-password": {
      const username = args[0];
      if (!username) throw new CliError("Usage: reset-password <username>");
      const row = db.prepare<[string], { id: string }>("SELECT id FROM parents WHERE username = ?").get(username);
      if (!row) throw new CliError(`No parent is called ${username}.`);
      const password = await io.readSecret("New password: ");
      const repeat = io.interactive ? await io.readSecret("The same password again: ") : password;
      const problem = passwordProblem(password, repeat);
      if (problem) throw new CliError(problem);
      await setPassword(db, row.id, password);
      endAllSessions(db, row.id);
      audit(db, now, server, "parent.password_reset", { detail: { username } });
      io.out("Password changed. That parent was signed out everywhere.");
      return;
    }
    case "status": {
      const settings = getSettings(db);
      const phones = listDevices(db, settings, now).map((d) => {
        const counts = appCounts(db, d.id);
        return {
          name: d.name,
          status: d.status,
          problems: d.problems.map((p) => p.text),
          last_heard_from: iso(d.lastSeenAt),
          heard_ago: d.lastSeenAt === null ? "never" : formatAgo(d.lastSeenAt, now),
          last_app_list: iso(d.lastInventoryAt),
          user_apps: counts.userApps,
          apps_to_review: counts.unreviewed,
          /** The server's version of the phone's rules (0: none). */
          policy_version: d.policyVersion,
          /** What the phone last said it enforces (docs/protocol.md, "Enforcement"), or null. */
          enforcement: d.enforcement,
          /** Phase 6: the version of Belay the phone runs, and the SHA-256 of the certificate it's signed with, as it reported them. */
          agent_version_code: d.facts?.agent_version_code ?? null,
          agent_signing_sha256: d.facts?.agent_signing_sha256 ?? null,
          /** Phase 6: the update offered to the phone, if any, and how it's going. */
          agent_update: updateStatus(currentOffer(db, d.id), iso),
          /** Phase 6: the version of the recovery key the policy carries (null: none, or it was used), and its last use. */
          recovery: recoveryStatus(recoveryState(db, d.id), iso),
          /** Phase 10: the commands sent to the phone lately, newest first, with what the phone reported. */
          commands: listCommands(db, d.id, now).map((c) => ({
            id: c.id,
            kind: c.kind,
            issued_at: iso(c.issuedAt),
            expires_at: iso(c.expiresAt),
            state: c.state,
            result: c.result,
            at: iso(c.resultAt),
            problem: c.problem,
          })),
          /**
           * The kid's requests: waiting ones (and help no parent has seen), and the last 30 days'. Phase 3 adds more_time and
           * agreement ones, Phase 7 help and talk ones, and withdrawn_at (as the phone sent it) on any the kid withdrew.
           */
          requests: recentRequests(db, now, { deviceId: d.id }).map((r) => ({
            id: r.id,
            kind: r.kind,
            package: r.kind === "app" || r.kind === "more_time" ? r.package : null,
            status: r.status,
            reason: r.reason,
            ...(r.kind === "more_time" ? { limit_id: r.limitId, minutes: r.minutes, given_minutes: r.givenMinutes } : {}),
            ...(r.kind === "agreement" ? { version: r.version, answer: r.answer } : {}),
            ...(r.kind === "help"
              ? {
                  seen_at: iso(r.seenAt),
                  seen_by: r.seenAt === null ? null : (r.seenBy ?? "the server"),
                  location: r.fix ? { id: r.fix.id, at: r.fix.at, lat: r.fix.lat, lng: r.fix.lng, accuracy_m: r.fix.accuracyM, mock: r.fix.mock } : null,
                }
              : {}),
            ...(r.kind === "contact" ? { contact_name: r.contactName, contact_number: r.contactNumber, contact_id: r.contactId } : {}),
            ...(r.withdrawnAt !== null ? { withdrawn_at: r.withdrawnAt } : {}),
          })),
          recent_changes: listChanges(db, { deviceId: d.id, includeSystem: true, limit: 20 }).map((c) => ({
            kind: c.kind,
            package: c.package,
            at: iso(c.at),
            found_by: c.backfilled ? "server snapshot" : c.detection,
          })),
          /** Phase 3: the screen-time rules the server sends the phone (the policy's screen_time), or null. */
          screen_time: screenTimeFor(db, d.id, now),
          /** Phase 3: the days of usage the phone sent, newest first (as_of as the phone sent it). */
          usage: usageDays(db, d.id, { limit: STATUS_USAGE_DAYS }).map((u) => ({
            day: u.day,
            zone: u.zone,
            as_of: u.asOf,
            screen_minutes: u.screenMinutes,
            apps: u.apps.map((a) => ({ package: a.package, minutes: a.minutes, opens: a.opens })),
          })),
          /** Phase 4: the policy's location (null until a parent first sets it). */
          location: locationFor(db, d.id),
          /** Phase 4: the fixes the server keeps, newest first, at most 50 (times as the phone sent them). */
          fixes: listFixes(db, d.id, { limit: STATUS_FIXES }).map((f) => ({
            id: f.id,
            at: f.at,
            lat: f.lat,
            lng: f.lng,
            accuracy_m: f.accuracyM,
            provider: f.provider,
            reason: f.reason,
            command_id: f.commandId,
            mock: f.mock,
          })),
          /** Phase 4: arrivals and departures, newest first, at most 50 (the phone's times, but never more than 5 minutes after the server got them). */
          place_events: listPlaceEvents(db, d.id, { limit: STATUS_FIXES }).map((e) => ({ id: e.id, place_id: e.placeId, place_name: e.placeName, kind: e.kind, at: e.at, fix_id: e.fixId })),
          /** Phase 7: the policy's help_seen, parent_numbers and ai_reads. */
          help_seen: helpSeenFor(db, d.id, now),
          parent_numbers: parentNumbersFor(db, d.id),
          ai_reads: aiReads(settings),
          /** Phase 5: the policy's calls (null while they're off), contacts, private and blocked numbers. */
          calls: callsFor(db, d.id),
          contacts: contactsFor(db, d.id),
          private_numbers: numbersOf(db, d.id, "private"),
          blocked_numbers: numbersOf(db, d.id, "blocked"),
          /** Phase 5: the call records the server keeps, newest first, at most 50 (times as the phone sent them). */
          call_records: listCallRecords(db, d.id, { limit: STATUS_CALLS }).map((r) => ({
            id: r.id,
            at: r.at,
            direction: r.direction,
            contact_id: r.contactId,
            number: r.number,
            duration_s: r.durationS,
            outcome: r.outcome,
            reason: r.reason,
          })),
          /** Phase 11: the hand-over, as the policy carries it (at: milliseconds since the epoch), with the rules version that carried it; null: none. */
          handover: handoverStatus(db, d.id),
          /** Phase 3: the policy's network_log, and the days of network activity the phone sent, newest first (as_of as the phone sent it). */
          network_log: networkLogFor(db, d.id),
          network: networkDays(db, d.id, { limit: STATUS_NETWORK_DAYS }).map((n) => ({
            day: n.day,
            zone: n.zone,
            as_of: n.asOf,
            entries: n.entries.map((e) => ({ package: e.package, domain: e.domain, lookups: e.lookups })),
            dropped: n.dropped,
          })),
        };
      });
      if (flags.has("json")) {
        io.out(JSON.stringify({ phones }, null, 2));
        return;
      }
      if (!phones.length) io.out("No phones yet.");
      const devices = listDevices(db, settings, now);
      for (const p of phones) {
        const waiting = p.requests.filter((r) => r.status === "pending").length;
        const id = devices.find((d) => d.name === p.name)?.id ?? "";
        const help = unseenHelp(db, id).length;
        io.out(`${p.name}: ${p.status}${p.problems.length ? ` (${p.problems.join("; ")})` : ""}`);
        if (help) io.out(`  ${help === 1 ? "a help request hasn't" : `${help} help requests haven't`} been seen: the Requests page has it (help-seen marks it)`);
        io.out(`  last heard from ${p.heard_ago}; ${p.user_apps} apps, ${p.apps_to_review} to review; ${waiting} request${waiting === 1 ? "" : "s"} waiting`);
        io.out(`  rules version ${p.policy_version}; the phone applied ${p.enforcement ? `version ${p.enforcement.policy_version}` : "none yet"}`);
        if (p.screen_time) {
          const today = p.usage[0];
          io.out(
            `  screen time: ${p.screen_time.limits.length} limit${p.screen_time.limits.length === 1 ? "" : "s"}, ${p.screen_time.schedules.length} schedule${p.screen_time.schedules.length === 1 ? "" : "s"}, measuring ${p.screen_time.measure ? "on" : "off"}` +
              (today ? `; ${today.day}: ${duration(today.screen_minutes)} so far` : ""),
          );
        }
        const s = locationSettings(db, id);
        if (s) {
          const last = latestFix(db, id);
          io.out(`  location: ${locationWords(s)}${last ? `; last fix ${formatAgo(last.at, now)}` : ""}`);
        }
        const cs = callSettings(db, id);
        if (cs) io.out(`  calls: ${callsSummary(cs)}; ${p.contacts.length} contact${p.contacts.length === 1 ? "" : "s"}, ${p.blocked_numbers.length} blocked`);
        const ns = networkSettings(db, id);
        const kept = networkKept(db, id);
        if (ns || kept.days) io.out(`  network logging: ${ns?.enabled ? "on" : "off"}; ${kept.days} day${kept.days === 1 ? "" : "s"} of network activity kept`);
        for (const c of p.recent_changes.slice(0, 5)) io.out(`  ${c.at ?? ""} ${c.kind} ${c.package}`);
      }
      return;
    }
    case "network": {
      // Phase 3: what the phone page's network logging switch does: a parent's choice, never an AI app's.
      const row = phone();
      const on = flags.get("on");
      const off = flags.get("off");
      if ((on === undefined) === (off === undefined) || (on ?? off) !== true || positional.length > 1) throw new CliError(`Usage: network "<phone>" --on|--off`);
      const turnOn = on === true;
      const done = setNetworkLog(ctx, row.id, turnOn, server);
      const what = turnOn ? "on" : "off";
      io.out(
        done.result.already
          ? `${row.name}: network logging was already ${what} (rules version ${done.version}).`
          : `${row.name}: network logging is ${what} (rules version ${done.version}). ` +
              (turnOn
                ? "The phone notes which websites and services its apps look up, by name and how many times a day, and sends that."
                : `The phone stops noting which websites and services its apps look up. What the server kept stays until it's ${getSettings(db).networkDays} days old; Stop collecting, on the phone's page, deletes it now.`),
      );
      return;
    }
    case "handover": {
      // Phase 11: what the phone page's "Hand this phone over" does, where typing the phone's name is the confirmation.
      const row = phone();
      const done = handOver(ctx, row.id, server);
      io.out(
        done.result.already
          ? `${row.name} was already handed over (rules version ${done.result.handover.version}).`
          : `${row.name} is handed over (rules version ${done.version}): factory reset, debugging and accounts are unlocked, reset protection is cleared and Play may use any account, and the phone tells the kid to back up and reset it from Settings.`,
      );
      return;
    }
    case "protect": {
      const row = phone();
      const done = protect(ctx, row.id, server);
      const n = done.result.grandfathered;
      io.out(
        done.result.alreadyOn && !done.changed
          ? `${row.name}: protection was already on (rules version ${done.version}).`
          : `${row.name}: protection is on (rules version ${done.version}). ` +
              (done.result.firstTime || !done.result.stillWaiting
                ? `${n} app${n === 1 ? "" : "s"} already on the phone ${n === 1 ? "is" : "are"} allowed.`
                : askAgainWords(done.result)),
      );
      return;
    }
    case "policy": {
      const row = phone();
      const mode = flags.get("new-apps");
      if (mode !== "ask" && mode !== "allow") throw new CliError(`Usage: policy "<phone>" --new-apps ask|allow [--allow-waiting] [--hold-new]`);
      // Back to ask after allow: by default the apps installed meanwhile are allowed and the ones waiting before still wait.
      const again = mode === "ask" ? askAgainSummary(db, row.id) : null;
      const allow = again
        ? [...(flags.has("hold-new") ? [] : again.installedMeanwhile), ...(flags.has("allow-waiting") ? again.waitingBefore : [])].map((a) => a.package)
        : undefined;
      const done = setNewApps(ctx, row.id, mode, server, { allow });
      const n = done.result.grandfathered;
      io.out(
        `${row.name}: new apps ${mode === "ask" ? "wait for a parent's approval" : "run without asking"} (rules version ${done.version}).` +
          (done.result.firstTime && n ? ` ${n} app${n === 1 ? "" : "s"} already on the phone allowed.` : again && done.changed ? ` ${askAgainWords(done.result)}` : ""),
      );
      return;
    }
    case "decide": {
      const row = phone();
      const [, pkg = "", state = ""] = positional;
      if (!packageName.safeParse(pkg).success || (state !== "allow" && state !== "block" && state !== "undecided")) {
        throw new CliError(`Usage: decide "<phone>" <package> allow|block|undecided`);
      }
      const done = decideApp(ctx, row.id, pkg, state === "allow" ? "allowed" : state === "block" ? "blocked" : "undecided", server);
      const words = state === "allow" ? "allowed" : state === "block" ? "blocked" : "without a decision";
      io.out(`${row.name}: ${pkg} is ${words} (rules version ${done.version}).`);
      return;
    }
    case "pause": {
      const row = phone();
      const minutesFlag = flags.get("minutes");
      const minutes = minutesFlag === undefined ? null : Number(minutesFlag);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.maxPauseMinutes)) {
        throw new CliError(`Usage: pause "<phone>" [--minutes N], N from 1 to ${LIMITS.maxPauseMinutes}`);
      }
      const note = flags.get("note");
      const done = pausePhone(ctx, row.id, { minutes, note: typeof note === "string" ? note : null }, server);
      io.out(`${row.name}: paused ${done.result.until === null ? "until a parent resumes it" : `until ${iso(done.result.until) ?? ""}`} (rules version ${done.version}).`);
      return;
    }
    case "resume": {
      const row = phone();
      const done = resumePhone(ctx, row.id, server);
      io.out(done.result.wasPaused ? `${row.name}: resumed (rules version ${done.version}).` : `${row.name} wasn't paused.`);
      return;
    }
    case "agent-add": {
      // Its only line on stdout is the SHA-256, for scripts: agent-offer takes it.
      const [path] = positional;
      const code = Number(flags.get("version-code"));
      const name = flags.get("version-name");
      if (!path || !flags.has("version-code") || name === true) throw new CliError("Usage: agent-add <apk, or - for stdin> --version-code <n> [--version-name <name>]");
      const source = path === "-" ? io.stdin : path;
      if (!source) throw new CliError("There's no stdin to read the APK from here. Give the file's path instead.");
      let added: Awaited<ReturnType<typeof addAgentFile>>;
      try {
        added = await addAgentFile(db, config.agentsDir, now, source, { code, name: name ?? null }, { parentId: null });
      } catch (error) {
        if (error instanceof AgentFileError) throw new CliError(error.message);
        throw error;
      }
      const { file, existed } = added;
      if (!existed) audit(db, now, server, "agent.added", { detail: { version_code: file.versionCode, version_name: file.versionName ?? undefined, sha256: file.sha256, size: file.size } });
      io.out(file.sha256);
      io.err(`${existed ? "Already on the server" : "Added"}: Belay ${versionWords(file)}, ${file.size} bytes. To offer it to a phone: agent-offer "<phone>" ${file.sha256}`);
      return;
    }
    case "remove-other-users": {
      const row = phone();
      if (row.revoked_at !== null) throw new CliError(`${row.name} is disconnected, so it wouldn't get that.`);
      const done = issueCommand(ctx, row.id, "remove_other_users", server);
      const until = iso(done.result.command.expiresAt) ?? "";
      io.out(
        done.result.already
          ? `${row.name}: already asked to remove other users and profiles; waiting for the phone, until ${until}.`
          : `${row.name}: the phone removes every other user and profile when it gets its rules (rules version ${done.version}), if that's by ${until}.`,
      );
      return;
    }
    case "recovery-key": {
      // Its only line on stdout is the key, grouped, for scripts; the rest goes to stderr.
      const row = phone();
      if (row.revoked_at !== null) throw new CliError(`${row.name} is disconnected, so a new key wouldn't reach it.`);
      const done = makePhoneRecoveryKey(ctx, row.id, server);
      io.out(done.result.grouped);
      io.err(
        `Recovery key version ${done.result.version} for ${row.name} (rules version ${done.version}). It's shown only now: print it, or keep it in a password manager.` +
          (done.result.replaced ? " The earlier key stops working once the phone has this one." : ""),
      );
      return;
    }
    case "limit": {
      // Its only line on stdout is the limit's id, for scripts.
      const row = phone();
      const pkg = positional[1] ?? "";
      const usage = `Usage: limit "<phone>" <package|*> --minutes <n> [--name <words>], or --remove`;
      if (pkg !== "*" && !packageName.safeParse(pkg).success) throw new CliError(usage);
      const p = phoneRules(db, row.id);
      const total = pkg === "*";
      const wanted = structuredClone(p.rules);
      const index = wanted.limits.findIndex((l) => (total ? l.packages.includes("*") : l.packages.length === 1 && l.packages[0] === pkg));
      const what = total ? "the daily total" : pkg;
      if (flags.has("remove")) {
        const [removed] = index < 0 ? [] : wanted.limits.splice(index, 1);
        if (!removed) throw new CliError(`${row.name} has no limit for ${what}.`);
        const done = setPhoneRules(ctx, row.id, wanted, server);
        io.out(removed.id);
        io.err(`${row.name}: no more limit for ${what} (rules version ${done.version}).`);
        return;
      }
      const minutes = Number(flags.get("minutes"));
      const name = flags.get("name");
      if (!flags.has("minutes") || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440 || name === true || (name !== undefined && !name.trim())) {
        throw new CliError(`${usage}. Minutes are 0 to 1440 a day.`);
      }
      const words = name?.trim().slice(0, 60);
      const existing = index < 0 ? undefined : wanted.limits[index];
      const limit = existing
        ? { ...existing, minutes, by_day: null, ...(words ? { name: words } : {}) }
        : { id: newRuleId("l"), name: words ?? (total ? "Screen time" : oneLine(phoneLabels(db, row.id)(pkg), 60) || pkg), packages: [pkg], minutes, by_day: null };
      if (existing) wanted.limits[index] = limit;
      else wanted.limits.push(limit);
      const done = setPhoneRules(ctx, row.id, wanted, server);
      io.out(limit.id);
      io.err(`${row.name}: ${duration(minutes)} a day for ${what} (rules version ${done.version}).`);
      return;
    }
    case "schedule": {
      // Its only line on stdout is the schedule's id, for scripts.
      const row = phone();
      const wanted = structuredClone(phoneRules(db, row.id).rules);
      const remove = flags.get("remove");
      if (remove !== undefined) {
        const gone = typeof remove === "string" ? wanted.schedules.find((s) => s.id === remove) : undefined;
        if (!gone) throw new CliError(`Usage: schedule "<phone>" --remove <id>, the id schedule printed. ${row.name} has no schedule with that id.`);
        wanted.schedules = wanted.schedules.filter((s) => s.id !== gone.id);
        const done = setPhoneRules(ctx, row.id, wanted, server);
        io.out(gone.id);
        io.err(`${row.name}: no more ${gone.name} (rules version ${done.version}).`);
        return;
      }
      const name = flags.get("name");
      const start = flags.get("start");
      const end = flags.get("end");
      const daysFlag = flags.get("days");
      const allowFlag = flags.get("allow");
      const usage = `Usage: schedule "<phone>" --name <words> --start HH:MM --end HH:MM [--days mon,tue,...] [--lock] [--allow p1,p2]`;
      if (typeof name !== "string" || !name.trim() || typeof start !== "string" || typeof end !== "string" || clockMinutes(start) === null || clockMinutes(end) === null) {
        throw new CliError(`${usage}. Times are like 21:00, in the phone's time.`);
      }
      const days = daysFlag === undefined ? [...WEEKDAYS] : typeof daysFlag === "string" ? daysFlag.split(",").map((d) => d.trim().toLowerCase()) : [];
      if (!days.length || days.some((d) => !(WEEKDAYS as readonly string[]).includes(d))) throw new CliError(`${usage}. Days are mon, tue, wed, thu, fri, sat and sun.`);
      const allow = allowFlag === undefined ? [] : typeof allowFlag === "string" ? allowFlag.split(",").map((p) => p.trim()) : [""];
      if (allow.some((p) => !packageName.safeParse(p).success)) throw new CliError(`${usage}. --allow takes package names, like com.example.app.`);
      const schedule = {
        id: newRuleId("s"),
        kind: "custom" as const,
        name: name.trim().slice(0, 60),
        days: [...new Set(days)] as Weekday[],
        start,
        end,
        allow: [...new Set(allow)],
        lock: flags.has("lock"),
        skip: [],
      };
      wanted.schedules.push(schedule);
      const done = setPhoneRules(ctx, row.id, wanted, server);
      io.out(schedule.id);
      const nextDay = (clockMinutes(end) ?? 0) <= (clockMinutes(start) ?? 0);
      io.err(`${row.name}: ${schedule.name} from ${start} to ${end}${nextDay ? " the next day" : ""} (rules version ${done.version}).`);
      return;
    }
    case "lock-now": {
      // Its only line on stdout is the command's id, for scripts.
      const row = phone();
      if (row.revoked_at !== null) throw new CliError(`${row.name} is disconnected, so it wouldn't get that.`);
      const minutesFlag = flags.get("minutes");
      const minutes = minutesFlag === undefined ? 10 : Number(minutesFlag);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw new CliError(`Usage: lock-now "<phone>" [--minutes <n>], n from 1 to 1440 (10 if left out)`);
      const done = issueCommand(ctx, row.id, "lock_now", server, { expiresInMs: minutes * 60_000 });
      io.out(done.result.command.id);
      io.err(`${row.name}: the phone locks its screen when it gets this (rules version ${done.version}), if that's by ${iso(done.result.command.expiresAt) ?? ""}.`);
      return;
    }
    case "screen-time": {
      const row = phone();
      const measure = flags.get("measure");
      if (measure !== "on" && measure !== "off") throw new CliError(`Usage: screen-time "<phone>" --measure on|off`);
      const done = setPhoneSettings(ctx, row.id, { measure: measure === "on" }, server);
      io.out(
        `${row.name}: measuring screen time is ${measure} (rules version ${done.version}). ${measure === "on" ? "The phone sends how long apps are used." : "The phone counts only to enforce its limits, and sends no minutes."}`,
      );
      return;
    }
    case "answer": {
      const row = phone();
      const [, id = "", choice = ""] = positional;
      const answers = { approve: "approved", decline: "declined", talk: "talk" } as const;
      const answer = answers[choice as keyof typeof answers] as (typeof answers)[keyof typeof answers] | undefined;
      const minutesFlag = flags.get("minutes");
      const minutes = minutesFlag === undefined ? undefined : Number(minutesFlag);
      const note = flags.get("note");
      // Phase 5: approving a contact request takes the contact's name and what they may do (calls and texts on unless turned off).
      const contactName = flags.get("name");
      const contactCalls = onOff(flags.get("calls"));
      const contactTexts = onOff(flags.get("texts"));
      if (!id || !answer || (minutes !== undefined && (!Number.isInteger(minutes) || minutes < 1 || minutes > 240)) || contactName === true || contactCalls === "bad" || contactTexts === "bad") {
        throw new CliError(
          `Usage: answer "<phone>" <request id> approve|decline|talk [--minutes <n>] [--note <words>] [--name <words>] [--calls on|off] [--texts on|off]; minutes are 1 to 240, for more time; name, calls and texts, for a contact`,
        );
      }
      const contact = { ...(contactName !== undefined ? { name: contactName } : {}), ...(contactCalls !== undefined ? { calls: contactCalls } : {}), ...(contactTexts !== undefined ? { texts: contactTexts } : {}) };
      const done = answerRequest(ctx, row.id, id, answer, server, typeof note === "string" ? note : null, { ...(minutes === undefined ? {} : { minutes }), contact });
      if (!done.result) throw new CliError(`${row.name} has no request ${id}.`);
      const given = done.result.minutes !== null ? `: ${done.result.minutes} more minutes for ${done.result.day ?? "today"}` : "";
      const added = done.result.contact ? (done.result.contact.existing ? `: ${done.result.contact.name} was a contact already` : `: ${done.result.contact.name} is a contact now`) : "";
      io.out(`${row.name}: request ${id} is ${answer === "talk" ? "answered \"let's talk\"" : answer}${given}${added} (rules version ${done.version}).`);
      return;
    }
    case "calls": {
      const row = phone();
      const usage = `Usage: calls "<phone>" --mode open|contacts [--unknown reject|voicemail|ring] [--withheld reject|voicemail|ring] [--outgoing contacts|any] [--quiet on|off] [--log on|off], or calls "<phone>" --off`;
      if (flags.has("off")) {
        if (flags.size > 1) throw new CliError(usage);
        const was = callSettings(db, row.id)?.enabled === true;
        const done = setCalls(ctx, row.id, { enabled: false }, server);
        io.out(was ? `${row.name}: calls are off: Belay isn't the phone app, so it leaves calls alone (rules version ${done.version}).` : `${row.name}: calls were already off.`);
        return;
      }
      const change: CallsSettingsChange = {};
      const mode = flags.get("mode");
      if (mode !== undefined) {
        if (mode !== "open" && mode !== "contacts") throw new CliError(usage);
        change.mode = mode;
      }
      for (const key of ["unknown", "withheld"] as const) {
        const value = flags.get(key);
        if (value === undefined) continue;
        if (value !== "reject" && value !== "voicemail" && value !== "ring") throw new CliError(usage);
        change[key] = value;
      }
      const outgoing = flags.get("outgoing");
      if (outgoing !== undefined) {
        if (outgoing !== "contacts" && outgoing !== "any") throw new CliError(usage);
        change.outgoing = outgoing;
      }
      for (const key of ["quiet", "log"] as const) {
        const value = onOff(flags.get(key));
        if (value === "bad") throw new CliError(usage);
        if (value !== undefined) change[key] = value;
      }
      const known = new Set(["mode", "unknown", "withheld", "outgoing", "quiet", "log"]);
      if ([...flags.keys()].some((k) => !known.has(k))) throw new CliError(usage);
      // Turning calls on needs the mode; once they're on, any one rule can change alone.
      const on = callSettings(db, row.id)?.enabled === true;
      if (!on && change.mode === undefined) throw new CliError(`${usage}. Turning calls on needs --mode.`);
      if (on && !Object.keys(change).length) throw new CliError(usage);
      const done = setCalls(ctx, row.id, { ...change, enabled: true }, server);
      io.out(`${row.name}: calls are ${callsSummary(callSettings(db, row.id))} (rules version ${done.version}).`);
      // A parent on the emergency card who isn't a contact can't get through "contacts only".
      const s = callSettings(db, row.id);
      const numbers = new Set(listContacts(db, row.id).flatMap((c) => c.numbers));
      const missing = parentNumbersFor(db, row.id).filter((p) => !numbers.has(p.number));
      if (s?.mode === "contacts" && missing.length) {
        io.err(`On the emergency card but not a contact: ${missing.map((p) => `${p.name} (${p.number})`).join(", ")}. With only contacts, their calls follow --unknown. Add them with contact --parent.`);
      }
      return;
    }
    case "contact": {
      // Its only line on stdout is the contact's id, for scripts.
      const row = phone();
      const remove = flags.get("remove");
      if (remove !== undefined) {
        const done = typeof remove === "string" ? removeContact(ctx, row.id, remove, server) : null;
        if (!done?.result.removed) throw new CliError(`Usage: contact "<phone>" --remove <id>, the id contact printed. ${row.name} has no contact with that id.`);
        io.out(done.result.removed.id);
        io.err(`${row.name}: ${done.result.removed.name} isn't a contact any more (rules version ${done.version}).`);
        return;
      }
      const usage = `Usage: contact "<phone>" --name <words> --number <E.164> [--calls on|off] [--texts on|off] [--parent]`;
      const name = flags.get("name");
      const number = flags.get("number");
      const calls = onOff(flags.get("calls"));
      const texts = onOff(flags.get("texts"));
      const parentFlag = flags.get("parent");
      const parent = parentFlag === undefined ? undefined : parentFlag === true ? true : onOff(parentFlag);
      if (typeof name !== "string" || !name.trim() || typeof number !== "string" || calls === "bad" || texts === "bad" || parent === "bad") throw new CliError(usage);
      const done = putContact(ctx, row.id, { name, number, ...(calls !== undefined ? { calls } : {}), ...(texts !== undefined ? { texts } : {}), ...(parent !== undefined ? { parent } : {}) }, server);
      const c = done.result.contact;
      io.out(c.id);
      const can = c.calls && c.texts ? "can call and text" : c.calls ? "can call, not text" : c.texts ? "can text, not call" : "can't call or text";
      io.err(`${row.name}: ${c.name} (${c.numbers.join(", ")}) ${can}${c.parent ? ", as a parent" : ""} (rules version ${done.version}).`);
      return;
    }
    case "block-number":
    case "unblock-number": {
      const row = phone();
      const number = positional[1] ?? "";
      if (!number || flags.size) throw new CliError(`Usage: ${command} "<phone>" <E.164>, like +15555550100`);
      if (command === "block-number") {
        const done = blockNumber(ctx, row.id, number, server);
        io.out(done.changed ? `${row.name}: ${number} is blocked (rules version ${done.version}).` : `${row.name}: ${number} was blocked already.`);
        if (callSettings(db, row.id)?.enabled !== true) io.err("Calls are off on this phone: Belay blocks it once calls are on.");
        return;
      }
      const done = unblockNumber(ctx, row.id, number, server);
      io.out(done.result.was ? `${row.name}: ${number} is unblocked (rules version ${done.version}).` : `${row.name}: ${number} wasn't blocked.`);
      return;
    }
    case "private-number": {
      const row = phone();
      const remove = flags.get("remove");
      const number = typeof remove === "string" ? remove : (positional[1] ?? "");
      if (!number || remove === true || (remove === undefined && flags.size)) throw new CliError(`Usage: private-number "<phone>" <E.164>, or private-number "<phone>" --remove <E.164>`);
      const done = setPrivateNumber(ctx, row.id, number, remove === undefined, server);
      if (remove === undefined) {
        io.out(done.result.was ? `${row.name}: ${number} was private already.` : `${row.name}: Belay never records calls with ${number} (rules version ${done.version}).`);
      } else {
        io.out(done.result.was ? `${row.name}: ${number} isn't a private number any more (rules version ${done.version}).` : `${row.name}: ${number} wasn't a private number.`);
      }
      return;
    }
    case "location": {
      const row = phone();
      const usage = `Usage: location "<phone>" --mode off|on_demand|periodic [--every <minutes>] [--hours HH:MM-HH:MM|all] [--provider gps|fused] [--keep-on on|off] [--fallback on|off]`;
      const change: LocationChange = {};
      const mode = flags.get("mode");
      if (mode !== undefined) {
        if (mode !== "off" && mode !== "on_demand" && mode !== "periodic") throw new CliError(usage);
        change.mode = mode;
      }
      const every = flags.get("every");
      if (every !== undefined) {
        const n = Number(every);
        if (every === true || !Number.isInteger(n) || n < 15 || n > 120) throw new CliError(`${usage}. --every is 15 to 120 minutes.`);
        change.everyMinutes = n;
      }
      const hours = flags.get("hours");
      if (hours !== undefined) {
        const match = typeof hours === "string" ? /^(\d{2}:\d{2})-(\d{2}:\d{2})$/.exec(hours) : null;
        if (hours === "all") change.hours = null;
        else if (match?.[1] && match[2]) change.hours = { start: match[1], end: match[2] };
        else throw new CliError(`${usage}. --hours is like 07:00-21:00, in the phone's time, or all.`);
      }
      const provider = flags.get("provider");
      if (provider !== undefined) {
        if (provider !== "gps" && provider !== "fused") throw new CliError(usage);
        change.provider = provider;
      }
      for (const [flag, key] of [
        ["keep-on", "keepOn"],
        ["fallback", "fallbackFused"],
      ] as const) {
        const value = flags.get(flag);
        if (value === undefined) continue;
        if (value !== "on" && value !== "off") throw new CliError(usage);
        change[key] = value === "on";
      }
      if (!Object.keys(change).length) throw new CliError(usage);
      const done = setLocation(ctx, row.id, change, server);
      const s = done.result.settings;
      io.out(`${row.name}: location is ${locationWords(s)}${s.mode !== "off" && s.keepOn ? ", kept on" : ""}, with ${s.provider === "gps" ? "GPS only" : "Android's combined provider"} (rules version ${done.version}).`);
      return;
    }
    case "place": {
      // Its only line on stdout is the place's id, for scripts.
      const row = phone();
      const remove = flags.get("remove");
      if (remove !== undefined) {
        const done = typeof remove === "string" ? removePlace(ctx, row.id, remove, server) : null;
        if (!done?.result.removed) throw new CliError(`Usage: place "<phone>" --remove <id>, the id place printed. ${row.name} has no place with that id.`);
        io.out(done.result.removed.id);
        io.err(`${row.name}: no more ${done.result.removed.name} (rules version ${done.version}).`);
        return;
      }
      const usage = `Usage: place "<phone>" --name <words> --lat <x> --lng <y> --radius <m> [--notify arrive,leave]`;
      const name = flags.get("name");
      const lat = Number(flags.get("lat"));
      const lng = Number(flags.get("lng"));
      const radius = Number(flags.get("radius"));
      const notifyFlag = flags.get("notify");
      if (typeof name !== "string" || !flags.has("lat") || !flags.has("lng") || !flags.has("radius") || !Number.isFinite(lat) || !Number.isFinite(lng)) {
        throw new CliError(`${usage}. Latitude and longitude are numbers, like 40.1 and -73.2.`);
      }
      const notify = notifyFlag === undefined || notifyFlag === "none" ? [] : typeof notifyFlag === "string" ? notifyFlag.split(",").map((n) => n.trim()) : [""];
      if (notify.some((n) => n !== "arrive" && n !== "leave")) throw new CliError(`${usage}. --notify is arrive, leave, or both: arrive,leave.`);
      const same = listPlaces(db, row.id).find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
      const done = savePlace(ctx, row.id, { ...(same ? { id: same.id } : {}), name, lat, lng, radiusM: radius, notify: notify as Notify[] }, server);
      io.out(done.result.place.id);
      io.err(`${row.name}: ${done.result.place.name}, ${radius} m around ${done.result.place.lat}, ${done.result.place.lng} (rules version ${done.version}).`);
      return;
    }
    case "locate-now": {
      // Its only line on stdout is the command's id, for scripts. It doesn't wait for the fix: status --json shows it.
      const row = phone();
      if (row.revoked_at !== null) throw new CliError(`${row.name} is disconnected, so it wouldn't get that.`);
      const done = locateNow(ctx, row.id, server);
      io.out(done.result.command);
      io.err(`${row.name}: the phone takes a fix when it gets this (rules version ${done.version}), if that's by ${iso(done.result.expiresAt) ?? ""}. The kid gets a notice.`);
      return;
    }
    case "lost": {
      const row = phone();
      if (flags.has("off")) {
        const done = setLost(ctx, row.id, null, server);
        io.out(done.result.changed ? `${row.name}: lost mode is off (rules version ${done.version}).` : `${row.name} wasn't in lost mode.`);
        return;
      }
      const message = flags.get("message");
      const number = flags.get("number");
      if (typeof message !== "string" || number === true) throw new CliError(`Usage: lost "<phone>" --message <words> [--number <n>], or lost "<phone>" --off`);
      const done = setLost(ctx, row.id, { message, number: number ?? null }, server);
      io.out(`${row.name}: lost mode is on; the lock screen says "${locationFor(db, row.id)?.lost?.message ?? message}" (rules version ${done.version}).`);
      return;
    }
    case "help-seen": {
      const row = phone();
      const id = positional[1] ?? "";
      const note = flags.get("note");
      if (!id || note === true) throw new CliError(`Usage: help-seen "<phone>" <request id> [--note <words>]`);
      const done = markHelpSeen(ctx, row.id, id, server, note ?? null);
      if (!done.result) throw new CliError(`${row.name} has no help request ${id}.`);
      io.out(
        done.result.already
          ? `${row.name}: help request ${id} was already seen, at ${iso(done.result.seenAt) ?? ""}.`
          : `${row.name}: help request ${id} is marked seen; the kid's phone shows it (rules version ${done.version}).`,
      );
      return;
    }
    case "parent-number": {
      const row = phone();
      const remove = flags.get("remove");
      if (remove !== undefined) {
        if (typeof remove !== "string") throw new CliError(`Usage: parent-number "<phone>" --remove <name>`);
        const done = removePhoneParentNumber(ctx, row.id, remove, server);
        if (!done.result.removed) throw new CliError(`${row.name}'s emergency card has no number called ${remove}.`);
        io.out(`${row.name}: ${remove} is off the emergency card (rules version ${done.version}).`);
        return;
      }
      const name = flags.get("name");
      const number = flags.get("number");
      if (typeof name !== "string" || typeof number !== "string") throw new CliError(`Usage: parent-number "<phone>" --name <name> --number <E.164>, or --remove <name>`);
      const done = putPhoneParentNumber(ctx, row.id, { name, number }, server);
      io.out(`${row.name}: the emergency card lists ${done.result.numbers.map((p) => `${p.name} (${p.number})`).join(", ")} (rules version ${done.version}).`);
      return;
    }
    case "kid-number": {
      const row = phone();
      const number = flags.has("clear") ? null : (positional[1] ?? "").replace(/[\s().-]/g, "");
      if (number === "") throw new CliError(`Usage: kid-number "<phone>" <E.164>, like +15555550123, or --clear`);
      setKidNumber(ctx, row.id, number, server);
      io.out(number === null ? `${row.name}: no number for "Call".` : `${row.name}: "Call" on a help request dials ${number}.`);
      return;
    }
    case "agent-offer": {
      const row = phone();
      const sha = positional[1] ?? "";
      if (!sha256Hex.safeParse(sha).success) throw new CliError(`Usage: agent-offer "<phone>" <sha256>, the SHA-256 that agent-add printed`);
      if (row.revoked_at !== null) throw new CliError(`${row.name} is disconnected, so it can't be updated.`);
      let done: ReturnType<typeof offerAgent>;
      try {
        done = offerAgent(ctx, row.id, sha, server);
      } catch (error) {
        if (error instanceof AgentFileError) throw new CliError(error.message);
        throw error;
      }
      io.out(`${row.name}: Belay ${versionWords(done.result.file)} is offered (rules version ${done.version}).`);
      if (done.result.notNewerThan !== null) {
        io.err(`The phone runs version ${done.result.notNewerThan}, which isn't older: Android won't install this one over it, so the phone won't get it.`);
      }
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}
