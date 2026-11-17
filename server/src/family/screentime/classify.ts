/**
 * Whether a change to screen-time rules tightens or loosens them (docs/design/phase3-screen-time.md,
 * "Tighten or loosen"). An AI app may apply a change only when every part of it tightens;
 * anything else is a proposal for a parent (Phase 2's rule). Turning measuring on or off is
 * neither: it's a parent's choice about collecting, never an AI app's, either way.
 *
 * The parts a stage bundles (limits, schedules, exempt apps, self-serve, "can't count",
 * warnings) are compared exactly as the phone's core/screentime/Stages.kt compares two stages,
 * with the same matching and the same effects, so the server's stage sentences and the phone's
 * agree. Tightening: a lower or new limit, more apps counting toward one, a schedule that starts
 * earlier or ends later (by the minutes of the week it holds), more days, fewer apps it lets
 * stay open, locking the screen, fewer exempt apps, less self-serve, pausing apps with a limit
 * when Belay can't count. The rest loosens; a change that does both counts as loosening.
 *
 * Beyond what a stage bundles, the server also compares what a parent can change on one phone:
 * a schedule's skip dates (one fewer tightens, one more loosens), names and kinds (neither),
 * the zone and when days start (loosen: they move every limit and schedule), measuring
 * (collection), a day's extra time (more loosens), and the stage (a lower one tightens).
 */
import type { ScreenTime } from "../../device/schemas.js";
import { WEEKDAYS, type Weekday, clockMinutes } from "./days.js";

type Limit = ScreenTime["limits"][number];
type Schedule = ScreenTime["schedules"][number];
type SelfServe = NonNullable<ScreenTime["self_serve"]>;
type IfUnmeasured = ScreenTime["if_unmeasured"];
type Extra = ScreenTime["extra"][number];

export type Effect = "tightens" | "loosens" | "neither";

/** One side of a change: a phone's rules, or a stage's. Left-out parts are the defaults. */
export interface RulesSide {
  limits?: Limit[];
  schedules?: Schedule[];
  exempt?: string[];
  if_unmeasured?: IfUnmeasured;
  self_serve?: SelfServe | null;
  warn_before?: number;
  measure?: boolean;
  zone?: string;
  day_starts?: string;
  extra?: Extra[];
  stage?: { number: number; name: string } | null;
}

interface Base {
  effect: Effect;
  /** The limit's or schedule's id in the newer rules (in the older ones for a removal). */
  about: string | null;
}

export type RuleChange = Base &
  (
    | { kind: "limit_minutes"; total: boolean; name: string; from: number; to: number; days: Weekday[] }
    | { kind: "limit_added"; total: boolean; name: string; minutes: number; days: Weekday[] }
    | { kind: "limit_removed"; total: boolean; name: string }
    | { kind: "limit_apps_added" | "limit_apps_removed"; name: string; apps: string[] }
    | { kind: "schedule_times"; name: string; from: { start: string; end: string }; to: { start: string; end: string } }
    | { kind: "schedule_days_added" | "schedule_days_removed"; name: string; days: Weekday[] }
    | { kind: "schedule_allows" | "schedule_no_longer_allows"; name: string; apps: string[] }
    | { kind: "schedule_locks" | "schedule_no_longer_locks"; name: string }
    | { kind: "schedule_added"; name: string; start: string; end: string; days: Weekday[] }
    | { kind: "schedule_removed"; name: string }
    | { kind: "exempt_added" | "exempt_removed"; apps: string[] }
    | { kind: "self_serve"; to: SelfServe | null }
    | { kind: "if_unmeasured"; to: IfUnmeasured }
    | { kind: "warn_before"; to: number }
    // What a stage doesn't bundle, so the phone's Stages.changes never lists it.
    | { kind: "limit_renamed" | "schedule_renamed"; from: string; to: string }
    | { kind: "schedule_kind"; name: string; to: Schedule["kind"] }
    | { kind: "schedule_skips_added" | "schedule_skips_removed"; name: string; dates: string[] }
    | { kind: "measure"; to: boolean }
    | { kind: "zone"; to: string }
    | { kind: "day_starts"; to: string }
    | { kind: "extra_added" | "extra_removed"; limit: string; minutes: number; day: string }
    | { kind: "stage"; from: { number: number; name: string } | null; to: { number: number; name: string } | null }
  );

