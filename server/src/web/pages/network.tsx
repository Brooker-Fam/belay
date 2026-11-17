/**
 * Phase 3's network logging on the parent pages: the switch on the phone's page (a parent's alone:
 * no AI app can turn it on or off, or propose it), and the phone's Network tab, shown while it's
 * on: which websites and online services each app looked up, by name, day by day, with how long
 * the server keeps it. Domains and app names come from apps' developers: escaped like everything
 * in JSX, and shown as names, never as links.
 */
import type { FC } from "hono/jsx";
import type { Enforcement } from "../../device/schemas.js";
import type { DeviceView } from "../../family/devices.js";
import type { NetworkDayView, NetworkSettings } from "../../family/network/store.js";
import type { Labels } from "../../family/screentime/words.js";
import { Csrf, Layout, Notice, Time, type View } from "../ui.js";
import { PhoneTabs, shortDay } from "./screentime.js";

export interface NetworkCardData {
  device: DeviceView;
  settings: NetworkSettings | null;
  /** What Belay on the phone says (enforcement.network_log). */
  report: Enforcement["network_log"] | null;
  /** Days the server keeps for the phone now. */
  keptDays: number;
  /** The family's retention, in days. */
  networkDays: number;
  /** Whether AI apps may read it (the network scope). */
  aiReads: boolean;
}

const WhatItIs: FC = () => (
  <p class="small">
    Belay on the phone notes which websites and online services each app looks up, by name (like example.com, never the pages, messages, searches or
    anything typed), and how many times a day, and sends only that. Never what the phone app, texting and the other apps Belay never blocks look up, and
    never 988's websites. Apps look names up by themselves too, for ads, updates and their own services: a name looked up isn't a page visited. Apps
    with their own way of looking names up, or a fixed address, aren't noted: it's a record, not a filter.
  </p>
);

