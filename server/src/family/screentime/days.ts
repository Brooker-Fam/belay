/**
 * Local days as the phone counts them (core/screentime/LocalTimes.kt, DayClock): a day starts at
 * the rules' `day_starts` in their zone, so it's 23 or 25 hours long when the clocks change
 * during it, and a start in a DST gap is later by the gap (java.time's rule, which
 * time.ts's localToEpoch follows too). Times stay epoch milliseconds everywhere else.
 */
import { isValidTimeZone, localToEpoch, zoned } from "../../time.js";

export type Weekday = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
/** In the policy's order, Monday first, as java.time numbers them. */
export const WEEKDAYS: readonly Weekday[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

/** The zone the rules name: an IANA zone, or "phone": the phone's own, else the family's. */
export function resolveZone(zone: string, phoneZone: string | null | undefined, familyZone: string): string {
  if (zone !== "phone") return isValidTimeZone(zone) ? zone : familyZone;
  return phoneZone && isValidTimeZone(phoneZone) ? phoneZone : familyZone;
}

export interface DayClock {
  zone: string;
  /** Minutes after midnight when a day starts: `day_starts`. */
  starts: number;
}

/** "HH:MM" as minutes after midnight; null for anything else. */
export function clockMinutes(text: string): number | null {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(text);
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** "07:05" from minutes after midnight. */
export function clockText(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

export function dayClock(zone: string, dayStarts: string): DayClock {
  return { zone, starts: clockMinutes(dayStarts) ?? 0 };
}

const parts = (day: string): [number, number, number] => {
  const [y = 1970, m = 1, d = 1] = day.split("-").map(Number);
  return [y, m, d];
};

/** Whether "YYYY-MM-DD" is a date that exists. */
export function validDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;
  const [y, m, d] = parts(day);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** The day `n` days after (or before) `day`. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export function weekdayOf(day: string): Weekday {
  const [y, m, d] = parts(day);
  // getUTCDay: 0 is Sunday.
  return WEEKDAYS[(new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7] ?? "mon";
}

/** When `minutes` after midnight happens on `day` in `zone`. */
export function at(day: string, minutes: number, zone: string): number {
  const [y, m, d] = parts(day);
  return localToEpoch(zone, y, m, d, Math.floor(minutes / 60), minutes % 60);
}

/** The calendar date of `ms` in `zone`. */
export function dateIn(ms: number, zone: string): string {
  const p = zoned(ms, zone);
  return `${String(p.year).padStart(4, "0")}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

export function startOf(day: string, clock: DayClock): number {
  return at(day, clock.starts, clock.zone);
}

export function endOf(day: string, clock: DayClock): number {
  return startOf(addDays(day, 1), clock);
}

/** The day `ms` belongs to, as the rules count days. */
export function dayAt(ms: number, clock: DayClock): string {
  const date = dateIn(ms, clock.zone);
  if (ms < startOf(date, clock)) return addDays(date, -1);
  if (ms >= endOf(date, clock)) return addDays(date, 1);
  return date;
}
