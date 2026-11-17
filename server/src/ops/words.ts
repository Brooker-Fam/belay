/** Small wording helpers for what the server says about itself. */
import { dayKey, formatDateTime, formatTime, startOfDay } from "../time.js";

/** "3 phones", "1 phone". */
export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}

/** "7 PM", "12 AM (midnight)", "12 PM (noon)". */
export function hourLabel(hour: number): string {
  if (hour === 0) return "12 AM (midnight)";
  if (hour === 12) return "12 PM (noon)";
  return hour < 12 ? `${hour} AM` : `${hour - 12} PM`;
}

/** "today, 2:00 AM", "yesterday, 2:00 AM", or "Nov 14, 2026, 2:00 AM", in the family's timezone. */
export function dayAndTime(ms: number, now: number, tz: string): string {
  const day = dayKey(ms, tz);
  const today = dayKey(now, tz);
  if (day === today) return `today, ${formatTime(ms, tz)}`;
  if (day === dayKey(startOfDay(today, tz) - 1, tz)) return `yesterday, ${formatTime(ms, tz)}`;
  return formatDateTime(ms, tz);
}
