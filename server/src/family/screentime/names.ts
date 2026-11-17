/**
 * The names of limits and schedules. The kid's phone shows them as they are ("Time's up for Chess
 * Club today", "Schedule until 7:00 am"), so:
 *
 * - An AI app never writes one. A limit or schedule it adds, or renames, gets Belay's own name for
 *   what it is: a limit its apps, as the phone names them ("Chess Club", "Chess Club and Puzzle
 *   Pop", "Chess Club, Puzzle Pop and 3 more apps"; an app the phone never reported is counted,
 *   never named: "2 apps"), a daily total "Screen time", a schedule its kind ("School", "Bedtime",
 *   "Schedule"). Parents name rules as they like, on the parent page and with the CLI.
 * - A name Belay wrote follows what it names: a limit still called what Belay would call it gets
 *   the name for its apps as they are after a change, whoever made it.
 * - Every name, whoever wrote it, is one line without control, invisible or direction-changing
 *   characters (text.ts), at most 60 characters.
 */
import type { DB } from "../../db.js";
import { oneLine } from "../../text.js";
import type { Limit, RuleSet, Schedule } from "./rules.js";

export const NAME_MAX = 60;

/** Belay's name for a schedule, by its kind: also what a new one is called when no one names it. */
export const SCHEDULE_NAMES: Record<Schedule["kind"], string> = { school: "School", bedtime: "Bedtime", custom: "Schedule" };

/** An app's name on one phone, from the app list the phone sent, on one line; null for an app it never reported. */
export type AppNames = (pkg: string) => string | null;

export const noAppNames: AppNames = () => null;

export function appNamesOn(db: DB, deviceId: string): AppNames {
  const find = db.prepare<[string, string], { label: string }>("SELECT label FROM apps WHERE device_id = ? AND package = ?");
  return (pkg) => {
    const label = find.get(deviceId, pkg)?.label;
    return label === undefined ? null : oneLine(label, 40) || null;
  };
}

/** "A", "A and B", "A, B and C". */
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items.at(-1) ?? ""}`);
const apps = (n: number) => `${n} app${n === 1 ? "" : "s"}`;

/** Belay's name for a limit: its apps, by the names the phone gives them, or "Screen time" for a daily total. */
export function limitName(packages: readonly string[], names: AppNames): string {
  if (packages.includes("*")) return "Screen time";
  const all = [...new Set(packages)];
  const known = all.flatMap((p) => {
    const name = names(p);
    return name ? [name] : [];
  });
  const fits: string[] = [];
  if (known.length === all.length && all.length <= 3) fits.push(list(known));
  if (known.length >= 2 && all.length > 2) fits.push(`${known.slice(0, 2).join(", ")} and ${all.length - 2} more ${all.length === 3 ? "app" : "apps"}`);
  if (known.length >= 1 && all.length > 1) fits.push(`${known[0] ?? ""} and ${all.length - 1} more ${all.length === 2 ? "app" : "apps"}`);
  fits.push(apps(all.length));
  return fits.find((name) => name.length <= NAME_MAX) ?? apps(all.length);
}

/** One line, without control or direction-changing characters, at most 60; an empty name gets Belay's. */
export const tidyLimit = (l: Limit, names: AppNames = noAppNames): Limit => ({ ...l, name: oneLine(l.name, NAME_MAX) || limitName(l.packages, names) });
export const tidySchedule = (s: Schedule): Schedule => ({ ...s, name: oneLine(s.name, NAME_MAX) || SCHEDULE_NAMES[s.kind] });

/** The rules with every name tidied (tidyLimit, tidySchedule), whoever wrote them. */
export function tidyNames(rules: RuleSet, names: AppNames = noAppNames): RuleSet {
  return { ...rules, limits: rules.limits.map((l) => tidyLimit(l, names)), schedules: rules.schedules.map(tidySchedule) };
}

/**
 * The rules after a change, with Belay's names following what they name: a limit or schedule
 * that was called what Belay would call it, and whose name the change didn't touch, gets Belay's
 * name for what it is now. A name someone wrote stays as they wrote it.
 */
export function followNames(before: RuleSet, after: RuleSet, names: AppNames): RuleSet {
  const limits = new Map(before.limits.map((l) => [l.id, l]));
  const schedules = new Map(before.schedules.map((s) => [s.id, s]));
  return {
    ...after,
    limits: after.limits.map((l) => {
      const was = limits.get(l.id);
      return was && was.name === l.name && was.name === limitName(was.packages, names) ? { ...l, name: limitName(l.packages, names) } : l;
    }),
    schedules: after.schedules.map((s) => {
      const was = schedules.get(s.id);
      return was && was.name === s.name && was.name === SCHEDULE_NAMES[was.kind] ? { ...s, name: SCHEDULE_NAMES[s.kind] } : s;
    }),
  };
}
