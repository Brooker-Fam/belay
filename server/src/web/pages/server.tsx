/**
 * The server's own health on the parent pages: the "This server" section of the Phones page
 * (backups, their checks, the restore drill, problems), and the daily summary in Settings.
 */
import type { FC } from "hono/jsx";
import { formatBytes } from "../../ops/backups.js";
import type { ServerHealth } from "../../ops/health.js";
import type { DigestSettings } from "../../ops/notify.js";
import { dayAndTime, hourLabel } from "../../ops/words.js";
import { formatAgo } from "../../time.js";
import { Csrf, Notice, PostButton, type View } from "../ui.js";

const STATUS: Record<ServerHealth["status"], { words: string; css: string }> = {
  ok: { words: "OK", css: "ok" },
  attention: { words: "Needs attention", css: "attention" },
  urgent: { words: "Needs you now", css: "silent" },
};

function percentFree(disk: NonNullable<ServerHealth["disk"]>): string {
  const share = disk.totalBytes ? disk.freeBytes / disk.totalBytes : 0;
  return share < 0.01 ? "less than 1%" : `${Math.floor(share * 100)}%`;
}

export const ServerCard: FC<{ view: View; health: ServerHealth }> = ({ view, health: h }) => {
  const status = STATUS[h.status];
  const last = h.lastBackup;
  const backupWords = last
    ? `${dayAndTime(last.startedAt, view.now, view.tz)}${last.bytes !== null ? ` (${formatBytes(last.bytes)}${last.encrypted ? ", encrypted" : ""})` : ""}`
    : "none yet";
  const verified = h.lastVerify ? `${formatAgo(h.lastVerify.at, view.now)}${h.lastVerify.ok ? "" : ", and it failed"}` : "never";
  return (
    <section id="server">
      <h2>This server</h2>
      {h.drillCopy && (
        <Notice kind="warn">
          This is a restore drill's scratch copy, restored {dayAndTime(h.drillCopy.at, view.now, view.tz)} from {h.drillCopy.from}. It sends no
          notifications. When you're done, remove it: <code>docker rm -f belay-drill && docker volume rm belay-drill</code>
        </Notice>
      )}
      <div class="card">
        <div class="row spread">
          <strong>Backups and health</strong>
          <span class={`status ${status.css}`}>{status.words}</span>
        </div>
        {h.problems.length > 0 && (
          <ul class="problems">
            {h.problems.map((p) => (
              <li class={p.urgent ? "tamper" : undefined}>{p.text}</li>
            ))}
          </ul>
        )}
        <p>
          Last backup: {backupWords}; last verified: {verified}.
        </p>
        {last && !last.encrypted && (
          <p class="small muted">
            Backups aren't encrypted. Before copying them off this machine, set a backup passphrase (docs/server.md, "Backups").
          </p>
        )}
        <p>
          {h.drillDue ? <strong>Time for a restore drill</strong> : "Restore drill"}
          {h.lastDrill ? `: the last one was ${formatAgo(h.lastDrill.at, view.now)}.` : ": there hasn't been one yet."} Every 3 months, restore the
          newest backup into a scratch server, sign in there, and check the phones are there. The steps are in docs/server.md ("Restore drill"),
          or run <code>restore-drill</code> on the server.
        </p>
        <p>
          <PostButton
            view={view}
            action="/server/drill"
            kind="quiet"
            confirm="Did you restore a backup into a scratch server, sign in there, and see the phones?"
          >
            We did a restore drill
          </PostButton>
        </p>
        <p class="small muted">
          Backups: every day after 2 AM, the newest 14 kept.
          {h.disk && ` Disk: ${percentFree(h.disk)} free (${formatBytes(h.disk.freeBytes)} of ${formatBytes(h.disk.totalBytes)}).`}
          {h.dbBytes !== null && ` Database: ${formatBytes(h.dbBytes)}.`}
        </p>
      </div>
    </section>
  );
};

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);

/** Settings → Notifications: the daily summary, on or off for this parent, at the family's hour. */
export const DigestCard: FC<{ view: View; digest: DigestSettings; meId: string; browsers: number }> = ({ view, digest, meId, browsers }) => (
  <form class="stack card" method="post" action="/settings/digest" id="digest">
    <Csrf view={view} />
    <h3>Daily summary</h3>
    <p>
      Once a day, Belay can send you a short notice of what needs you, like "2 things need you: a phone has been silent 14 hours, the last
      backup failed". It has counts and kinds of problems only: no phone's or app's name, and nothing the kid wrote.
    </p>
    <label class="check">
      <input type="checkbox" name="on" value="1" checked={digest.parents.includes(meId)} /> Send me the daily summary
    </label>
    <label for="digest-hour">At (the same time for every parent who gets it)</label>
    <select id="digest-hour" name="hour">
      {HOURS.map((hour) => (
        <option value={String(hour)} selected={hour === digest.hour}>
          {hourLabel(hour)}
        </option>
      ))}
    </select>
    <p class="small muted">
      It goes to the browsers where you turned notifications on{browsers === 0 ? ", and you haven't on any yet" : ""}.
    </p>
    <div>
      <button type="submit">Save</button>
    </div>
  </form>
);
