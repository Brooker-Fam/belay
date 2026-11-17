/**
 * Phase 3 on the parent pages: a phone's Screen time tab (today and the last days as simple bars,
 * drawn on the server: no JavaScript chart library), its Rules tab, and the rule editors a phone
 * and a stage share. Names the family wrote and app names are escaped like everything in JSX.
 */
import type { Child, FC } from "hono/jsx";
import type { App } from "../../family/apps.js";
import type { Command } from "../../family/commands.js";
import type { DeviceView } from "../../family/devices.js";
import { LIMITS, MORE_TIME_CHOICES } from "../../family/policy.js";
import type { MoreTimeView } from "../../family/requests.js";
import { type Weekday, WEEKDAYS, addDays, at, validDay } from "../../family/screentime/days.js";
import { dayPreview, previewDay, previewWords } from "../../family/screentime/preview.js";
import type { ExtraView, Limit, Origin, PhoneRules, RuleSet, Schedule, StageView } from "../../family/screentime/rules.js";
import { GAP_WORDS, type UsageDayView } from "../../family/screentime/usage.js";
import { type Labels, clock, days as daysWords, duration } from "../../family/screentime/words.js";
import type { Enforcement } from "../../device/schemas.js";
import { STATUS_WORDS } from "../../family/requests.js";
import { isValidTimeZone } from "../../time.js";
import { Csrf, Layout, Notice, PostButton, Time, type View } from "../ui.js";

const DAY_SHORT: Record<Weekday, string> = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_LONG: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const KIND_WORDS = { school: "School", bedtime: "Bedtime", custom: "Custom" } as const;

/** "Mon, Nov 16" for "2026-11-16". */
export function shortDay(day: string): string {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  const weekday = WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7] ?? "mon";
  return `${DAY_SHORT[weekday]}, ${MONTHS[m - 1] ?? ""} ${d}`;
}

/** A width class for a bar: 0 to 100, at least 1 for anything above zero. */
const width = (value: number, max: number) => `w${value <= 0 || max <= 0 ? 0 : Math.max(1, Math.min(100, Math.round((value / max) * 100)))}`;

// ── Tabs ─────────────────────────────────────────────────────────────

export const PhoneTabs: FC<{ view: View; device: DeviceView; current: "apps" | "usage" | "rules" | "agreement" | "location" | "calls" | "network" }> = ({
  device,
  current,
}) => (
  <nav class="tabs" aria-label="This phone">
    <a href={`/devices/${device.id}`} aria-current={current === "apps" ? "page" : undefined}>
      Apps and rules
    </a>
    <a href={`/devices/${device.id}/screen-time`} aria-current={current === "usage" ? "page" : undefined}>
      Screen time
    </a>
    <a href={`/devices/${device.id}/screen-time/rules`} aria-current={current === "rules" ? "page" : undefined}>
      Screen-time rules
    </a>
    <a href={`/devices/${device.id}/agreement`} aria-current={current === "agreement" ? "page" : undefined}>
      Agreement
    </a>
    <a href={`/devices/${device.id}/location`} aria-current={current === "location" ? "page" : undefined}>
      Location and help
    </a>
    <a href={`/devices/${device.id}/calls`} aria-current={current === "calls" ? "page" : undefined}>
      Calls
    </a>
    {/* Phase 3: only while network logging is on (and on its own page). */}
    {(device.networkLog || current === "network") && (
      <a href={`/devices/${device.id}/network`} aria-current={current === "network" ? "page" : undefined}>
        Network
      </a>
    )}
  </nav>
);

// ── Charts ───────────────────────────────────────────────────────────

const W = 480;
const BASE = 100;
const TOP = 8;
const COLUMN = W / 24;

/** A column grown from the baseline, its top (the data end) rounded. */
function columnPath(x: number, w: number, h: number): string {
  const r = Math.min(4, h, w / 2);
  const y = BASE - h;
  const n = (v: number) => Math.round(v * 10) / 10;
  return `M${n(x)},${BASE}V${n(y + r)}Q${n(x)},${n(y)} ${n(x + r)},${n(y)}H${n(x + w - r)}Q${n(x + w)},${n(y)} ${n(x + w)},${n(y + r)}V${BASE}Z`;
}

const hourWords = (h: number) => (h === 0 ? "12 am" : h < 12 ? `${h} am` : h === 12 ? "12 pm" : `${h - 12} pm`);

/** The local hours of a day that a time Belay couldn't count overlaps. */
function gapHours(day: UsageDayView, zone: string): Set<number> {
  const out = new Set<number>();
  for (let h = 0; h < 24; h++) {
    const start = at(day.day, h * 60, zone);
    const end = h === 23 ? at(addDays(day.day, 1), 0, zone) : at(day.day, (h + 1) * 60, zone);
    if (day.gaps.some((g) => g.from < end && g.to > start)) out.add(h);
  }
  return out;
}

