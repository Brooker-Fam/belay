/**
 * "With these rules, a school day allows…": the times on one weekday when no schedule holds the
 * phone, and the minutes each limit gives that day, for the Rules page. As the phone's rules
 * work (core/screentime/Schedules.kt): a schedule runs from its start on each of its days to its
 * end, the next day when the end is at or before the start. Skip dates and the apps a schedule
 * leaves open are left out: it's a usual day, for most apps.
 */
import { type Weekday, WEEKDAYS, clockMinutes } from "./days.js";
import type { RuleSet } from "./rules.js";
import { clock, duration } from "./words.js";

const DAY = 24 * 60;

export interface DayPreview {
  day: Weekday;
  /** [from, to) in minutes after midnight, when no schedule holds the phone. */
  open: [number, number][];
  limits: { name: string; total: boolean; minutes: number }[];
}

/** The weekday to show: the first with a school schedule, else the first with any, else Monday. */
export function previewDay(rules: RuleSet): Weekday {
  const withKind = (kind?: string) => WEEKDAYS.find((d) => rules.schedules.some((s) => (kind === undefined || s.kind === kind) && s.days.includes(d)));
  return withKind("school") ?? withKind() ?? "mon";
}

export function dayPreview(rules: RuleSet, day: Weekday = previewDay(rules)): DayPreview {
  const held = new Uint8Array(DAY);
  const before = WEEKDAYS[(WEEKDAYS.indexOf(day) + 6) % 7] ?? "sun";
  for (const s of rules.schedules) {
    const start = clockMinutes(s.start);
    const end = clockMinutes(s.end);
    if (start === null || end === null) continue;
    const overnight = end <= start;
    if (s.days.includes(day)) held.fill(1, start, overnight ? DAY : end);
    if (overnight && s.days.includes(before)) held.fill(1, 0, end);
  }
  const open: [number, number][] = [];
  for (let m = 0; m < DAY; m++) {
    if (held[m]) continue;
    const from = m;
    while (m < DAY && !held[m]) m++;
    open.push([from, m]);
  }
  return {
    day,
    open,
    limits: rules.limits.map((l) => ({ name: l.name, total: l.packages.includes("*"), minutes: l.by_day?.[day] ?? l.minutes })),
  };
}

const DAY_NAMES: Record<Weekday, string> = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" };
const at = (m: number) => clock(`${String(Math.floor(m / 60) % 24).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

/** The preview in a sentence or two, for the parents. */
export function previewWords(p: DayPreview, school: boolean): string {
  const which = `${school ? "a school day" : "a day"} (${DAY_NAMES[p.day]})`;
  const times =
    p.open.length === 0
      ? "no time when apps are open: schedules hold the phone all day"
      : p.open.length === 1 && p.open[0]?.[0] === 0 && p.open[0][1] === DAY
        ? "apps open all day"
        : `apps open ${p.open.map(([a, b]) => `from ${at(a)} to ${at(b)}`).join(", ")}`;
  const limits = p.limits.map((l) => (l.total ? `${duration(l.minutes)} of screen time in all` : `${duration(l.minutes)} of ${l.name}`));
  const within = limits.length ? ` Within that: ${limits.join(", ")}.` : "";
  return `With these rules, ${which} has ${times}.${within} Calls, texts, 911 and 988 always work.`;
}
