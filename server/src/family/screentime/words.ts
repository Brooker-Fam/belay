/**
 * Screen-time rules and their changes in plain English. For the kid (a stage's `unlocks`, which
 * the phone shows under "What changes at the next stage") they follow the drafts in the phone's
 * core/screentime/KidText.kt; for the parents (the Proposals page, MCP, the activity log) they
 * say the same about "the kid". Names of limits and schedules are the family's words, and app
 * names come from their developers: over MCP, these sentences go in `untrusted` fields.
 */
import { oneLine } from "../../text.js";
import type { RuleChange } from "./classify.js";
import { WEEKDAYS, type Weekday, clockMinutes } from "./days.js";

const DAY_NAMES: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

export const SCHEDULE_KIND_WORDS = { school: "school", bedtime: "bedtime", custom: "custom" } as const;

/** "1 h 30 min", "2 h", "45 min", "0 min". */
export function duration(minutes: number): string {
  const m = Math.max(0, Math.round(minutes));
  const hours = Math.floor(m / 60);
  const rest = m % 60;
  if (!hours) return `${rest} min`;
  return rest ? `${hours} h ${rest} min` : `${hours} h`;
}

/** "9:00 pm" for "21:00", "12:00 am" for midnight. */
export function clock(hhmm: string): string {
  const minutes = clockMinutes(hhmm);
  if (minutes === null) return hhmm;
  const h = Math.floor(minutes / 60);
  return `${h % 12 === 0 ? 12 : h % 12}:${String(minutes % 60).padStart(2, "0")} ${h < 12 ? "am" : "pm"}`;
}

/**
 * "every day", "Monday to Friday", "Sunday to Thursday" (days in a row, the week wrapping round),
 * "Saturday and Sunday", "Monday, Wednesday and Friday" (every day named).
 */
export function days(list: Iterable<Weekday>): string {
  const set = new Set(list);
  const picked = WEEKDAYS.filter((d) => set.has(d));
  if (picked.length === 7) return "every day";
  if (!picked.length) return "no days";
  // Where a run of days in a row starts: a day whose day before isn't picked.
  const start = WEEKDAYS.findIndex((d, i) => set.has(d) && !set.has(WEEKDAYS[(i + 6) % 7] ?? "sun"));
  const run = Array.from({ length: picked.length }, (_, k) => WEEKDAYS[(start + k) % 7] ?? "mon");
  if (run.every((d) => set.has(d))) {
    return run.length >= 3 ? `${DAY_NAMES[run[0] ?? "mon"]} to ${DAY_NAMES[run.at(-1) ?? "sun"]}` : list_(run.map((d) => DAY_NAMES[d]), 7);
  }
  return list_(picked.map((d) => DAY_NAMES[d]), 7);
}