/** Screen minutes in each hour of one day: one column an hour, hatched where Belay couldn't count. */
export const HourChart: FC<{ day: UsageDayView; zone: string }> = ({ day, zone }) => {
  const max = Math.max(60, ...day.byHour);
  const scale = (BASE - TOP) / max;
  const gaps = gapHours(day, isValidTimeZone(day.zone) ? day.zone : zone);
  return (
    <figure class="chart">
      <svg class="hours" viewBox={`0 0 ${W} ${BASE + 2}`} role="img" aria-label={`Screen minutes in each hour of ${shortDay(day.day)}`}>
        <defs>
          <pattern id="hatch" patternUnits="userSpaceOnUse" width="5" height="5" patternTransform="rotate(45)">
            <line class="hatch-line" x1="0" y1="0" x2="0" y2="5" />
          </pattern>
        </defs>
        <line class="grid" x1="0" x2={W} y1={BASE - 60 * scale} y2={BASE - 60 * scale} />
        <line class="grid" x1="0" x2={W} y1={BASE} y2={BASE} />
        {day.byHour.map((minutes, h) => (
          <g>
            <title>{`${hourWords(h)}: ${minutes} min${gaps.has(h) ? ". Belay couldn't count part of this hour" : ""}`}</title>
            <rect class="hit" x={h * COLUMN} y="0" width={COLUMN} height={BASE} />
            {gaps.has(h) && <rect class="gap-band" x={h * COLUMN + 1} y={TOP} width={COLUMN - 2} height={BASE - TOP} />}
            {minutes > 0 && <path class="col" d={columnPath(h * COLUMN + 1, COLUMN - 2, Math.max(1, minutes * scale))} />}
          </g>
        ))}
      </svg>
      <div class="axis" aria-hidden="true">
        <span>12 am</span>
        <span>6 am</span>
        <span>12 pm</span>
        <span>6 pm</span>
        <span>12 am</span>
      </div>
      <figcaption class="small muted">
        <span class="key used"></span>screen minutes in each hour (the line is a full hour)
        {gaps.size > 0 && (
          <>
            {" · "}
            <span class="key gap"></span>Belay couldn't count
          </>
        )}
      </figcaption>
      <details>
        <summary>As a table</summary>
        <table>
          <tr>
            <th>Hour</th>
            <th>Minutes</th>
          </tr>
          {day.byHour.map((m, h) => (
            <tr>
              <td>{hourWords(h)}</td>
              <td>{gaps.has(h) ? `${m} (Belay couldn't count part of it)` : m}</td>
            </tr>
          ))}
        </table>
      </details>
    </figure>
  );
};

/** How long Belay couldn't count in a day, and why, in a line. */
function gapLine(day: UsageDayView, view: View): Child {
  if (!day.gaps.length) return null;
  const ms = day.gaps.reduce((n, g) => n + Math.max(0, g.to - g.from), 0);
  const why = [...new Set(day.gaps.map((g) => GAP_WORDS[g.reason]))].join("; ");
  const [first] = day.gaps;
  return (
    <p class="note small muted">
      Belay couldn't count {duration(Math.round(ms / 60_000))}
      {day.gaps.length === 1 && first && (
        <>
          , from <Time ms={first.from} tz={view.tz} /> to <Time ms={first.to} tz={view.tz} />
        </>
      )}
      : {why}.
    </p>
  );
}

/** One bar per day, newest first; a day the phone sent nothing for is shown as unknown, not as zero. */
export const DayBars: FC<{ view: View; base: string; days: { day: string; usage: UsageDayView | null }[]; total: (day: string) => number | null; selected: string | null }> = ({
  view,
  base,
  days,
  total,
  selected,
}) => {
  const max = Math.max(1, ...days.map((d) => Math.max(d.usage?.screenMinutes ?? 0, total(d.day) ?? 0)));
  return (
    <div class="bars">
      {days.map(({ day, usage }) => {
        const limit = total(day);
        return (
          <>
            <div class="barrow">
              <span class="label">
                <a href={`${base}?day=${day}`} aria-current={selected === day ? "true" : undefined}>
                  {shortDay(day)}
                </a>
              </span>
              {usage ? (
                <span class="bar" role="img" aria-label={`${duration(usage.screenMinutes)} on ${shortDay(day)}`}>
                  <i class={width(usage.screenMinutes, max)}></i>
                </span>
              ) : (
                <span class="bar unknown">Not sent: unknown, not zero</span>
              )}
              <span class="value">
                {usage ? duration(usage.screenMinutes) : "–"}
                {usage && limit !== null && ` of ${duration(limit)}`}
                {usage && !usage.complete && " so far"}
              </span>
            </div>
            {usage && gapLine(usage, view)}
          </>
        );
      })}
    </div>
  );
};

