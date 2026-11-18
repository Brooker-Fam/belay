/**
 * Phase 3's network logging on the parent pages: the switch on the phone's page (a parent's alone:
 * no AI app can turn it on or off, or propose it), with the phone's private websites below it
 * (never noted, like 988's; a parent's alone too, and AI apps never see them), and the phone's
 * Network tab, shown while it's on: which websites and online services each app looked up, by
 * name, day by day, with how long the server keeps it. Domains and app names come from apps'
 * developers: escaped like everything in JSX, and shown as names, never as links.
 */
import type { FC } from "hono/jsx";
import { type Enforcement, LIMITS } from "../../device/schemas.js";
import type { DeviceView } from "../../family/devices.js";
import type { NetworkDayView, NetworkSettings, PrivateWebsite } from "../../family/network/store.js";
import type { Labels } from "../../family/screentime/words.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";
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
  /** The phone's private websites, never noted. */
  privateWebsites: PrivateWebsite[];
}

const WhatItIs: FC = () => (
  <p class="small">
    Belay on the phone notes which websites and online services each app looks up, by name (like example.com, never the pages, messages, searches or
    anything typed), and how many times a day, and sends only that. Never what the phone app, texting and the other apps Belay never blocks look up, and
    never 988's websites or this phone's private websites. Apps look names up by themselves too, for ads, updates and their own services: a name looked
    up isn't a page visited. Apps with their own way of looking names up, or a fixed address, aren't noted: it's a record, not a filter.
  </p>
);

/**
 * The phone's private websites, under network logging's switch: never noted, like 988's, with the
 * names under them. Only a parent sees which they are: the kid's phone says some websites are never
 * noted without naming them, and AI apps don't see them, or whether there are any.
 */
const PrivateWebsitesCard: FC<{ view: View; device: DeviceView; websites: PrivateWebsite[] }> = ({ view, device, websites }) => (
  <div class="card" id="private-websites">
    <p class="small">
      Belay never notes these websites, or any name under them, like 988's: a helpline's or a counselor's site the kid might use privately. The phone
      drops their lookups, the server drops any that arrive anyway, and adding one deletes what the server kept of it. Only you see which they are: while
      there are any, the kid's phone says some websites are never noted, without naming them (tell the kid yourself if they should know), and AI apps
      don't see them, or whether there are any.
    </p>
    <p class="small muted">Belay notes a website by its main name, so www.example.org/help makes all of example.org private.</p>
    {websites.length === 0 && <p class="muted">None.</p>}
    {websites.map((w) => (
      <div class="row spread">
        <span>
          <strong class="pkg">{w.domain}</strong>
          <span class="small muted">
            {" "}
            · added <Time ms={w.addedAt} tz={view.tz} />
            {w.addedBy ? ` by ${w.addedBy}` : ""}
          </span>
        </span>
        {device.revokedAt === null && (
          <PostButton view={view} action={`/devices/${device.id}/network/private/remove`} fields={{ domain: w.domain }} kind="quiet">
            Remove
          </PostButton>
        )}
      </div>
    ))}
    {device.revokedAt === null && websites.length < LIMITS.maxPrivateDomains && (
      <form class="row" method="post" action={`/devices/${device.id}/network/private`}>
        <Csrf view={view} />
        <input type="text" name="website" required maxlength={2000} placeholder="example.org" inputmode="url" aria-label="A private website" />
        <button type="submit" class="quiet">
          Add
        </button>
      </form>
    )}
  </div>
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

/** The phone page's network logging card, under Web, with the private websites below it. */
export const NetworkCard: FC<{ view: View; data: NetworkCardData }> = ({ view, data }) => {
  const { device, settings: s } = data;
  const on = s?.enabled === true;
  return (
    <>
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
      <h4>Private websites</h4>
      <PrivateWebsitesCard view={view} device={device} websites={data.privateWebsites} />
    </>
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
        {data.privateWebsites.length > 0 && (
          <p class="small">
            {data.privateWebsites.length === 1 ? "1 private website is" : `${data.privateWebsites.length} private websites are`} never noted here, with the
            names under {data.privateWebsites.length === 1 ? "it" : "them"}: <a href={`/devices/${device.id}#private-websites`}>change them on the phone's page</a>.
          </p>
        )}
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
