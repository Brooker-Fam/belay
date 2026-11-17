import type { FC } from "hono/jsx";
import type { AuditEntry } from "../../audit.js";
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
    case "ai.connected":
      return `connected ${str(d.client) || "an AI app"}`;
    case "ai.disconnected":
      return `disconnected ${str(d.client) || "an AI app"}`;
    case "token.created":
      return `made a personal access token, "${str(d.name)}"`;
    case "token.revoked":
      return `revoked the personal access token "${str(d.name)}"`;
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
