import type { FC } from "hono/jsx";
import type { AuditEntry } from "../../audit.js";
import { AI_MIN_SCHEDULE_MINUTES } from "../../family/screentime/changes.js";
import { hourLabel } from "../../ops/words.js";
import { dayKey, formatDateTime, formatDayKey, formatTime } from "../../time.js";
import { Layout, Time, type View } from "../ui.js";

function who(e: AuditEntry): string {
  switch (e.actor) {
    case "parent":
      return `${e.parentName ?? "A former parent"} on the web`;
    case "ai":
      return `${e.clientName ?? "An AI app"} via MCP${e.parentName ? ` (${e.parentName}'s connection)` : ""}`;
    case "phone":
      return e.deviceName ?? "A phone";
    case "server":
      return "The server";
    case "caregiver":
      return `${e.caregiverName ?? "A caregiver"} (caregiver)`;
  }
}

/** Phase 12: what a parent let a caregiver do, in a few words each. */
const CAN_SHORT: Record<string, string> = { status: "the phone's status", pause: "pause and lock", help: "help requests", locate: "check where it is" };

/** "Grandma", the phones and what they may do, from a caregiver entry's detail. */
function caregiverWords(d: Record<string, unknown>): { name: string; phones: string; can: string } {
  const list = (v: unknown, words: (s: string) => string = (s) => s) => (Array.isArray(v) ? v.map(str).filter(Boolean).map(words).join(", ") : "");
  return { name: str(d.caregiver) || "a caregiver", phones: list(d.phones) || "no phone", can: list(d.can, (k) => CAN_SHORT[k] ?? k) || "nothing" };
}

const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

/** What an AI app tried that the server refused (mcp/limits.ts's aiRefused), after "it tried". */
function refusedWords(tool: string, why: string): string {
  if (tool === "change_screen_time") {
    if (why === "apps") return "to change screen time with apps while AI access to apps is off";
    return why === "short_schedule" ? `to add or change a schedule shorter than ${AI_MIN_SCHEDULE_MINUTES} minutes` : "a change to screen time that Belay doesn't allow an AI app";
  }
  switch (why) {
    case "numbers":
      return "to change calls with phone numbers while AI access to calls is off";
    case "parents_only":
      return "to turn calls on or off, record them or choose private numbers, which only a parent does";
    case "texts":
      return "to change who may text, which Belay doesn't manage yet";
    default:
      return "a change to calls that Belay doesn't allow an AI app";
  }
}

/** "0.4.0 (version 4)" from an entry's version_name and version_code. */
const version = (d: Record<string, unknown>): string => (str(d.version_name) ? `${str(d.version_name)} (version ${str(d.version_code)})` : `version ${str(d.version_code)}`);

function what(e: AuditEntry, tz: string): string {
  const d = e.detail ?? {};
  const device = e.deviceName ? ` (${e.deviceName})` : "";
  const until = typeof d.until === "number" ? formatDateTime(d.until, tz) : "the end they chose";
  switch (e.action) {
    case "parent.setup":
      return "set up Belay";
    case "parent.signed_in":
      return "signed in";
    case "parent.signed_out_everywhere":
      return "signed out on every browser";
    case "parent.password_changed":
      return "changed their password";
    case "parent.password_reset":
      return `reset the password of ${str(d.username) || "a parent"} (from the command line)`;
    case "parent.invited":
      return "invited another parent";
    case "parent.joined":
      return "joined as a parent";
    case "parent.removed":
      return `removed ${str(d.name) || "a parent"}`;
    case "code.created":
      return `made an enrollment code for ${str(d.name) || "a phone"}`;
    case "code.cancelled":
      return "cancelled an enrollment code";
    case "phone.enrolled":
      return `enrolled${str(d.model) ? ` (${str(d.model)})` : ""}`;
    case "phone.reconnected":
      return "reconnected";
    case "device.renamed":
      return `renamed a phone from ${str(d.from)} to ${str(d.to)}`;
    case "device.disconnected":
      return `disconnected ${str(d.name) || "a phone"}`;
    case "device.deleted":
      return `deleted ${str(d.name) || "a phone"} and its history`;
    case "apps.reviewed": {
      const labels = Array.isArray(d.apps) ? d.apps.map(str).join(", ") : "";
      return `marked ${labels || "apps"} reviewed${device}${str(d.note) ? `, noting: "${str(d.note)}"` : ""}`;
    }
    case "settings.changed":
      return "changed the settings";
    case "settings.digest":
      return d.on === true ? `turned their daily summary on${typeof d.hour === "number" ? `, at ${hourLabel(d.hour)}` : ""}` : "turned their daily summary off";
    case "start.hidden":
      return "hid Getting started on their Phones page";
    case "start.shown":
      return "brought Getting started back on their Phones page";
    case "backup.drill":
      return "did a restore drill: restored a backup into a scratch server, signed in and saw the phones";
    case "backup.verified":
      return `checked the backup ${str(d.file) || "file"}: ${d.ok === true ? "it restores" : `it doesn't restore${str(d.problem) ? ` (${str(d.problem)})` : ""}`}`;
    case "backup.restored":
      return `restored this database from ${str(d.file) || "a backup"}${d.drill === true ? ", as a restore drill's copy" : ""}`;
    case "ai.connected":
      return `connected ${str(d.client) || "an AI app"}`;
    case "ai.disconnected":
      return `disconnected ${str(d.client) || "an AI app"}`;
    case "ai.limited":
      return `was refused: it tried to ${d.what === "checks" ? "check where the phone is" : "pause or lock the phone"} more than ${str(d.limit)} times in an hour${device}`;
    case "ai.refused":
      return `was refused: it tried ${refusedWords(str(d.tool), str(d.why))}${device}`;
    case "caregiver.added": {
      const c = caregiverWords(d);
      return `added ${c.name} as a caregiver for ${c.phones} until ${until}, with ${c.can}`;
    }
    case "caregiver.changed": {
      const c = caregiverWords(d);
      return `changed the caregiver ${c.name}${str(d.from) ? ` (before: ${str(d.from)})` : ""}: ${c.phones}, with ${c.can}`;
    }
    case "caregiver.renewed":
      return d.again === true ? `gave ${caregiverWords(d).name} access again, until ${until}` : `renewed ${caregiverWords(d).name}'s access, until ${until}`;
    case "caregiver.ended":
      return `ended ${caregiverWords(d).name}'s access`;
    case "caregiver.access_ended":
      return `ended ${caregiverWords(d).name}'s access, at the end a parent chose`;
    case "caregiver.removed":
      return `removed the caregiver ${caregiverWords(d).name}`;
    case "caregiver.link":
      return `made a new sign-in link for ${caregiverWords(d).name}${d.joined === true ? ", to choose a new password" : ""}`;
    case "caregiver.joined":
      return d.again === true ? "chose a new password with a sign-in link" : "joined as a caregiver";
    case "caregiver.signed_in":
      return "signed in to their caregiver page";
    case "caregiver.limited":
      return `was refused: they tried to ${d.what === "checks" ? "check where the phone is" : "pause or lock the phone"} more than ${str(d.limit)} times in an hour${device}`;
    case "token.created":
      return `made a personal access token, "${str(d.name)}"`;
    case "token.revoked":
      return `revoked the personal access token "${str(d.name)}"`;
    case "push.subscribed":
      return `turned on notifications on ${str(d.browser) || "a browser"}`;
    case "push.unsubscribed":
      return `turned off notifications on ${str(d.browser) || "a browser"}`;
    case "request.made": {
      const withdrawn = d.withdrawn === true ? ", then withdrew it" : "";
      if (d.kind === "more_time") return `asked for ${str(d.minutes)} more minutes for ${str(d.limit) || "a limit"}${d.again === true ? " again" : ""}${withdrawn}`;
      if (d.kind === "agreement") {
        return d.answer === "agree" ? `agreed to version ${str(d.agreement_version)} of the family agreement` : `wants to talk about version ${str(d.agreement_version)} of the family agreement${withdrawn}`;
      }
      if (d.kind === "help") return `asked for help ("I need help")${d.shared_location === true ? ", sharing where the phone is" : ""}${withdrawn}`;
      if (d.kind === "talk") return `asked to talk ("Talk to my parent")${withdrawn}`;
      if (d.kind === "contact") return `asked to add ${str(d.contact) ? `"${str(d.contact)}"` : "a contact"}${d.again === true ? " again" : ""}${withdrawn}`;
      return `asked for ${str(d.label) || str(d.package) || "an app"}${d.again === true ? " again" : ""}${withdrawn}`;
    }
    case "request.withdrawn":
      return d.kind === "help" ? "withdrew a help request" : "withdrew a request while it waited";
    case "request.seen":
      return `saw the kid's help request${d.withdrawn === true ? " (the kid had withdrawn it)" : ""}${device}${str(d.note) ? `, noting: "${str(d.note)}"` : ""}`;
    case "request.answered": {
      const note = str(d.note) ? `, noting: "${str(d.note)}"` : "";
      if (d.kind === "more_time") {
        if (d.answer === "approved") return `gave ${str(d.minutes)} more minutes for ${str(d.limit) || "a limit"}, for ${str(d.day) || "today"}${device}${note}`;
        return `${d.answer === "talk" ? `said "let's talk" about` : "said no to"} more time for ${str(d.limit) || "a limit"}${device}${note}`;
      }
      if (d.kind === "agreement") return `answered the kid about version ${str(d.agreement_version)} of the family agreement${d.answer === "talk" ? `: "let's talk"` : ""}${device}${note}`;
      if (d.kind === "talk") return `answered the kid's "Talk to my parent"${d.answer === "talk" ? `: "let's talk"` : d.answer === "declined" ? ": not now" : ": got it"}${device}${note}`;
      if (d.kind === "contact") {
        const who = str(d.contact) ? `"${str(d.contact)}"` : "a contact";
        if (d.answer === "approved") return `approved the kid's request to add ${who}${d.existing === true ? ", a contact already" : ""}${device}${note}`;
        return `${d.answer === "talk" ? `said "let's talk" about` : "declined"} the kid's request to add ${who}${device}${note}`;
      }
      const answer = { approved: "approved", declined: "declined", talk: `said "let's talk" about` }[str(d.answer)] ?? "answered";
      return `${answer} the request for ${str(d.label) || str(d.package) || "an app"}${device}${note}`;
    }
    case "screen_time.changed": {
      const changes = Array.isArray(d.changes) ? d.changes.map(str).filter(Boolean).join("; ") : "";
      return `changed screen time${device}${d.proposal ? " (an AI app's proposal)" : ""}${changes ? `: ${changes}` : ""}`;
    }
    case "screen_time.measure":
      return `${d.on === true ? "turned on" : "turned off"} measuring screen time${device}`;
    case "network.on":
    case "network.off":
      return `${e.action === "network.on" ? "turned on" : "turned off"} network logging (which websites and services apps look up)${device}`;
    case "network.private_added":
    case "network.private_removed": {
      // A count, never a name: the activity log never says which websites are private.
      const n = typeof d.count === "number" && Number.isInteger(d.count) && d.count > 1 ? d.count : 1;
      const which = n === 1 ? "a website" : `${n} websites`;
      return e.action === "network.private_added" ? `made ${which} private: network logging never notes ${n === 1 ? "it" : "them"}${device}` : `took ${which} off the private websites${device}`;
    }
    case "mobile_data.measure_on":
    case "mobile_data.measure_off":
      return `${e.action === "mobile_data.measure_on" ? "turned on" : "turned off"} measuring mobile data (how much mobile data each app uses)${device}`;
    case "mobile_data.wifi_only_added":
    case "mobile_data.wifi_only_removed": {
      // App names are their developers' words: escaped like the rest, and never more than a few.
      const apps = Array.isArray(d.apps) ? d.apps.map(str).filter(Boolean) : [];
      const which = apps.length === 0 ? "an app" : apps.length <= 3 ? apps.join(", ") : `${apps.slice(0, 3).join(", ")} and ${apps.length - 3} more`;
      const approved = str(d.proposal) ? ", approving an AI app's proposal" : "";
      return e.action === "mobile_data.wifi_only_added" ? `made ${which} Wi-Fi only (no mobile data)${device}` : `let ${which} use mobile data again${approved}${device}`;
    }
    case "screen_time.settings":
      return `changed which time zone the phone's days follow, or when they start${device}`;
    case "stage.moved":
      if (!str(d.to)) return `took the phone off its stage${device}`;
      return `moved the phone to the stage ${str(d.to)}${device}${d.proposal ? " (an AI app's proposal)" : ""}`;
    case "stage.created":
      return `added the stage ${str(d.stage)}`;
    case "stage.changed": {
      const changes = Array.isArray(d.changes) ? d.changes.map(str).filter(Boolean).join("; ") : "";
      return `changed the stage ${str(d.stage)}${typeof d.phones_changed === "number" && d.phones_changed > 0 ? ` (${str(d.phones_changed)} phone${d.phones_changed === 1 ? "" : "s"} got it)` : ""}${changes ? `: ${changes}` : ""}`;
    }
    case "stage.deleted":
      return `deleted the stage ${str(d.stage)}`;
    case "extra.given":
      return `gave ${str(d.minutes)} more minutes for ${str(d.limit) || "a limit"}, for ${str(d.day) || "today"}${device}`;
    case "agreement.saved":
      // Entries from before agreement_version carry only the rules' version, which isn't the agreement's.
      return d.agreement_version === undefined ? `wrote the family agreement${device}` : `wrote version ${str(d.agreement_version)} of the family agreement${device}`;
    case "app.allowed":
    case "app.blocked":
    case "app.undecided": {
      const verb = e.action === "app.allowed" ? "allowed" : e.action === "app.blocked" ? "blocked" : "cleared the decision on";
      const ahead = d.before_install === true ? " (not on the phone)" : "";
      return `${verb} ${str(d.label) || str(d.package) || "an app"}${ahead}${device}${str(d.proposal) ? " (an AI app's proposal)" : ""}${str(d.note) ? `, noting: "${str(d.note)}"` : ""}`;
    }
    case "apps.pre_blocks_cleared":
      return `cleared ${str(d.count) || "the"} app${d.count === 1 ? "" : "s"} AI apps blocked before install${device}`;
    case "policy.protected":
      return `turned protection on${device}`;
    case "policy.unprotected":
      return `turned protection off${device}`;
    case "policy.new_apps":
      return d.mode === "ask" ? `made new apps wait for a parent's approval${device}` : `let new apps run without asking${device}`;
    case "phone.paused":
      if (d.kept === true) return `asked to pause the phone${device}, which was already paused at least that long: nothing changed`;
      return `paused the phone${device}${typeof d.until === "number" ? "" : " until a parent resumes it"}`;
    case "phone.resumed":
      return `resumed the phone${device}`;
    case "policy.restrictions":
      return `changed the locked settings${device}`;
    case "policy.hardening":
      return `changed factory reset, debugging, reset protection or the accounts Play may use${device}`;
    case "policy.maintenance":
      return `turned on maintenance mode${device}`;
    case "policy.maintenance_ended":
      return `ended maintenance mode${device}`;
    case "policy.web":
      return `changed the web filter or Chrome settings${device}`;
    case "policy.support_message":
      return `changed the message on blocked-app screens${device}`;
    case "proposal.created":
      return `proposed: ${str(d.change) || "a change"}${device}`;
    case "proposal.approved":
      return `approved ${str(d.client) || "an AI app"}'s proposal: ${str(d.change)}${device}`;
    case "proposal.rejected":
      return `rejected ${str(d.client) || "an AI app"}'s proposal: ${str(d.change)}${device}`;
    case "proposal.outdated":
      return `approved ${str(d.client) || "an AI app"}'s proposal, but it was out of date, so nothing changed: ${str(d.change)}${device}`;
    case "agent.added":
      return `added Belay ${version(d)} to the server`;
    case "agent.offered":
      return `offered Belay ${version(d)}${device}`;
    case "agent.withdrawn":
      return `stopped offering Belay ${version(d)}${device}`;
    case "agent.update_failed":
      return `couldn't install Belay ${version(d)}`;
    case "agent.updated":
      return `updated Belay to ${version(d)}`;
    case "recovery.made":
      return `made a new recovery key${device}`;
    case "recovery.used":
      return "had its recovery key typed in, opening repair access for 24 hours";
    case "command.issued":
      if (d.kind === "locate_now") return `checked where the phone is${device}`;
      return d.kind === "lock_now" ? `locked the phone's screen${device}` : `asked the phone to remove every other user and profile${device}`;
    case "command.done":
      if (d.kind === "locate_now") return "sent where it is, for a check";
      // The phone says so when it has it, during a call too: its time says nothing of a call (the fifth review's F2).
      return d.kind === "lock_now" ? "got a request to lock its screen: it locks at once, or about 2 minutes after a call ends" : "removed every other user and profile, as a parent asked";
    case "command.failed":
      if (d.kind === "locate_now") return "couldn't find where it is, for a check";
      return d.kind === "lock_now" ? "couldn't lock its screen" : "couldn't remove the other users and profiles";
    case "command.expired":
      if (d.kind === "locate_now") return "got a check too late, so didn't send where it is";
      return d.kind === "lock_now" ? "got a request to lock its screen too late, so didn't" : "got a parent's request to remove other users too late, so didn't run it";
    case "location.changed": {
      const what =
        d.mode === "off" ? "off" : d.mode === "on_demand" ? "on demand (only when a parent checks)" : `every ${str(d.every_minutes)} minutes`;
      return `set where the phone shares its location to ${what}${d.keep_on === true && d.mode !== "off" ? ", kept on" : ""}${d.provider === "fused" ? ", with Android's combined provider" : ""}${device}`;
    }
    case "place.added":
      return `added the place ${str(d.place)}${device}`;
    case "place.changed":
      return `changed the place ${str(d.place)}${device}`;
    case "place.removed":
      return `removed the place ${str(d.place)}${device}`;
    case "lost.on":
      return `put the phone in lost mode${device}`;
    case "lost.changed":
      return `changed lost mode's message${device}`;
    case "lost.off":
      return `turned lost mode off${device}`;
    case "help.kid_number":
      return d.set === true ? `set the kid's number for "Call"${device}` : `cleared the kid's number for "Call"${device}`;
    case "help.parent_numbers":
      return d.family === true ? `made the emergency card use the family's numbers${device}` : `changed the numbers on the emergency card${device}`;
    case "calls.on":
    case "calls.off":
    case "calls.changed": {
      const changes = Array.isArray(d.changes) ? d.changes.map(str).filter(Boolean).join("; ") : "";
      const verb = e.action === "calls.on" ? "turned calls on" : e.action === "calls.off" ? "turned calls off" : "changed calls";
      const unblocked = Array.isArray(d.unblocked) && d.unblocked.length ? ` (unblocked ${d.unblocked.map(str).join(", ")}: a contact's number now)` : "";
      const why = str(d.proposal) ? " (an AI app's proposal)" : str(d.request) ? " (the kid's request)" : "";
      return `${verb}${device}${why}${changes && e.action === "calls.changed" ? `: ${changes}` : ""}${unblocked}`;
    }
    default:
      if (e.action === "ai.read") return `read ${str(d.what) || "data"}${device}`;
      return e.action;
  }
}

export const ActivityPage: FC<{ view: View; entries: AuditEntry[]; includeReads: boolean; next: number | null }> = ({ view, entries, includeReads, next }) => {
  const days: { key: string; entries: AuditEntry[] }[] = [];
  for (const e of entries) {
    const key = dayKey(e.at, view.tz);
    const last = days.at(-1);
    if (last?.key === key) last.entries.push(e);
    else days.push({ key, entries: [e] });
  }
  const more = new URLSearchParams();
  if (includeReads) more.set("reads", "1");
  if (next !== null) more.set("before", String(next));
  return (
    <Layout view={view} title="Activity">
      <h1>Activity</h1>
      <p class="muted">Who did what: parents on the web, AI apps through MCP, caregivers, and the phones.</p>
      <p>
        {includeReads ? (
          <a class="go" href="/activity">
            Hide what AI apps read
          </a>
        ) : (
          <a class="go" href="/activity?reads=1">
            Also show what AI apps read
          </a>
        )}
      </p>
      {days.length === 0 && <p class="muted">Nothing yet.</p>}
      {days.map((day) => (
        <section class="day">
          <h2>{formatDayKey(day.key)}</h2>
          <div class="card">
            {day.entries.map((e) => (
              <div class="change">
                <Time ms={e.at} tz={view.tz}>
                  {formatTime(e.at, view.tz)}
                </Time>
                <div>
                  <strong>{who(e)}</strong> {what(e, view.tz)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {next !== null && (
        <p>
          <a class="go" href={`/activity?${more.toString()}`}>
            Older
          </a>
        </p>
      )}
    </Layout>
  );
};