/** The kinds the phone's Stages.changes lists, in its words: what a stage bundles. */
export const STAGE_KINDS: ReadonlySet<RuleChange["kind"]> = new Set([
  "limit_minutes",
  "limit_added",
  "limit_removed",
  "limit_apps_added",
  "limit_apps_removed",
  "schedule_times",
  "schedule_days_added",
  "schedule_days_removed",
  "schedule_allows",
  "schedule_no_longer_allows",
  "schedule_locks",
  "schedule_no_longer_locks",
  "schedule_added",
  "schedule_removed",
  "exempt_added",
  "exempt_removed",
  "self_serve",
  "if_unmeasured",
  "warn_before",
]);

export interface Classification {
  /** In order: limits, schedules, exempt apps, self-serve, "can't count", warnings, then the rest. */
  changes: RuleChange[];
  /** Nothing tightens or loosens: it's the same. */
  none: boolean;
  /** Every part tightens (and something does): an AI app may apply it. */
  onlyTightens: boolean;
  /** It turns measuring on or off: a parent's choice, never an AI app's, in either direction. */
  collection: boolean;
  /** "loosens" when any part does, "tightens" when every part does, else "neither"; "none" for no change. */
  effect: Effect | "none";
}

const DAY = 24 * 60;
const WEEK = 7 * DAY;

const isTotal = (l: Limit) => l.packages.includes("*");
const appsOf = (l: Limit): string[] => [...new Set(l.packages.filter((p) => p !== "*"))].sort();
const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const minus = (a: Iterable<string>, b: Iterable<string>): string[] => {
  const drop = new Set(b);
  return [...new Set(a)].filter((x) => !drop.has(x)).sort();
};
const fold = (name: string) => name.trim().toLowerCase();

function minutesByDay(l: Limit): Record<Weekday, number> {
  const out = {} as Record<Weekday, number>;
  for (const day of WEEKDAYS) {
    const value = l.by_day?.[day];
    out[day] = value !== undefined && value >= 0 && value <= DAY ? value : l.minutes;
  }
  return out;
}

/** Pairs from `before` and `after` by each test in turn, then what's left on each side (Stages.kt's `match`). */
function match<T>(before: T[], after: T[], tests: ((a: T, b: T) => boolean)[]): { pairs: [T, T][]; removed: T[]; added: T[] } {
  const pairs: [T, T][] = [];
  const left = [...before];
  const right = [...after];
  for (const test of tests) {
    for (const old of [...left]) {
      const index = right.findIndex((n) => test(old, n));
      if (index < 0) continue;
      const [found] = right.splice(index, 1);
      if (found === undefined) continue;
      pairs.push([old, found]);
      left.splice(left.indexOf(old), 1);
    }
  }
  return { pairs, removed: left, added: right };
}

/** Groups days Monday first by a key, in the order keys first appear (Kotlin's groupBy). */
function groupDays<K>(days: Weekday[], key: (d: Weekday) => K): [K, Weekday[]][] {
  const groups = new Map<string, [K, Weekday[]]>();
  for (const day of days) {
    const k = key(day);
    const id = JSON.stringify(k);
    const group = groups.get(id);
    if (group) group[1].push(day);
    else groups.set(id, [k, [day]]);
  }
  return [...groups.values()];
}