/** "A", "A and B", "A, B and C", "A, B, C and 2 more". */
function list_(items: string[], max = 3): string {
  if (items.length <= 1) return items[0] ?? "";
  if (items.length > max + 1) return `${items.slice(0, max).join(", ")} and ${items.length - max} more`;
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`;
}

/** An app's name for a package: its label on the phone, when the server knows it. */
export type Labels = (pkg: string) => string;
export const packageNames: Labels = (pkg) => pkg;

const name = (text: string) => oneLine(text, 60) || "(no name)";
/** The apps by name ("Chess Club and Puzzle Pop"), or with no labels, only how many ("2 apps"). */
const apps = (packages: string[], label: Labels | null) =>
  label === null ? `${packages.length} app${packages.length === 1 ? "" : "s"}` : list_(packages.map((p) => oneLine(label(p), 40) || p));
/** Singular or plural verb for a list of apps. */
const verb = (packages: string[], one: string, many: string) => (packages.length === 1 ? one : many);
const times = (n: number) => (n === 1 ? "once" : n === 2 ? "twice" : `${n} times`);

export interface Audience {
  /** "kid": the phone's own words ("You can take…"); "parent": about the kid. */
  for: "kid" | "parent";
  /**
   * The apps' names; null names none and counts them ("2 apps"): for an AI app while a parent
   * keeps the apps on the phone from AI apps (the Apps category off).
   */
  label: Labels | null;
  /** The schedule kind and limit names of the ids a sentence names, for the parent's words about a phone. */
  limitName?: (id: string) => string | null;
}

/** One change in a sentence, at most 300 characters (the policy's limit for `unlocks`). */
export function changeSentence(change: RuleChange, audience: Audience): string {
  const label = audience.label;
  const kid = audience.for === "kid";
  const text = ((): string => {
    switch (change.kind) {
      case "limit_minutes":
        return change.total
          ? `Daily screen time goes from ${duration(change.from)} to ${duration(change.to)}, ${days(change.days)}`
          : `${name(change.name)}: ${duration(change.to)} a day instead of ${duration(change.from)}, ${days(change.days)}`;
      case "limit_added":
        return change.total
          ? `New daily screen time limit: ${duration(change.minutes)}, ${days(change.days)}`
          : `New limit: ${name(change.name)}, ${duration(change.minutes)} a day, ${days(change.days)}`;
      case "limit_removed":
        return change.total ? "No more daily screen time limit" : `No more time limit for ${name(change.name)}`;
      case "limit_apps_added":
        return `${apps(change.apps, label)} now ${verb(change.apps, "counts", "count")} toward ${name(change.name)}`;
      case "limit_apps_removed":
        return `${apps(change.apps, label)} no longer ${verb(change.apps, "counts", "count")} toward ${name(change.name)}`;
      case "schedule_times":
        return `${name(change.name)}: ${clock(change.to.start)} to ${clock(change.to.end)} instead of ${clock(change.from.start)} to ${clock(change.from.end)}`;
      case "schedule_days_added":
        return `${name(change.name)} also on ${days(change.days)}`;
      case "schedule_days_removed":
        return `No ${name(change.name)} on ${days(change.days)}`;
      case "schedule_allows":
        return `During ${name(change.name)}, ${apps(change.apps, label)} ${verb(change.apps, "stays", "stay")} open`;
      case "schedule_no_longer_allows":
        return `During ${name(change.name)}, ${apps(change.apps, label)} ${verb(change.apps, "is", "are")} paused too`;
      case "schedule_locks":
        return `${name(change.name)} locks the screen when it starts`;
      case "schedule_no_longer_locks":
        return `${name(change.name)} no longer locks the screen`;
      case "schedule_added":
        // The kid's words follow KidText's draft; a parent deciding on a proposal needs to know it locks.
        return `New: ${name(change.name)} from ${clock(change.start)} to ${clock(change.end)}, ${days(change.days)}${!kid && change.lock ? ", locking the screen when it starts" : ""}`;
      case "schedule_removed":
        return `No more ${name(change.name)}`;
      case "exempt_added":
        return `${apps(change.apps, label)} never ${verb(change.apps, "counts", "count")} toward a limit`;
      case "exempt_removed":
        return `${apps(change.apps, label)} ${verb(change.apps, "counts", "count")} toward limits again`;
      case "self_serve":
        if (change.to === null) return kid ? "No more taking extra minutes without asking" : "No more extra minutes without asking (self-serve)";
        return kid
          ? `You can take ${change.to.minutes} more minutes, ${times(change.to.times)} a day, without asking`
          : `The kid can take ${change.to.minutes} more minutes, ${times(change.to.times)} a day, without asking (self-serve)`;
      case "if_unmeasured":
        return change.to === "keep_open" ? "When Belay can't count, apps with a limit stay open" : "When Belay can't count, apps with a limit are paused";
      case "warn_before":
        return change.to === 0 ? "No warning before time's up or a schedule starts" : `A warning ${duration(change.to)} before time's up or a schedule starts`;
      case "limit_renamed":
        return `The limit ${name(change.from)} is now called ${name(change.to)}`;
      case "schedule_renamed":
        return `The schedule ${name(change.from)} is now called ${name(change.to)}`;
      case "schedule_kind":
        return `${name(change.name)} is now a ${SCHEDULE_KIND_WORDS[change.to]} schedule`;
      case "schedule_skips_added":
        return `${name(change.name)} doesn't start on ${list_(change.dates, 4)}`;
      case "schedule_skips_removed":
        return `${name(change.name)} starts on ${list_(change.dates, 4)} again`;
      case "measure":
        return change.to ? "Belay counts how long apps are used, and sends it to the family's server" : "Belay stops sending how long apps are used";
      case "zone":
        return `Days and schedules follow ${change.to === "phone" ? "the phone's time zone" : change.to}`;
      case "day_starts":
        return `A day's limits start again at ${clock(change.to)}`;
      case "extra_added":
      case "extra_removed": {
        const limit = change.limit === "*" ? "every limit" : (audience.limitName?.(change.limit) ?? "a limit");
        return `${change.kind === "extra_added" ? "Extra time" : "No more extra time"}: ${duration(change.minutes)} for ${name(limit)} on ${change.day}`;
      }
      case "stage":
        if (change.to === null) return `Off the stage ${name(change.from?.name ?? "")}: only this phone's own rules`;
        return change.from === null ? `On the stage ${name(change.to.name)}` : `From the stage ${name(change.from.name)} to ${name(change.to.name)}`;
    }
  })();
  return text.length > 300 ? `${text.slice(0, 299)}…` : text;
}

export const EFFECT_WORDS = { tightens: "tightens", loosens: "loosens", neither: "neither tightens nor loosens" } as const;
