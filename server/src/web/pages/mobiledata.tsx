/**
 * Phase 13's Mobile data tab on the parent pages (docs/design/phase13-mobile-data.md, "On the
 * parent page"), always there: Wi-Fi only works without measuring. The Wi-Fi-only apps, each with
 * what the phone says about it and who added it, "Let it use mobile data again", and an Add form;
 * measuring's switch (a parent's alone: no AI app can turn it on or off, or propose it), how long
 * the server keeps it and whether AI apps may read it; and the days, as bars with a table of the
 * same numbers, a chosen day's apps the same way, each with "Make it Wi-Fi only". App names and
 * package names come from apps' developers: escaped like everything in JSX.
 */
import type { FC } from "hono/jsx";
import { type Enforcement, LIMITS } from "../../device/schemas.js";
import type { DeviceView } from "../../family/devices.js";
import { type MobileDataDayView, type MobileDataSettings, type WifiOnlyApp, bytesInWords } from "../../family/mobiledata/store.js";
import type { Labels } from "../../family/screentime/words.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";
import { PhoneTabs, shortDay } from "./screentime.js";

export interface MobileDataPageData {
  device: DeviceView;
  settings: MobileDataSettings | null;
  wifiOnly: WifiOnlyApp[];
  /** What Belay on the phone says Android keeps off mobile data now (enforcement.mobile_data). */
  report: Enforcement["mobile_data"] | null;
  /** The apps on the phone now that can be Wi-Fi only (not already, and not one the phone never blocks). */
  candidates: { package: string; label: string }[];
  /** The packages on the phone now. */
  installed: ReadonlySet<string>;
  /** Why the phone never blocks an app, or null. */
  never: (pkg: string) => string | null;
  /** Newest first: the last 30 days the server keeps. */
  days: MobileDataDayView[];
  /** The day whose apps are shown. */
  selected: MobileDataDayView | null;
  labels: Labels;
  /** The family's retention, in days. */
  mobileDataDays: number;
  /** Whether AI apps may read it (the mobile_data scope). */
  aiReads: boolean;
  /** Days the server keeps for the phone. */
  keptDays: number;
}

/** A width class for a bar: 0 to 100, at least 1 for anything above zero (app.css has them all). */
const width = (value: number, max: number) => `w${value <= 0 || max <= 0 ? 0 : Math.max(1, Math.min(100, Math.round((value / max) * 100)))}`;

const WhatItCovers: FC = () => (
  <p class="small">
    A Wi-Fi-only app can't use mobile data, or any other Wi-Fi that Android counts as metered, like another phone's hotspot. On other Wi-Fi it works as
    usual. Android keeps it off, on the phone, even offline; the kid sees which apps are Wi-Fi only under This phone's rules. It doesn't cover a download an
    app hands to Android's download manager, or app updates, which come through Play: to keep updates off mobile data too, make Google Play (
    <span class="pkg">com.android.vending</span>) Wi-Fi only, or set Play's own download preference to Wi-Fi only. Belay never makes the phone app, texting,
    the keyboard, the home screen or Android's own parts Wi-Fi only: calls, texts, 911 and 988 always work.
  </p>
);

/** What the phone says about one Wi-Fi-only app, in a few words. */
function phoneSays(data: MobileDataPageData, w: WifiOnlyApp): { words: string; warn: boolean } {
  const never = data.never(w.package);
  if (never) return { words: `The phone never blocks it, so it can't be Wi-Fi only: ${never}`, warn: true };
  if (data.report?.wifi_only.includes(w.package)) return { words: "On the phone: it can't use mobile data.", warn: false };
  if (!data.installed.has(w.package)) return { words: "Not on the phone: it's kept off mobile data once it's installed.", warn: false };
  const applied = data.device.enforcement?.policy_version ?? null;
  if (applied === null || applied < data.device.policyVersion) return { words: "Waiting for the phone to get it.", warn: false };
  return { words: "The phone didn't keep it off mobile data: a blocked app is kept off once it's unblocked; otherwise the phone's problems say why.", warn: true };
}

