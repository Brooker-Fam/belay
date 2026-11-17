import type { FC } from "hono/jsx";
import { type Change, DETECTION_NAMES, versionText } from "../../family/apps.js";
import { dayKey, formatDayKey, formatTime } from "../../time.js";
import { Layout, Time, type View } from "../ui.js";

const KIND_WORDS: Record<Change["kind"], string> = {
  installed: "Installed",
  updated: "Updated",
  removed: "Removed",
  reinstalled: "Reinstalled",
};

function versions(c: Change): string {
  const from = versionText(c.fromName, c.fromCode);
  const to = versionText(c.toName, c.toCode);
  if (c.kind === "updated") return `${from} → ${to}`;
  if (c.kind === "removed") return from;
  return to;
}

export const ChangeLine: FC<{ change: Change; view: View; showDevice: boolean }> = ({ change: c, view, showDevice }) => (
  <div class="change">
    <Time ms={c.at} tz={view.tz}>
      {formatTime(c.at, view.tz)}
    </Time>
    <div>
      <span class={`kind ${c.kind}`}>{KIND_WORDS[c.kind]}</span>{" "}
      <a href={`/devices/${c.deviceId}/apps/${encodeURIComponent(c.package)}`}>{c.label}</a> <span class="small muted">{versions(c)}</span>
      {c.system && <span class="chip">system</span>}
      <div class="small muted">
        {showDevice && `${c.deviceName} · `}
        {c.backfilled ? "found by snapshot" : (DETECTION_NAMES[c.detection] ?? c.detection)}
        <span class="pkg"> · {c.package}</span>
      </div>
    </div>
  </div>
);

export const TimelinePage: FC<{
  view: View;
  changes: Change[];
  devices: { id: string; name: string }[];
  filter: { device: string; system: boolean };
  next: string | null;
}> = ({ view, changes, devices, filter, next }) => {
  const days: { key: string; changes: Change[] }[] = [];
  for (const c of changes) {
    const key = dayKey(c.at, view.tz);
    const last = days.at(-1);
    if (last?.key === key) last.changes.push(c);
    else days.push({ key, changes: [c] });
  }
  const query = new URLSearchParams();
  if (filter.device) query.set("device", filter.device);
  if (filter.system) query.set("system", "1");
  if (next) query.set("before", next);
  return (
    <Layout view={view} title="Timeline">
      <h1>Timeline</h1>
      <form class="filters" method="get" action="/timeline">
        <select name="device" aria-label="Phone">
          <option value="">All phones</option>
          {devices.map((d) => (
            <option value={d.id} selected={filter.device === d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <label class="check">
          <input type="checkbox" name="system" value="1" checked={filter.system} /> System app updates
        </label>
        <button type="submit" class="quiet">
          Show
        </button>
      </form>
      {days.length === 0 && <p class="muted">No app changes yet. The first app list from a phone is the starting point; changes after it show here.</p>}
      {days.map((day) => (
        <section class="day">
          <h2>{formatDayKey(day.key)}</h2>
          <div class="card">
            {day.changes.map((c) => (
              <ChangeLine change={c} view={view} showDevice={devices.length > 1} />
            ))}
          </div>
        </section>
      ))}
      {next && (
        <p>
          <a class="go" href={`/timeline?${query.toString()}`}>
            Older changes
          </a>
        </p>
      )}
    </Layout>
  );
};