function limits(from: Limit[], to: Limit[]): RuleChange[] {
  const usable = (l: Limit) => l.minutes >= 0 && l.minutes <= DAY;
  const { pairs, removed, added } = match(from.filter(usable), to.filter(usable), [
    (a, b) => a.id === b.id && isTotal(a) === isTotal(b),
    (a, b) => isTotal(a) === isTotal(b) && sameList(appsOf(a), appsOf(b)),
    (a, b) => !isTotal(a) && !isTotal(b) && fold(a.name) === fold(b.name),
  ]);
  const out: RuleChange[] = [];
  for (const [old, now] of pairs) {
    const was = minutesByDay(old);
    const is = minutesByDay(now);
    const changed = WEEKDAYS.filter((d) => was[d] !== is[d]);
    for (const [[a, b], days] of groupDays(changed, (d) => [was[d], is[d]] as const)) {
      out.push({ kind: "limit_minutes", effect: b > a ? "loosens" : "tightens", about: now.id, total: isTotal(now), name: now.name, from: a, to: b, days });
    }
    const more = minus(appsOf(now), appsOf(old));
    const fewer = minus(appsOf(old), appsOf(now));
    if (more.length) out.push({ kind: "limit_apps_added", effect: "tightens", about: now.id, name: now.name, apps: more });
    if (fewer.length) out.push({ kind: "limit_apps_removed", effect: "loosens", about: now.id, name: now.name, apps: fewer });
  }
  for (const now of added) {
    const byDay = minutesByDay(now);
    for (const [minutes, days] of groupDays(WEEKDAYS as Weekday[], (d) => byDay[d])) {
      out.push({ kind: "limit_added", effect: "tightens", about: now.id, total: isTotal(now), name: now.name, minutes, days });
    }
  }
  for (const old of removed) out.push({ kind: "limit_removed", effect: "loosens", about: old.id, total: isTotal(old), name: old.name });
  return out;
}

/** A schedule the phone can read (Schedules.kt's ScheduleRule.of): unreadable times are ignored. */
interface ScheduleRule {
  wire: Schedule;
  start: number;
  end: number;
  days: Set<Weekday>;
}

const scheduleRule = (s: Schedule): ScheduleRule | null => {
  const start = clockMinutes(s.start);
  const end = clockMinutes(s.end);
  return start === null || end === null ? null : { wire: s, start, end, days: new Set(s.days) };
};

/** The minutes of the week a schedule holds, from each of its days' start. */
function coverage(days: Set<Weekday>, start: number, end: number): Uint8Array {
  const bits = new Uint8Array(WEEK);
  const to = end <= start ? end + DAY : end;
  for (const day of days) {
    const base = WEEKDAYS.indexOf(day) * DAY;
    for (let minute = start; minute < to; minute++) bits[(base + minute) % WEEK] = 1;
  }
  return bits;
}

function coverageEffect(before: Uint8Array, after: Uint8Array): Effect {
  let gains = false;
  let losses = false;
  for (let i = 0; i < WEEK; i++) {
    if (after[i] && !before[i]) gains = true;
    if (before[i] && !after[i]) losses = true;
  }
  if (!gains && !losses) return "neither";
  return losses ? "loosens" : "tightens";
}

const ordered = (days: Iterable<Weekday>): Weekday[] => {
  const set = new Set(days);
  return WEEKDAYS.filter((d) => set.has(d));
};

