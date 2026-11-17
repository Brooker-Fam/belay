import type { FC } from "hono/jsx";
import type { AuditEntry } from "../../audit.js";
import { hourLabel } from "../../ops/words.js";
import { dayKey, formatDayKey, formatTime } from "../../time.js";
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
  }
}

const str = (v: unknown): string => (typeof v === "string" || typeof v === "number" ? String(v) : "");

function what(e: AuditEntry): string {
  const d = e.detail ?? {};
  const device = e.deviceName ? ` (${e.deviceName})` : "";
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
    case "token.created":
      return `made a personal access token, "${str(d.name)}"`;
    case "token.revoked":
      return `revoked the personal access token "${str(d.name)}"`;
    case "push.subscribed":
      return `turned on notifications on ${str(d.browser) || "a browser"}`;
    case "push.unsubscribed":
      return `turned off notifications on ${str(d.browser) || "a browser"}`;
    case "request.made":
      return `asked for ${str(d.label) || str(d.package) || "an app"}${d.again === true ? " again" : ""}`;
    case "request.answered": {
      const answer = { approved: "approved", declined: "declined", talk: `said "let's talk" about` }[str(d.answer)] ?? "answered";
      return `${answer} the request for ${str(d.label) || str(d.package) || "an app"}${device}${str(d.note) ? `, noting: "${str(d.note)}"` : ""}`;
    }
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
      return `changed factory reset, debugging or reset protection${device}`;
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
      <p class="muted">Who did what: parents on the web, AI apps through MCP, and the phones.</p>
      <p>{includeReads ? <a href="/activity">Hide what AI apps read</a> : <a href="/activity?reads=1">Also show what AI apps read</a>}</p>
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
                  <strong>{who(e)}</strong> {what(e)}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      {next !== null && (
        <p>
          <a href={`/activity?${more.toString()}`}>Older</a>
        </p>
      )}
    </Layout>
  );
};
