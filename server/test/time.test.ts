import { describe, expect, it } from "vitest";
import { dayKey, formatDayKey, formatDuration, isoInZone, isValidTimeZone, localToEpoch, offsetLabel, parseWhen } from "../src/time.js";

const NY = "America/New_York";

describe("times in the family's timezone", () => {
  it("are written with their offset, which follows daylight saving", () => {
    expect(isoInZone(Date.UTC(2026, 10, 16, 15, 0, 5), NY)).toBe("2026-11-16T10:00:05-05:00");
    expect(isoInZone(Date.UTC(2026, 6, 4, 16, 0, 0), NY)).toBe("2026-07-04T12:00:00-04:00");
    expect(isoInZone(Date.UTC(2026, 10, 16, 15, 0, 0), "Asia/Kolkata")).toBe("2026-11-16T20:30:00+05:30");
    expect(isoInZone(Date.UTC(2026, 10, 16, 15, 0, 0), "UTC")).toBe("2026-11-16T15:00:00+00:00");
    expect(offsetLabel(Date.UTC(2026, 10, 16), NY)).toBe("UTC-05:00");
  });

  it("put a late-evening change on the family's day, not UTC's", () => {
    const lateSunday = Date.UTC(2026, 10, 16, 4, 30);
    expect(dayKey(lateSunday, NY)).toBe("2026-11-15");
    expect(dayKey(lateSunday, "UTC")).toBe("2026-11-16");
    expect(formatDayKey("2026-11-15")).toBe("Sunday, November 15, 2026");
  });

  it("read dates, local times and full ISO times", () => {
    expect(parseWhen("2026-11-15", NY)).toBe(Date.UTC(2026, 10, 15, 5, 0));
    expect(parseWhen("2026-11-15T16:30", NY)).toBe(Date.UTC(2026, 10, 15, 21, 30));
    expect(parseWhen("2026-07-04 09:00:00", NY)).toBe(Date.UTC(2026, 6, 4, 13, 0));
    expect(parseWhen("2026-11-15T16:30:00Z", NY)).toBe(Date.UTC(2026, 10, 15, 16, 30));
    expect(parseWhen("2026-11-15T16:30:00+01:00", NY)).toBe(Date.UTC(2026, 10, 15, 15, 30));
    for (const bad of ["yesterday", "11/15/2026", "2026-13-45x", ""]) expect(parseWhen(bad, NY)).toBeNull();
  });

  it("handle the days daylight saving starts and ends", () => {
    // 2026-03-08: 02:00 doesn't exist in New York; 2026-11-01: 01:30 happens twice.
    expect(isoInZone(localToEpoch(NY, 2026, 3, 8, 0, 0), NY)).toBe("2026-03-08T00:00:00-05:00");
    expect(isoInZone(localToEpoch(NY, 2026, 3, 8, 12, 0), NY)).toBe("2026-03-08T12:00:00-04:00");
    expect(isoInZone(localToEpoch(NY, 2026, 11, 1, 12, 0), NY)).toBe("2026-11-01T12:00:00-05:00");
    expect(dayKey(localToEpoch(NY, 2026, 11, 1, 0, 0), NY)).toBe("2026-11-01");
  });

  it("say how long, in plain words", () => {
    expect(formatDuration(30_000)).toBe("less than a minute");
    expect(formatDuration(60_000)).toBe("1 minute");
    expect(formatDuration(14 * 3_600_000 + 59 * 60_000)).toBe("14 hours");
    expect(formatDuration(47 * 3_600_000)).toBe("47 hours");
    expect(formatDuration(3 * 86_400_000)).toBe("3 days");
  });

  it("only accept real zone names", () => {
    expect(isValidTimeZone(NY)).toBe(true);
    expect(isValidTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(isValidTimeZone("")).toBe(false);
  });
});