function schedules(from: Schedule[], to: Schedule[]): { stage: RuleChange[]; rest: RuleChange[] } {
  const before = from.map(scheduleRule).filter((s): s is ScheduleRule => s !== null);
  const after = to.map(scheduleRule).filter((s): s is ScheduleRule => s !== null);
  const named = match(before, after, [(a, b) => a.wire.id === b.wire.id, (a, b) => a.wire.kind === b.wire.kind && fold(a.wire.name) === fold(b.wire.name)]);
  // Then by kind, when each side has exactly one of that kind left.
  const one = (list: ScheduleRule[], kind: Schedule["kind"]) => list.filter((s) => s.wire.kind === kind).length === 1;
  const byKind = named.removed
    .filter((old) => one(named.removed, old.wire.kind) && one(named.added, old.wire.kind))
    .map((old): [ScheduleRule, ScheduleRule] => [old, named.added.find((s) => s.wire.kind === old.wire.kind) ?? old]);
  const pairs = [...named.pairs, ...byKind];
  const removed = named.removed.filter((s) => !byKind.some(([old]) => old === s));
  const added = named.added.filter((s) => !byKind.some(([, now]) => now === s));
  const stage: RuleChange[] = [];
  const rest: RuleChange[] = [];
  for (const [old, now] of pairs) {
    const name = now.wire.name;
    const about = now.wire.id;
    if (old.start !== now.start || old.end !== now.end) {
      const effect = coverageEffect(coverage(old.days, old.start, old.end), coverage(old.days, now.start, now.end));
      stage.push({ kind: "schedule_times", effect, about, name, from: { start: old.wire.start, end: old.wire.end }, to: { start: now.wire.start, end: now.wire.end } });
    }
    const moreDays = ordered([...now.days].filter((d) => !old.days.has(d)));
    const fewerDays = ordered([...old.days].filter((d) => !now.days.has(d)));
    if (moreDays.length) stage.push({ kind: "schedule_days_added", effect: "tightens", about, name, days: moreDays });
    if (fewerDays.length) stage.push({ kind: "schedule_days_removed", effect: "loosens", about, name, days: fewerDays });
    const allows = minus(now.wire.allow, old.wire.allow);
    const stops = minus(old.wire.allow, now.wire.allow);
    if (allows.length) stage.push({ kind: "schedule_allows", effect: "loosens", about, name, apps: allows });
    if (stops.length) stage.push({ kind: "schedule_no_longer_allows", effect: "tightens", about, name, apps: stops });
    if (old.wire.lock !== now.wire.lock) {
      stage.push(now.wire.lock ? { kind: "schedule_locks", effect: "tightens", about, name } : { kind: "schedule_no_longer_locks", effect: "loosens", about, name });
    }
    // What a stage doesn't bundle: names, kinds and days off.
    if (old.wire.name !== now.wire.name) rest.push({ kind: "schedule_renamed", effect: "neither", about, from: old.wire.name, to: now.wire.name });
    if (old.wire.kind !== now.wire.kind) rest.push({ kind: "schedule_kind", effect: "neither", about, name, to: now.wire.kind });
    const skipsAdded = minus(now.wire.skip, old.wire.skip);
    const skipsRemoved = minus(old.wire.skip, now.wire.skip);
    if (skipsAdded.length) rest.push({ kind: "schedule_skips_added", effect: "loosens", about, name, dates: skipsAdded });
    if (skipsRemoved.length) rest.push({ kind: "schedule_skips_removed", effect: "tightens", about, name, dates: skipsRemoved });
  }
  for (const now of added) {
    stage.push({ kind: "schedule_added", effect: "tightens", about: now.wire.id, name: now.wire.name, start: now.wire.start, end: now.wire.end, days: ordered(now.days) });
  }
  for (const old of removed) stage.push({ kind: "schedule_removed", effect: "loosens", about: old.wire.id, name: old.wire.name });
  return { stage, rest };
}

const usableSelfServe = (rule: SelfServe | null | undefined): SelfServe | null => (rule && rule.minutes > 0 && rule.times > 0 ? rule : null);

function selfServe(from: SelfServe | null | undefined, to: SelfServe | null | undefined): RuleChange[] {
  const before = usableSelfServe(from);
  const after = usableSelfServe(to);
  if (before?.minutes === after?.minutes && before?.times === after?.times) return [];
  if (after === null) return [{ kind: "self_serve", effect: "tightens", about: null, to: null }];
  const effect: Effect = before === null ? "loosens" : after.minutes <= before.minutes && after.times <= before.times ? "tightens" : "loosens";
  return [{ kind: "self_serve", effect, about: null, to: after }];
}

function extras(from: Extra[], to: Extra[]): RuleChange[] {
  const key = (e: Extra) => JSON.stringify([e.limit_id, e.minutes, e.day, e.package]);
  const before = new Map(from.map((e) => [e.id, e]));
  const after = new Map(to.map((e) => [e.id, e]));
  const out: RuleChange[] = [];
  for (const e of to) {
    const old = before.get(e.id);
    if (!old) out.push({ kind: "extra_added", effect: "loosens", about: e.id, limit: e.limit_id, minutes: e.minutes, day: e.day });
    else if (key(old) !== key(e)) {
      out.push({ kind: "extra_removed", effect: "tightens", about: old.id, limit: old.limit_id, minutes: old.minutes, day: old.day });
      out.push({ kind: "extra_added", effect: "loosens", about: e.id, limit: e.limit_id, minutes: e.minutes, day: e.day });
    }
  }
  for (const e of from) if (!after.has(e.id)) out.push({ kind: "extra_removed", effect: "tightens", about: e.id, limit: e.limit_id, minutes: e.minutes, day: e.day });
  return out;
}