const WifiOnlyCard: FC<{ view: View; data: MobileDataPageData }> = ({ view, data }) => {
  const { device } = data;
  const open = device.revokedAt === null;
  return (
    <div class="card" id="wifi-only">
      {data.wifiOnly.length === 0 ? <p>No app is Wi-Fi only: every app may use mobile data.</p> : <p>These apps can't use mobile data:</p>}
      {data.wifiOnly.map((w) => {
        const says = phoneSays(data, w);
        const by = w.addedBy === "ai" ? `${w.clientName ?? "an AI app"} (${w.parentName ?? "a parent"}'s connection)` : w.addedBy === "server" ? "the server's admin command" : (w.parentName ?? "a former parent");
        return (
          <div class="row spread">
            <span>
              <strong>{data.labels(w.package)}</strong> <span class="small muted pkg">{w.package}</span>
              <br />
              {says.warn ? <span class="chip warn">{says.words}</span> : <span class="small">{says.words}</span>}
              <span class="small muted">
                {" "}
                Added <Time ms={w.addedAt} tz={view.tz} /> by {by}.
              </span>
            </span>
            {open && (
              <PostButton
                view={view}
                action={`/devices/${device.id}/mobile-data/wifi-only/remove`}
                fields={{ package: w.package }}
                kind="quiet"
                confirm={`Let ${data.labels(w.package)} use mobile data again?`}
              >
                Let it use mobile data again
              </PostButton>
            )}
          </div>
        );
      })}
      {open && data.wifiOnly.length < LIMITS.maxWifiOnly && data.candidates.length > 0 && (
        <form class="row" method="post" action={`/devices/${device.id}/mobile-data/wifi-only`}>
          <Csrf view={view} />
          <label for="wifi-only-app">Make an app Wi-Fi only</label>
          <select id="wifi-only-app" name="package">
            {data.candidates.map((a) => (
              <option value={a.package}>{a.label === a.package ? a.package : `${a.label} (${a.package})`}</option>
            ))}
          </select>
          <button type="submit">Make it Wi-Fi only</button>
        </form>
      )}
      {open && data.wifiOnly.length < LIMITS.maxWifiOnly && (
        <form class="row" method="post" action={`/devices/${device.id}/mobile-data/wifi-only`}>
          <Csrf view={view} />
          <label for="wifi-only-package">Or an app that isn't on the phone yet, by its package name</label>
          <input id="wifi-only-package" type="text" name="package" maxlength={255} placeholder="com.example.app" autocomplete="off" spellcheck={false} />
          <button type="submit" class="quiet">
            Add
          </button>
        </form>
      )}
      <WhatItCovers />
    </div>
  );
};

const MeasuringCard: FC<{ view: View; data: MobileDataPageData }> = ({ view, data }) => {
  const { device, settings: s } = data;
  const on = s?.measure === true;
  return (
    <div class="card" id="measuring">
      {on ? (
        <p>Measuring is on, since {s.measureSince !== null ? <Time ms={s.measureSince} tz={view.tz} /> : "a while"}: the phone sends how much mobile data each app uses each day.</p>
      ) : (
        <p>Measuring is off: the phone sends nothing about how much mobile data apps use.</p>
      )}
      <p class="small">
        Android counts it on the phone: each app's bytes on mobile data, and the phone's total on Wi-Fi, never which websites or Wi-Fi networks, or anything
        inside the traffic. The phone app, texting and Android's own parts are counted together, never one by one. The phone sends today about every hour,
        and each day once more when it's over, never anything from before measuring turned on. The kid's phone lists it under "What your parent can see" while
        it's on. The server keeps it {data.mobileDataDays} days (<a href="/settings">Settings</a>).{" "}
        {data.aiReads ? "AI apps you connected may read it: that's on in Settings." : "AI apps can't read it unless you allow that in Settings."}
      </p>
      {!on && data.keptDays > 0 && (
        <p class="small muted">
          The server still keeps {data.keptDays} day{data.keptDays === 1 ? "" : "s"} of it from before, until {data.keptDays === 1 ? "it's" : "they're"}{" "}
          {data.mobileDataDays} days old, or Stop collecting, under Off belay on the phone's page, deletes {data.keptDays === 1 ? "it" : "them"} now.
        </p>
      )}
      {!on && s !== null && s.dropped > 0 && (
        <p class="small muted">The phone sent {s.dropped} day{s.dropped === 1 ? "" : "s"} while measuring was off: the server didn't keep them.</p>
      )}
      {device.revokedAt === null && (
        <form method="post" action={`/devices/${device.id}/mobile-data/measure`} data-confirm={on ? undefined : "Measure mobile data? The phone sends how much mobile data each app uses each day."}>
          <Csrf view={view} />
          <input type="hidden" name="on" value={on ? "0" : "1"} />
          <button type="submit" class={on ? "quiet" : undefined}>
            {on ? "Stop measuring" : "Measure mobile data"}
          </button>
        </form>
      )}
    </div>
  );
};

/** A day's top app on mobile data, by name, or a dash. */
function topApp(day: MobileDataDayView, labels: Labels): string {
  const top = day.apps[0];
  return top ? `${labels(top.package)} (${bytesInWords(top.bytes)})` : "–";
}

/** The days, newest first: a bar each for mobile data, with a table of the same numbers. */
const DaysChart: FC<{ data: MobileDataPageData }> = ({ data }) => {
  const max = Math.max(1, ...data.days.map((d) => d.mobileBytes));
  const base = `/devices/${data.device.id}/mobile-data`;
  return (
    <figure class="chart">
      <div class="bars">
        {data.days.map((d) => (
          <div class="barrow">
            <span class="label">
              <a href={`${base}?day=${d.day}#day`} aria-current={data.selected?.day === d.day ? "true" : undefined}>
                {shortDay(d.day)}
              </a>
            </span>
            <span class="bar" role="img" aria-label={`${bytesInWords(d.mobileBytes)} of mobile data on ${shortDay(d.day)}`}>
              <i class={width(d.mobileBytes, max)}></i>
            </span>
            <span class="value">
              {bytesInWords(d.mobileBytes)}
              {!d.complete && " so far"}
            </span>
          </div>
        ))}
      </div>
      <figcaption class="small muted">Mobile data each day, as Android on the phone counted it. A day the phone sent nothing for isn't here: unknown, not zero.</figcaption>
      <table>
        <tr>
          <th>Day</th>
          <th>Mobile data</th>
          <th>Wi-Fi</th>
          <th>Top app on mobile data</th>
        </tr>
        {data.days.map((d) => (
          <tr>
            <td>
              <a href={`${base}?day=${d.day}#day`}>{shortDay(d.day)}</a>
              {d.complete ? "" : " (so far)"}
            </td>
            <td>{bytesInWords(d.mobileBytes)}</td>
            <td>{bytesInWords(d.wifiBytes)}</td>
            <td>{topApp(d, data.labels)}</td>
          </tr>
        ))}
      </table>
    </figure>
  );
};

/** One day's apps on mobile data, most first, as bars with a table, each with "Make it Wi-Fi only". */
const DayApps: FC<{ view: View; data: MobileDataPageData; day: MobileDataDayView }> = ({ view, data, day }) => {
  const listed = new Map(data.wifiOnly.map((w) => [w.package, w]));
  const lines = [
    ...day.apps.slice(0, 40).map((a) => ({ name: data.labels(a.package), pkg: a.package, bytes: a.bytes })),
    { name: "Android, calls and texting", pkg: null, bytes: day.androidBytes },
    ...(day.removedBytes ? [{ name: "Apps removed since", pkg: null, bytes: day.removedBytes }] : []),
    ...(day.hotspotBytes ? [{ name: "Other devices, through this phone's hotspot", pkg: null, bytes: day.hotspotBytes }] : []),
  ];
  const max = Math.max(1, ...lines.map((l) => l.bytes));
  const open = data.device.revokedAt === null;
  // A Wi-Fi-only app that still used mobile data on a day that began after it was added.
  const flagged = (pkg: string | null) => {
    const w = pkg ? listed.get(pkg) : undefined;
    return w !== undefined && day.from >= w.addedAt;
  };
  return (
    <div class="card" id="day">
      <h3>{shortDay(day.day)}</h3>
      <p class="small muted">
        {day.complete ? "The whole day" : <>Counted up to <Time ms={day.asOf} tz={view.tz} /></>}
        {day.zone !== view.tz ? `, in the phone's days (${day.zone})` : ""}: {bytesInWords(day.mobileBytes)} on mobile data, {bytesInWords(day.wifiBytes)} on Wi-Fi.
      </p>
      <div class="bars">
        {lines.map((l) => (
          <div class="barrow">
            <span class="label">{l.name}</span>
            <span class="bar" role="img" aria-label={`${l.name}: ${bytesInWords(l.bytes)}`}>
              <i class={width(l.bytes, max)}></i>
            </span>
            <span class="value">{bytesInWords(l.bytes)}</span>
          </div>
        ))}
      </div>
      {day.apps.length > 40 && <p class="small muted">And {day.apps.length - 40} more apps, each with less.</p>}
      <table>
        <tr>
          <th>App</th>
          <th>Mobile data</th>
          <th>Wi-Fi only</th>
        </tr>
        {lines.map((l) => (
          <tr>
            <td>
              {l.name}
              {l.pkg && <span class="small muted pkg"> {l.pkg}</span>}
            </td>
            <td>{bytesInWords(l.bytes)}</td>
            <td>
              {l.pkg === null ? (
                "–"
              ) : listed.has(l.pkg) ? (
                flagged(l.pkg) ? (
                  <>
                    <span class="chip warn">Used mobile data</span>{" "}
                    <span class="small muted">though it's Wi-Fi only: a download through Android's download manager, or the phone didn't have the rule yet</span>
                  </>
                ) : (
                  "Wi-Fi only"
                )
              ) : data.never(l.pkg) ? (
                "Never: the phone never blocks it"
              ) : open ? (
                <PostButton view={view} action={`/devices/${data.device.id}/mobile-data/wifi-only`} fields={{ package: l.pkg, back: day.day }} kind="quiet">
                  Make it Wi-Fi only
                </PostButton>
              ) : (
                "–"
              )}
            </td>
          </tr>
        ))}
      </table>
    </div>
  );
};

/** A phone's Mobile data tab. */
export const MobileDataPage: FC<{ view: View; data: MobileDataPageData; message?: string }> = ({ view, data, message }) => {
  const { device } = data;
  return (
    <Layout view={view} title={`${device.name}: mobile data`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="mobile_data" />
      {message && <Notice>{message}</Notice>}
      <h2>Wi-Fi only</h2>
      <WifiOnlyCard view={view} data={data} />
      <h2>Mobile data use</h2>
      <MeasuringCard view={view} data={data} />
      {data.days.length === 0 ? (
        <p class="muted">{data.settings?.measure ? "Nothing yet: the phone sends today's use within the hour." : "Nothing kept."}</p>
      ) : (
        <DaysChart data={data} />
      )}
      {data.selected && <DayApps view={view} data={data} day={data.selected} />}
    </Layout>
  );
};