/** Each app's minutes on one day, most used first. */
export const AppBars: FC<{ deviceId: string; day: UsageDayView; labels: Labels; known: ReadonlySet<string> }> = ({ deviceId, day, labels, known }) => {
  const max = Math.max(1, ...day.apps.map((a) => a.minutes));
  if (!day.apps.length) return <p class="muted small">No app was on the screen for a minute or more.</p>;
  return (
    <div class="bars">
      {day.apps.slice(0, 40).map((a) => (
        <div class="barrow">
          <span class="label">
            {known.has(a.package) ? <a href={`/devices/${deviceId}/apps/${encodeURIComponent(a.package)}`}>{labels(a.package)}</a> : labels(a.package)}
          </span>
          <span class="bar" role="img" aria-label={`${labels(a.package)}: ${duration(a.minutes)}`}>
            <i class={width(a.minutes, max)}></i>
          </span>
          <span class="value">
            {duration(a.minutes)} · {a.opens} open{a.opens === 1 ? "" : "s"}
          </span>
        </div>
      ))}
      {day.apps.length > 40 && <p class="small muted">And {day.apps.length - 40} more apps, with less time.</p>}
    </div>
  );
};

// ── The Screen time tab ──────────────────────────────────────────────

const STATE_WORDS = { open: "time left", used_up: "used up", extra: "used up; on extra time now" } as const;

/** What the phone said about today: each limit's time, the schedule on now. */
const TodayState: FC<{ view: View; report: NonNullable<Enforcement["screen_time"]>; names: (id: string) => string; schedules: (id: string) => string }> = ({
  view,
  report,
  names,
  schedules,
}) => (
  <>
    {!report.measured && (
      <Notice kind="warn">Usage access for Belay is turned off on the phone, so Belay can't count screen time. What happens then is under Screen-time rules.</Notice>
    )}
    {report.schedule && (
      <p>
        <strong>{schedules(report.schedule.id)}</strong> until <Time ms={report.schedule.until} tz={view.tz} />.
      </p>
    )}
    {report.limits.length > 0 && (
      <ul>
        {report.limits.map((l) => (
          <li>
            {names(l.id)}: {l.left != null && l.state === "open" ? `${duration(l.left)} left` : STATE_WORDS[l.state]}
            {l.used != null && <span class="muted small"> ({duration(l.used)} used)</span>}
          </li>
        ))}
      </ul>
    )}
    {(report.self_serve ?? []).length > 0 && (
      <p class="small muted">
        Taken without asking (self-serve) today: {(report.self_serve ?? []).map((t) => `${t.minutes} minutes`).join(", ")}.
      </p>
    )}
  </>
);

