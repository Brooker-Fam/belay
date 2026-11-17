/**
 * Times are stored as UTC epoch milliseconds and shown in the family's timezone, with its
 * offset ("2026-11-15T16:02:11-05:00"), on the parent pages and over MCP.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(key: string, make: () => Intl.DateTimeFormat): Intl.DateTimeFormat {
  let f = formatters.get(key);
  if (!f) {
    f = make();
    formatters.set(key, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  if (!tz || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** IANA zone names, for the settings form. */
export function timeZones(): string[] {
  return ["UTC", ...Intl.supportedValuesOf("timeZone").filter((tz) => tz !== "UTC")];
}

export interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** Minutes east of UTC, e.g. -300 for New York in winter. */
  offsetMinutes: number;
}

export function zoned(ms: number, tz: string): ZonedParts {
  const parts = formatter(`parts:${tz}`, () =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      timeZoneName: "longOffset",
    }),
  ).formatToParts(new Date(ms));
  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? "0";
  const offset = /GMT([+-])(\d{2}):(\d{2})/.exec(get("timeZoneName"));
  const offsetMinutes = offset ? (offset[1] === "-" ? -1 : 1) * (Number(offset[2]) * 60 + Number(offset[3])) : 0;
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    minute: Number(get("minute")),
    second: Number(get("second")),
    offsetMinutes,
  };
}

const pad = (n: number, width = 2): string => String(Math.abs(n)).padStart(width, "0");

function offsetString(minutes: number): string {
  return `${minutes < 0 ? "-" : "+"}${pad(Math.trunc(minutes / 60))}:${pad(minutes % 60)}`;
}

/** "2026-11-15T16:02:11-05:00" */
export function isoInZone(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${offsetString(p.offsetMinutes)}`;
}

/** "UTC-05:00" */
export function offsetLabel(ms: number, tz: string): string {
  return `UTC${offsetString(zoned(ms, tz).offsetMinutes)}`;
}

/** The calendar day in the zone: "2026-11-15". */
export function dayKey(ms: number, tz: string): string {
  const p = zoned(ms, tz);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

/** "Sunday, November 15, 2026" for "2026-11-15". */
export function formatDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number);
  return formatter("day", () =>
    new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" }),
  ).format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1)));
}

/** "4:02 PM" */
export function formatTime(ms: number, tz: string): string {
  return formatter(`time:${tz}`, () => new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" })).format(
    new Date(ms),
  );
}

/** "Nov 15, 2026" */
export function formatDate(ms: number, tz: string): string {
  return formatter(`date:${tz}`, () =>
    new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "short", day: "numeric" }),
  ).format(new Date(ms));
}

/** "Nov 15, 2026, 4:02 PM" */
export function formatDateTime(ms: number, tz: string): string {
  return `${formatDate(ms, tz)}, ${formatTime(ms, tz)}`;
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/** "45 minutes", "14 hours", "3 days" */
export function formatDuration(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return "less than a minute";
  if (span < HOUR) return plural(Math.floor(span / MINUTE), "minute");
  if (span < 2 * DAY) return plural(Math.floor(span / HOUR), "hour");
  return plural(Math.floor(span / DAY), "day");
}

/** "just now", "5 minutes ago", "3 days ago" */
export function formatAgo(ms: number, now: number): string {
  const span = now - ms;
  if (span < MINUTE) return "just now";
  return `${formatDuration(span)} ago`;
}

/** Epoch ms for a wall-clock time in the zone (for a time skipped by DST, the moment after). */
export function localToEpoch(tz: string, year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const first = asUtc - zoned(asUtc, tz).offsetMinutes * MINUTE;
  return asUtc - zoned(first, tz).offsetMinutes * MINUTE;
}

/** Midnight at the start of `key` ("2026-11-15") in the zone. */
export function startOfDay(key: string, tz: string): number {
  const [y, m, d] = key.split("-").map(Number);
  return localToEpoch(tz, y ?? 1970, m ?? 1, d ?? 1);
}

/**
 * Reads a time an AI client or a form passes: "2026-11-15" (midnight in the family's zone),
 * "2026-11-15T16:00" (wall-clock time there), or a full ISO time with Z or an offset.
 * Null when it isn't one of those.
 */
export function parseWhen(input: string, tz: string): number | null {
  const text = input.trim();
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (date) return localToEpoch(tz, Number(date[1]), Number(date[2]), Number(date[3]));
  const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/.exec(text);
  if (local) {
    return localToEpoch(tz, Number(local[1]), Number(local[2]), Number(local[3]), Number(local[4]), Number(local[5]), Number(local[6] ?? 0));
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/i.test(text)) {
    const ms = Date.parse(text);
    return Number.isNaN(ms) ? null : ms;
  }
  return null;
}

export const durations = { MINUTE, HOUR, DAY };