function limitRenames(from: Limit[], to: Limit[]): RuleChange[] {
  const before = new Map(from.map((l) => [l.id, l]));
  return to.flatMap((now): RuleChange[] => {
    const old = before.get(now.id);
    return old && old.name !== now.name ? [{ kind: "limit_renamed", effect: "neither", about: now.id, from: old.name, to: now.name }] : [];
  });
}

/** Whether a change to screen-time rules tightens or loosens them: see the top of this file. */
export function classifyScreenTimeChange(before: RulesSide | null, after: RulesSide | null): Classification {
  const a = before ?? {};
  const b = after ?? {};
  // What a stage bundles, in the phone's order (Stages.changes).
  const sched = schedules(a.schedules ?? [], b.schedules ?? []);
  const changes: RuleChange[] = [...limits(a.limits ?? [], b.limits ?? []), ...sched.stage];
  const moreExempt = minus(b.exempt ?? [], a.exempt ?? []);
  const fewerExempt = minus(a.exempt ?? [], b.exempt ?? []);
  if (moreExempt.length) changes.push({ kind: "exempt_added", effect: "loosens", about: null, apps: moreExempt });
  if (fewerExempt.length) changes.push({ kind: "exempt_removed", effect: "tightens", about: null, apps: fewerExempt });
  changes.push(...selfServe(a.self_serve, b.self_serve));
  const unmeasured = b.if_unmeasured ?? "pause_limited";
  if ((a.if_unmeasured ?? "pause_limited") !== unmeasured) {
    changes.push({ kind: "if_unmeasured", effect: unmeasured === "keep_open" ? "loosens" : "tightens", about: null, to: unmeasured });
  }
  const warn = Math.max(0, b.warn_before ?? 5);
  if (Math.max(0, a.warn_before ?? 5) !== warn) changes.push({ kind: "warn_before", effect: "neither", about: null, to: warn });
  // What a parent changes on one phone besides.
  changes.push(...limitRenames(a.limits ?? [], b.limits ?? []), ...sched.rest);
  if ((a.measure ?? false) !== (b.measure ?? false)) changes.push({ kind: "measure", effect: "neither", about: null, to: b.measure ?? false });
  if ((a.zone ?? "phone") !== (b.zone ?? "phone")) changes.push({ kind: "zone", effect: "loosens", about: null, to: b.zone ?? "phone" });
  if ((a.day_starts ?? "00:00") !== (b.day_starts ?? "00:00")) changes.push({ kind: "day_starts", effect: "loosens", about: null, to: b.day_starts ?? "00:00" });
  changes.push(...extras(a.extra ?? [], b.extra ?? []));
  const fromStage = a.stage ?? null;
  const toStage = b.stage ?? null;
  if (fromStage?.number !== toStage?.number) {
    const lower = fromStage !== null && toStage !== null && toStage.number < fromStage.number;
    changes.push({ kind: "stage", effect: lower ? "tightens" : "loosens", about: null, from: fromStage, to: toStage });
  }
  const none = changes.length === 0;
  const onlyTightens = !none && changes.every((c) => c.effect === "tightens");
  return {
    changes,
    none,
    onlyTightens,
    collection: changes.some((c) => c.kind === "measure"),
    effect: none ? "none" : onlyTightens ? "tightens" : changes.some((c) => c.effect === "loosens") ? "loosens" : "neither",
  };
}

/** Only what the phone's Stages.changes lists, for the kid's "what changes at the next stage". */
export function stageChanges(before: RulesSide | null, after: RulesSide | null): RuleChange[] {
  return classifyScreenTimeChange(before, after).changes.filter((c) => STAGE_KINDS.has(c.kind));
}