/** A "more time" request, answered right here. */
export const MoreTimeAnswer: FC<{ view: View; request: MoreTimeView; limitName: string; back: string }> = ({ view, request, limitName, back }) => (
  <form class="stack request" method="post" action={`/devices/${request.deviceId}/requests/${request.id}/answer`}>
    <Csrf view={view} />
    <input type="hidden" name="back" value={back} />
    <p class="small">
      <strong>{request.limitId === "*" ? "More screen time" : `More time for ${limitName}`}</strong>: {request.minutes} minutes, asked{" "}
      <Time ms={Math.min(request.askedAt, request.receivedAt)} tz={view.tz} /> · {STATUS_WORDS[request.status]}
    </p>
    {request.reason ? <blockquote class="kid">{request.reason}</blockquote> : <p class="muted small">They didn't say why.</p>}
    <label for={`note-${request.id}`} class="small">
      Your answer, shown on the phone (optional)
    </label>
    <textarea id={`note-${request.id}`} name="note" maxlength={LIMITS.answerNote}>
      {request.note ?? ""}
    </textarea>
    <div class="row">
      {MORE_TIME_CHOICES.map((m) => (
        <button type="submit" name="give" value={String(m)}>
          {m} minutes
        </button>
      ))}
      <button type="submit" name="answer" value="talk" class="quiet">
        Let's talk
      </button>
      <button type="submit" name="answer" value="declined" class="quiet">
        No
      </button>
    </div>
  </form>
);

export interface UsagePageData {
  device: DeviceView;
  phone: PhoneRules;
  /** The phone's day now, and the zone its days follow. */
  today: string;
  zone: string;
  /** The days shown, newest first, with what the phone sent for each. */
  days: { day: string; usage: UsageDayView | null }[];
  /** The day whose apps and hours are shown. */
  selected: UsageDayView | null;
  selectedDay: string;
  report: Enforcement["screen_time"] | null;
  labels: Labels;
  /** The apps the server knows on the phone, to link them. */
  known: ReadonlySet<string>;
  requests: MoreTimeView[];
  extraToday: ExtraView[];
  /** The last lock_now sent to the phone, and what it said. */
  lastLock: Command | null;
}

const LOCK_WORDS: Record<Command["state"], string> = {
  waiting: "sent; waiting for the phone",
  done: "the phone locked its screen",
  failed: "the phone couldn't lock its screen",
  expired: "the phone got it too late, so it didn't lock",
  not_done: "the phone didn't get it in time",
  replaced: "a newer one took its place",
};

/** Lock the phone now: a pause, and the screen locked once. The last one and how it went, in the phone's own words. */
const LockCard: FC<{ view: View; device: DeviceView; lastLock: Command | null }> = ({ view, device, lastLock }) => (
  <div class="card" id="lock">
    {lastLock && (
      <>
        <p class="small">
          Last sent <Time ms={lastLock.issuedAt} tz={view.tz} />: {LOCK_WORDS[lastLock.state]}
          {lastLock.resultAt !== null && (
            <>
              {" "}
              (<Time ms={lastLock.resultAt} tz={view.tz} />)
            </>
          )}
          .
        </p>
        {lastLock.state === "failed" && lastLock.problem && (
          <>
            <p class="small muted">Belay on the phone says:</p>
            <blockquote>{lastLock.problem}</blockquote>
          </>
        )}
      </>
    )}
    {device.revokedAt === null && (
      <form class="row" method="post" action={`/devices/${device.id}/lock`}>
        <Csrf view={view} />
        <label for="lock-minutes">Pause the phone and lock its screen now, for</label>
        <select id="lock-minutes" name="minutes">
          {[15, 30, 60, 120, 240].map((m) => (
            <option value={String(m)} selected={m === 30}>
              {duration(m)}
            </option>
          ))}
        </select>
        <input type="text" name="note" maxlength={LIMITS.pauseNote} placeholder="A note for the phone (optional)" aria-label="A note for the phone" />
        <button type="submit" class="quiet">
          Lock now
        </button>
      </form>
    )}
    <p class="small muted">Calls, texts, 911 and 988 still work. The screen locks if the phone gets this within 10 minutes.</p>
  </div>
);

export const ScreenTimePage: FC<{ view: View; data: UsagePageData; message?: string }> = ({ view, data, message }) => {
  const { device, phone } = data;
  const limitName = (id: string) => (id === "*" ? "every limit" : (phone.rules.limits.find((l) => l.id === id)?.name ?? "a limit that's gone"));
  const scheduleName = (id: string) => phone.rules.schedules.find((s) => s.id === id)?.name ?? "A schedule";
  const total = phone.rules.limits.find((l) => l.packages.includes("*"));
  const totalOn = (day: string): number | null => {
    if (!total || !validDay(day)) return null;
    const weekday = WEEKDAYS[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7] ?? "mon";
    return total.by_day?.[weekday] ?? total.minutes;
  };
  const base = `/devices/${device.id}/screen-time`;
  return (
    <Layout view={view} title={`${device.name}: screen time`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="usage" />
      {message && <Notice>{message}</Notice>}
      {!phone.settings.measure && (
        <Notice kind="warn">
          Measuring is off: Belay on the phone counts only to enforce its limits, and sends no minutes. Turn it on under{" "}
          <a href={`${base}/rules#measuring`}>Screen-time rules</a>.
        </Notice>
      )}
      {data.requests.length > 0 && (
        <>
          <h2>Asking for more time</h2>
          <div class="card">
            {data.requests.map((r) => (
              <MoreTimeAnswer view={view} request={r} limitName={limitName(r.limitId)} back="screen-time" />
            ))}
          </div>
        </>
      )}
      <h2>Today on the phone ({shortDay(data.today)})</h2>
      <div class="card">
        {data.report && data.report.day === data.today ? (
          <TodayState view={view} report={data.report} names={limitName} schedules={scheduleName} />
        ) : (
          <p class="muted">The phone hasn't reported today's screen time yet.</p>
        )}
        {data.extraToday.length > 0 && (
          <p class="small">
            Extra time today: {data.extraToday.map((e) => `${e.minutes} minutes for ${limitName(e.limit_id)}${e.givenBy ? ` (${e.givenBy})` : ""}`).join("; ")}.
          </p>
        )}
      </div>
      <h2>Lock now</h2>
      <LockCard view={view} device={device} lastLock={data.lastLock} />
      <h2>The last {data.days.length} days</h2>
      <p class="muted small">
        Screen on and unlocked, in the phone's days ({phone.settings.zone === "phone" ? `its own time zone, ${data.zone}` : data.zone}
        {phone.settings.day_starts !== "00:00" ? `, starting at ${clock(phone.settings.day_starts)}` : ""}). Calls and texting count here, but never show by app.
      </p>
      <div class="card">
        <DayBars view={view} base={base} days={data.days} total={totalOn} selected={data.selectedDay} />
      </div>
      <h2 id="day">{shortDay(data.selectedDay)}</h2>
      {data.selected ? (
        <div class="card">
          <p>
            {duration(data.selected.screenMinutes)}
            {!data.selected.complete && " so far"}, {data.selected.unlocks} unlock{data.selected.unlocks === 1 ? "" : "s"}. Counted up to{" "}
            <Time ms={data.selected.asOf} tz={view.tz} />.
          </p>
          <HourChart day={data.selected} zone={data.zone} />
          <h3>Apps</h3>
          <AppBars deviceId={device.id} day={data.selected} labels={data.labels} known={data.known} />
        </div>
      ) : (
        <p class="muted">The phone sent nothing for this day: that's unknown, not zero.</p>
      )}
      <p class="small muted">
        Belay keeps screen time for the months set in <a href="/settings">Settings</a>, on this server only.
      </p>
    </Layout>
  );
};

// ── Rule editors, for a phone and for a stage ────────────────────────

/** The apps to pick from: a phone's apps, or every phone's for a stage. */
export type AppChoice = Pick<App, "package" | "label">;

const AppPicker: FC<{ name: string; apps: AppChoice[]; picked: ReadonlySet<string>; id: string }> = ({ name, apps, picked, id }) => {
  const known = new Set(apps.map((a) => a.package));
  const others = [...picked].filter((p) => p !== "*" && !known.has(p)).sort();
  return (
    <fieldset>
      <legend>Apps</legend>
      {apps.length === 0 && <p class="muted small">No apps from the phone yet: type package names below.</p>}
      <div class="days-picker">
        {apps.map((a) => (
          <label>
            <input type="checkbox" name={name} value={a.package} checked={picked.has(a.package)} /> {a.label}
          </label>
        ))}
      </div>
      <label for={`${id}-more`} class="small">
        Other apps, by package name, one per line (like com.example.game)
      </label>
      <textarea id={`${id}-more`} name={`${name}_more`} autocapitalize="off" autocorrect="off" spellcheck={false}>
        {others.join("\n")}
      </textarea>
    </fieldset>
  );
};

const LimitFields: FC<{ limit: Limit | null; apps: AppChoice[]; id: string }> = ({ limit, apps, id }) => {
  const total = limit?.packages.includes("*") ?? false;
  return (
    <>
      {limit && <input type="hidden" name="id" value={limit.id} />}
      <label for={`${id}-name`}>Name, in your words</label>
      <input id={`${id}-name`} type="text" name="name" maxlength={60} value={limit?.name ?? ""} placeholder="Games" />
      <label class="check">
        <input type="radio" name="scope" value="apps" checked={!total} /> These apps share the minutes
      </label>
      <label class="check">
        <input type="radio" name="scope" value="total" checked={total} /> Every app (a daily total), except the exempt ones
      </label>
      <AppPicker name="app" apps={apps} picked={new Set(limit?.packages ?? [])} id={id} />
      <label for={`${id}-minutes`}>Minutes a day</label>
      <input id={`${id}-minutes`} type="number" name="minutes" min={0} max={1440} value={String(limit?.minutes ?? 60)} required />
      <fieldset>
        <legend>Other minutes on some days (optional; 0: not that day)</legend>
        <div class="by-day">
          {WEEKDAYS.map((d) => (
            <label>
              {DAY_LONG[d]}
              <input type="number" name={`day_${d}`} min={0} max={1440} value={limit?.by_day?.[d] !== undefined ? String(limit.by_day[d]) : ""} />
            </label>
          ))}
        </div>
      </fieldset>
    </>
  );
};

const DaysPicker: FC<{ picked: readonly Weekday[] }> = ({ picked }) => (
  <fieldset>
    <legend>Days it starts</legend>
    <div class="days-picker">
      {WEEKDAYS.map((d) => (
        <label>
          <input type="checkbox" name="days" value={d} checked={picked.includes(d)} /> {DAY_SHORT[d]}
        </label>
      ))}
    </div>
  </fieldset>
);

const ScheduleFields: FC<{ schedule: Schedule | null; apps: AppChoice[]; id: string }> = ({ schedule, apps, id }) => (
  <>
    {schedule && <input type="hidden" name="id" value={schedule.id} />}
    <label for={`${id}-kind`}>Kind</label>
    <select id={`${id}-kind`} name="kind">
      {(["school", "bedtime", "custom"] as const).map((k) => (
        <option value={k} selected={(schedule?.kind ?? "custom") === k}>
          {KIND_WORDS[k]}
        </option>
      ))}
    </select>
    <label for={`${id}-name`}>Name, in your words</label>
    <input id={`${id}-name`} type="text" name="name" maxlength={60} value={schedule?.name ?? ""} placeholder="Bedtime" />
    <DaysPicker picked={schedule?.days ?? [...WEEKDAYS]} />
    <div class="row">
      <label>
        From <input type="time" name="start" value={schedule?.start ?? "21:00"} required />
      </label>
      <label>
        To <input type="time" name="end" value={schedule?.end ?? "07:00"} required />
      </label>
    </div>
    <p class="muted small">In the phone's time. A "to" at or before "from" ends the next morning.</p>
    <label class="check">
      <input type="checkbox" name="lock" value="1" checked={schedule?.lock ?? false} /> Lock the screen when it starts
    </label>
    <details>
      <summary>Apps that stay open during it</summary>
      <AppPicker name="allow" apps={apps} picked={new Set(schedule?.allow ?? [])} id={`${id}-allow`} />
    </details>
    <label for={`${id}-skip`}>Days it doesn't start, like 2026-11-26 (one per line, optional)</label>
    <textarea id={`${id}-skip`} name="skip" autocapitalize="off" autocorrect="off" spellcheck={false}>
      {(schedule?.skip ?? []).join("\n")}
    </textarea>
  </>
);

const ORIGIN_CHIP: Record<Origin, Child> = {
  stage: <span class="chip stage">from the stage</span>,
  changed: <span class="chip changed">changed for this phone</span>,
  own: <span class="chip">this phone's own</span>,
};

/** "1 h a day; 2 h on Saturday and Sunday". */
export function limitMinutesWords(l: Limit): string {
  const others = new Map<number, Weekday[]>();
  for (const d of WEEKDAYS) {
    const m = l.by_day?.[d];
    if (m !== undefined && m !== l.minutes) others.set(m, [...(others.get(m) ?? []), d]);
  }
  const extra = [...others.entries()].map(([m, ds]) => `${m === 0 ? "none" : duration(m)} on ${daysWords(ds)}`);
  return [`${duration(l.minutes)} a day`, ...extra].join("; ");
}

/** "9:00 pm to 7:00 am, every day; locks the screen". */
export function scheduleWords(s: Schedule, labels: Labels): string {
  const parts = [`${clock(s.start)} to ${clock(s.end)}${s.end <= s.start ? " the next day" : ""}, ${daysWords(s.days)}`];
  if (s.lock) parts.push("locks the screen");
  if (s.allow.length) parts.push(`${s.allow.map(labels).join(", ")} stay${s.allow.length === 1 ? "s" : ""} open`);
  if (s.skip.length) parts.push(`not on ${s.skip.join(", ")}`);
  return parts.join("; ");
}

export interface EditorProps {
  view: View;
  /** Where the forms post: /devices/:id/screen-time/rules or /stages/:id. */
  base: string;
  rules: RuleSet;
  apps: AppChoice[];
  labels: Labels;
  /** For a phone on a stage: where each rule comes from, and the stage's ones removed for it. */
  origin?: (id: string) => Origin;
  removed?: { limits: Limit[]; schedules: Schedule[] };
}

export const LimitsCard: FC<EditorProps> = ({ view, base, rules, apps, labels, origin, removed }) => (
  <div class="card" id="limits">
    {rules.limits.length === 0 && <p class="muted">No time limits.</p>}
    {rules.limits.map((l) => {
      const total = l.packages.includes("*");
      const from = origin?.(l.id);
      return (
        <div class="rule">
          <div class="row spread">
            <span>
              <strong>{l.name}</strong> {from && ORIGIN_CHIP[from]}
            </span>
            <span class="row">
              {from === "changed" && (
                <PostButton view={view} action={`${base}/limits/${l.id}/reset`} kind="quiet">
                  Put back the stage's
                </PostButton>
              )}
              <PostButton view={view} action={`${base}/limits/${l.id}/remove`} kind="quiet" confirm={`Remove the limit ${l.name}?`}>
                Remove
              </PostButton>
            </span>
          </div>
          <p class="small">
            {total ? "Every app that isn't exempt (a daily total)" : l.packages.map(labels).join(", ")}: {limitMinutesWords(l)}
          </p>
          <details>
            <summary>Change it</summary>
            <form class="stack" method="post" action={`${base}/limits`}>
              <Csrf view={view} />
              <LimitFields limit={l} apps={apps} id={`limit-${l.id}`} />
              <p>
                <button type="submit">Save the limit</button>
              </p>
            </form>
          </details>
        </div>
      );
    })}
    {removed && removed.limits.length > 0 && (
      <p class="small muted">
        Removed from the stage's for this phone: {removed.limits.map((l) => l.name).join(", ")}.{" "}
        {removed.limits.map((l) => (
          <PostButton view={view} action={`${base}/limits/${l.id}/reset`} kind="quiet">
            Put back {l.name}
          </PostButton>
        ))}
      </p>
    )}
    <details>
      <summary>Add a limit</summary>
      <form class="stack" method="post" action={`${base}/limits`}>
        <Csrf view={view} />
        <LimitFields limit={null} apps={apps} id="limit-new" />
        <p>
          <button type="submit">Add the limit</button>
        </p>
      </form>
    </details>
  </div>
);

export const SchedulesCard: FC<EditorProps> = ({ view, base, rules, apps, labels, origin, removed }) => (
  <div class="card" id="schedules">
    {rules.schedules.length === 0 && <p class="muted">No schedules.</p>}
    {rules.schedules.map((s) => {
      const from = origin?.(s.id);
      return (
        <div class="rule">
          <div class="row spread">
            <span>
              <strong>{s.name}</strong> <span class="chip">{KIND_WORDS[s.kind]}</span> {from && ORIGIN_CHIP[from]}
            </span>
            <span class="row">
              {from === "changed" && (
                <PostButton view={view} action={`${base}/schedules/${s.id}/reset`} kind="quiet">
                  Put back the stage's
                </PostButton>
              )}
              <PostButton view={view} action={`${base}/schedules/${s.id}/remove`} kind="quiet" confirm={`Remove the schedule ${s.name}?`}>
                Remove
              </PostButton>
            </span>
          </div>
          <p class="small">{scheduleWords(s, labels)}</p>
          <details>
            <summary>Change it</summary>
            <form class="stack" method="post" action={`${base}/schedules`}>
              <Csrf view={view} />
              <ScheduleFields schedule={s} apps={apps} id={`schedule-${s.id}`} />
              <p>
                <button type="submit">Save the schedule</button>
              </p>
            </form>
          </details>
        </div>
      );
    })}
    {removed && removed.schedules.length > 0 && (
      <p class="small muted">
        Removed from the stage's for this phone: {removed.schedules.map((s) => s.name).join(", ")}.{" "}
        {removed.schedules.map((s) => (
          <PostButton view={view} action={`${base}/schedules/${s.id}/reset`} kind="quiet">
            Put back {s.name}
          </PostButton>
        ))}
      </p>
    )}
    <details>
      <summary>Add a schedule</summary>
      <form class="stack" method="post" action={`${base}/schedules`}>
        <Csrf view={view} />
        <ScheduleFields schedule={null} apps={apps} id="schedule-new" />
        <p>
          <button type="submit">Add the schedule</button>
        </p>
      </form>
    </details>
  </div>
);

/** Exempt apps, self-serve, "can't count" and warnings, in one form. */
export const OtherRulesCard: FC<EditorProps> = ({ view, base, rules, apps }) => (
  <form class="card stack" method="post" action={`${base}/other`} id="other">
    <Csrf view={view} />
    <fieldset>
      <legend>Exempt apps: never counted or paused (beyond the phone app, texting and Belay, which never are)</legend>
      <AppPicker name="exempt" apps={apps} picked={new Set(rules.exempt)} id="exempt" />
    </fieldset>
    <fieldset>
      <legend>Self-serve: extra minutes the kid may take without asking</legend>
      <label class="check">
        <input type="checkbox" name="self_serve" value="1" checked={rules.self_serve !== null} /> Allow it
      </label>
      <div class="row">
        <label>
          Minutes each time <input type="number" name="self_minutes" min={1} max={240} value={String(rules.self_serve?.minutes ?? 10)} />
        </label>
        <label>
          Times a day <input type="number" name="self_times" min={1} max={10} value={String(rules.self_serve?.times ?? 1)} />
        </label>
      </div>
    </fieldset>
    <fieldset>
      <legend>When Belay can't count (usage access is off)</legend>
      <label class="check">
        <input type="radio" name="if_unmeasured" value="pause_limited" checked={rules.if_unmeasured === "pause_limited"} /> Pause apps with a time limit
        until it can (recommended)
      </label>
      <label class="check">
        <input type="radio" name="if_unmeasured" value="keep_open" checked={rules.if_unmeasured === "keep_open"} /> Keep them open (a limit already used
        up stays used up)
      </label>
      <p class="muted small">Schedules work either way: they don't need counting.</p>
    </fieldset>
    <label for="warn">Warn the kid this many minutes before time's up or a schedule starts (0: no warning)</label>
    <input id="warn" type="number" name="warn_before" min={0} max={60} value={String(rules.warn_before)} />
    <p>
      <button type="submit">Save</button>
    </p>
  </form>
);

export const Preview: FC<{ rules: RuleSet }> = ({ rules }) => {
  const day = previewDay(rules);
  const school = rules.schedules.some((s) => s.kind === "school" && s.days.includes(day));
  return <p class="small">{previewWords(dayPreview(rules, day), school)}</p>;
};

// ── The Screen-time rules tab ────────────────────────────────────────

export interface RulesPageData {
  device: DeviceView;
  phone: PhoneRules;
  zone: string;
  stages: StageView[];
  /** What the next stage changes, as the kid sees it (the policy's stage.next.unlocks), and how to get there. */
  next: { name: string; unlocks: string[]; how: string | null } | null;
  apps: AppChoice[];
  labels: Labels;
  extraToday: ExtraView[];
  today: string;
  zones: string[];
}

export const RulesPage: FC<{ view: View; data: RulesPageData; message?: string; error?: string }> = ({ view, data, message, error }) => {
  const { device, phone } = data;
  const base = `/devices/${device.id}/screen-time/rules`;
  const editor: EditorProps = {
    view,
    base,
    rules: phone.rules,
    apps: data.apps,
    labels: data.labels,
    ...(phone.stage ? { origin: phone.origin, removed: phone.removedFromStage } : {}),
  };
  const changed = phone.stage !== null && (phone.own.limits.length > 0 || phone.own.schedules.length > 0 || phone.own.exempt.add.length + phone.own.exempt.remove.length > 0 || phone.own.self_serve !== undefined || phone.own.if_unmeasured !== null || phone.own.warn_before !== null);
  return (
    <Layout view={view} title={`${device.name}: screen-time rules`}>
      <h1>{device.name}</h1>
      <PhoneTabs view={view} device={device} current="rules" />
      {message && <Notice>{message}</Notice>}
      {error && <Notice kind="error">{error}</Notice>}
      <p class="muted">
        The phone enforces these by itself, offline too, within seconds of a change when it's online. Calls, texts, 911 and 988 always work, and
        so do the clock and the keyboard.
      </p>
      <div class="card">
        <Preview rules={phone.rules} />
      </div>

      <h2 id="stage">Stage</h2>
      <div class="card">
        {phone.stage ? (
          <p>
            On <strong>{phone.stage.stage.name}</strong> (stage {phone.stage.stage.number}) since <Time ms={phone.stage.since} tz={view.tz} />
            {changed && ", with changes for this phone"}.
          </p>
        ) : (
          <p>Not on a stage: these rules are this phone's own.</p>
        )}
        {data.next && (
          <>
            <p class="small">
              What the next stage, <strong>{data.next.name}</strong>, changes, as the kid sees it:
            </p>
            {data.next.unlocks.length ? (
              <ul class="small">
                {data.next.unlocks.map((u) => (
                  <li>{u}</li>
                ))}
              </ul>
            ) : (
              <p class="small muted">Nothing in the rules.</p>
            )}
            {data.next.how && (
              <>
                <p class="small muted">How to get there, in your words:</p>
                <blockquote>{data.next.how}</blockquote>
              </>
            )}
          </>
        )}
        {data.stages.length > 0 ? (
          <form class="row" method="post" action={`${base}/stage`}>
            <Csrf view={view} />
            <label for="stage-pick">Move to</label>
            <select id="stage-pick" name="stage">
              <option value="">No stage (keep these rules as the phone's own)</option>
              {data.stages.map((s) => (
                <option value={s.id} selected={phone.stage?.stage.id === s.id}>
                  {s.number}. {s.name}
                  {s.offBelay && " (the last stage: it blocks nothing)"}
                </option>
              ))}
            </select>
            <button type="submit" class="quiet">
              Move
            </button>
          </form>
        ) : (
          <p class="small muted">
            No stages yet. <a href="/stages">Make stages</a> to bundle rules the kid can work toward.
          </p>
        )}
        <p class="small muted">Moving to a stage gives the phone exactly that stage's rules: changes made for this phone alone are cleared.</p>
        {changed && (
          <PostButton view={view} action={`${base}/reset`} kind="quiet" confirm="Clear this phone's own changes, so it gets exactly the stage's rules?">
            Put back all of the stage's rules
          </PostButton>
        )}
      </div>

      <h2>Time limits</h2>
      <LimitsCard {...editor} />
      <h2>Schedules</h2>
      <SchedulesCard {...editor} />
      <h2>Exempt apps, self-serve and more</h2>
      <OtherRulesCard {...editor} />

      <h2 id="extra">Extra time today ({shortDay(data.today)})</h2>
      <div class="card">
        {data.extraToday.length ? (
          <ul>
            {data.extraToday.map((e) => (
              <li>
                {e.minutes} minutes for {e.limit_id === "*" ? "every limit" : (phone.rules.limits.find((l) => l.id === e.limit_id)?.name ?? "a limit that's gone")},{" "}
                {e.givenBy ? `by ${e.givenBy}` : "by the server's admin command"} <Time ms={e.givenAt} tz={view.tz} />
              </li>
            ))}
          </ul>
        ) : (
          <p class="muted small">None. Extra time lasts until the phone's day ends.</p>
        )}
        {phone.rules.limits.length > 0 && (
          <form class="row" method="post" action={`/devices/${device.id}/screen-time/extra`}>
            <Csrf view={view} />
            <label for="extra-limit">Give</label>
            <select id="extra-limit" name="limit">
              <option value="*">every limit</option>
              {phone.rules.limits.map((l) => (
                <option value={l.id}>{l.name}</option>
              ))}
            </select>
            {MORE_TIME_CHOICES.map((m) => (
              <button type="submit" name="minutes" value={String(m)} class="quiet">
                {m} more minutes
              </button>
            ))}
          </form>
        )}
      </div>

      <h2 id="measuring">Measuring and days</h2>
      <form class="card stack" method="post" action={`${base}/settings`}>
        <Csrf view={view} />
        <label class="check">
          <input type="checkbox" name="measure" value="1" checked={phone.settings.measure} /> Measure screen time: the phone sends how long each app is on
          its screen each day, how many times it's opened, when the phone is used, and how many times it's unlocked
        </label>
        <p class="muted small">
          Off, the phone still counts, on the phone, to enforce its limits, but sends no minutes. The kid's phone lists what you can see. AI apps you
          connect read it only while Screen time is on in <a href="/settings">Settings</a>. Turning measuring on or off is only ever a parent's choice.
        </p>
        <label for="zone">Days and schedules follow</label>
        <select id="zone" name="zone">
          <option value="phone" selected={phone.settings.zone === "phone"}>
            The phone's own time zone (now {data.zone})
          </option>
          {data.zones.map((z) => (
            <option value={z} selected={phone.settings.zone === z}>
              {z}
            </option>
          ))}
        </select>
        <label for="day-starts">A day's limits start again at</label>
        <input id="day-starts" type="time" name="day_starts" value={phone.settings.day_starts} required />
        <p>
          <button type="submit">Save</button>
        </p>
      </form>
    </Layout>
  );
};