/** What Android and Belay on the phone say about logging now. */
const PhoneState: FC<{ settings: NetworkSettings | null; report: Enforcement["network_log"] | null }> = ({ settings, report }) => {
  if (!settings?.enabled) return null;
  if (!report) return <p class="small muted">The phone hasn't said yet whether it logs: it does with its next check-in.</p>;
  if (!report.enabled) return <Notice kind="warn">The phone says Android isn't logging: Belay on the phone says why under the phone's problems.</Notice>;
  if (report.paused) {
    return (
      <Notice kind="warn">
        Android paused network logging: it does while another user or profile is on the phone (Android's own Parental Controls make one), so Belay notes
        nothing until it's gone. See "Another user or profile" above.
      </Notice>
    );
  }
  return <p class="small">On the phone: Android is logging, and Belay sends each day's names as Android hands them over, every hour or two.</p>;
};

/** The phone page's network logging card, under Web. */
export const NetworkCard: FC<{ view: View; data: NetworkCardData }> = ({ view, data }) => {
  const { device, settings: s } = data;
  const on = s?.enabled === true;
  return (
    <div class="card" id="network">
      {on ? (
        <p>
          Network logging is on, since {s.enabledAt !== null ? <Time ms={s.enabledAt} tz={view.tz} /> : "a while"}.{" "}
          <a href={`/devices/${device.id}/network`}>See what apps looked up</a>.
        </p>
      ) : (
        <p>Network logging is off: Belay notes nothing about which websites and services apps look up.</p>
      )}
      <WhatItIs />
      <p class="small">
        The kid's phone lists it under "What your parent can see" while it's on, and Android shows its own notice that the phone "may monitor network
        traffic". The server keeps it {data.networkDays} days (<a href="/settings">Settings</a>).{" "}
        {data.aiReads ? "AI apps you connected may read it: you allowed that in Settings." : "AI apps can't read it unless you allow that in Settings."}
      </p>
      <PhoneState settings={s} report={data.report} />
      {!on && data.keptDays > 0 && (
        <p class="small muted">
          The server still keeps {data.keptDays} day{data.keptDays === 1 ? "" : "s"} of it from before, until {data.keptDays === 1 ? "it's" : "they're"}{" "}
          {data.networkDays} days old: <a href={`/devices/${device.id}/network`}>see them</a>, or stop collecting under Off belay to delete them now.
        </p>
      )}
      {device.revokedAt === null && (
        <form method="post" action={`/devices/${device.id}/network`} data-confirm={on ? undefined : "Turn network logging on? The phone notes which websites and services its apps look up."}>
          <Csrf view={view} />
          <input type="hidden" name="on" value={on ? "0" : "1"} />
          <button type="submit" class={on ? "quiet" : undefined}>
            {on ? "Turn network logging off" : "Turn network logging on"}
          </button>
        </form>
      )}
    </div>
  );
};

export interface NetworkPageData extends NetworkCardData {
  /** Newest first. */
  days: NetworkDayView[];
  labels: Labels;
}

/** One day: each app, most looked up first, with the names it looked up. */
const Day: FC<{ day: NetworkDayView; labels: Labels; view: View }> = ({ day, labels, view }) => {
  const apps = new Map<string, { lookups: number; domains: { domain: string; lookups: number }[] }>();
  for (const e of day.entries) {
    const app = apps.get(e.package) ?? { lookups: 0, domains: [] };
    app.lookups += e.lookups;
    app.domains.push({ domain: e.domain, lookups: e.lookups });
    apps.set(e.package, app);
  }
  const sorted = [...apps.entries()].sort((a, b) => b[1].lookups - a[1].lookups || (a[0] < b[0] ? -1 : 1));
  return (
    <div class="card">
      <h3 id={`day-${day.day}`}>{shortDay(day.day)}</h3>
      <p class="small muted">
        Counted up to <Time ms={day.asOf} tz={view.tz} />
        {day.zone !== view.tz ? `, in the phone's days (${day.zone})` : ""}.
      </p>
      {sorted.length === 0 && <p class="muted">Nothing the phone keeps was looked up that day.</p>}
      {sorted.map(([pkg, app]) => (
        <details>
          <summary>
            <strong>{labels(pkg)}</strong> <span class="small muted">{pkg}</span>: {app.lookups} lookup{app.lookups === 1 ? "" : "s"} of {app.domains.length}{" "}
            name{app.domains.length === 1 ? "" : "s"}
          </summary>
          <ul class="small">
            {app.domains.map((d) => (
              <li>
                {d.domain}: {d.lookups}
              </li>
            ))}
          </ul>
        </details>
      ))}
      {day.dropped > 0 && (
        <p class="small muted">
          And {day.dropped} more app and name pair{day.dropped === 1 ? "" : "s"}, each looked up less than these: the phone sends at most 5000 a day.
        </p>
      )}
    </div>
  );
};

/** A phone's Network tab. */
export const NetworkPage: FC<{ view: View; data: NetworkPageData; message?: string }> = ({ view, data, message }) => {
  const { device } = data;
  const on = data.settings?.enabled === true;
  return (
    <Layout view={view} title={`${device.name}: network`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="network" />
      {message && <Notice>{message}</Notice>}
      <h2>Websites and services apps looked up</h2>
      <div class="card">
        {on ? <p>Network logging is on. Each app's names, newest day first.</p> : <p>Network logging is off: nothing new arrives. Turn it on on the phone's page, under Web.</p>}
        <WhatItIs />
        <PhoneState settings={data.settings} report={data.report} />
        <p class="small muted">
          Belay keeps this {data.networkDays} days, on this server only (<a href="/settings">Settings</a>), then deletes it. Stop collecting, under Off belay
          on the phone's page, deletes it now.
        </p>
      </div>
      {data.days.length === 0 ? <p class="muted">Nothing yet: the phone sends each day's names as Android hands them over, every hour or two.</p> : data.days.map((d) => <Day day={d} labels={data.labels} view={view} />)}
    </Layout>
  );
};
