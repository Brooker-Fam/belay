/**
 * Whether a change to screen-time rules tightens or loosens them (family/screentime/classify.ts):
 * every rule both ways, a mixed change, the matching the phone's Stages.kt does, and the words.
 * Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { type RulesSide, classifyScreenTimeChange, stageChanges } from "../src/family/screentime/classify.js";
import { addDays, at, dayAt, dayClock, resolveZone, startOf, validDay, weekdayOf } from "../src/family/screentime/days.js";
import { dayPreview, previewWords } from "../src/family/screentime/preview.js";
import { NO_RULES, type Limit, type RuleSet, type Schedule } from "../src/family/screentime/rules.js";
import { changeSentence, clock, days, duration, packageNames } from "../src/family/screentime/words.js";
import { isoInZone } from "../src/time.js";

const games = (over: Partial<Limit> = {}): Limit => ({ id: "l-games", name: "Games", packages: ["com.example.blocks", "com.example.racer"], minutes: 60, by_day: null, ...over });
const total = (over: Partial<Limit> = {}): Limit => ({ id: "l-total", name: "Screen time", packages: ["*"], minutes: 180, by_day: null, ...over });
const bedtime = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s-bed",
  kind: "bedtime",
  name: "Bedtime",
  days: ["sun", "mon", "tue", "wed", "thu"],
  start: "21:00",
  end: "07:00",
  allow: ["com.example.audiobooks"],
  lock: false,
  skip: [],
  ...over,
});
const school = (over: Partial<Schedule> = {}): Schedule => ({
  id: "s-school",
  kind: "school",
  name: "School",
  days: ["mon", "tue", "wed", "thu", "fri"],
  start: "08:00",
  end: "15:00",
  allow: [],
  lock: false,
  skip: [],
  ...over,
});
const base = (over: Partial<RulesSide> = {}): RulesSide => ({
  limits: [games(), total()],
  schedules: [bedtime(), school()],
  exempt: ["com.example.homework"],
  if_unmeasured: "pause_limited",
  self_serve: { minutes: 10, times: 2 },
  warn_before: 5,
  measure: true,
  zone: "phone",
  day_starts: "00:00",
  extra: [],
  stage: { number: 2, name: "Explorer" },
  ...over,
});

/** [what, the change from base(), the kind, the effect]: one change each. */
const ONE_CHANGE: [string, Partial<RulesSide>, string, "tightens" | "loosens" | "neither"][] = [
  ["a lower limit", { limits: [games({ minutes: 45 }), total()] }, "limit_minutes", "tightens"],
  ["a higher limit", { limits: [games({ minutes: 90 }), total()] }, "limit_minutes", "loosens"],
  ["fewer minutes on one day", { limits: [games({ by_day: { sat: 30 } }), total()] }, "limit_minutes", "tightens"],
  ["more minutes on one day", { limits: [games({ by_day: { sat: 120 } }), total()] }, "limit_minutes", "loosens"],
  ["a lower daily total", { limits: [games(), total({ minutes: 120 })] }, "limit_minutes", "tightens"],
  ["a higher daily total", { limits: [games(), total({ minutes: 240 })] }, "limit_minutes", "loosens"],
  ["a new limit", { limits: [games(), total(), { id: "l-chat", name: "Chat", packages: ["com.example.chat"], minutes: 30, by_day: null }] }, "limit_added", "tightens"],
  ["a limit removed", { limits: [total()] }, "limit_removed", "loosens"],
  ["the daily total removed", { limits: [games()] }, "limit_removed", "loosens"],
  ["an app added to a limit", { limits: [games({ packages: ["com.example.blocks", "com.example.racer", "com.example.cards"] }), total()] }, "limit_apps_added", "tightens"],
  ["an app taken off a limit", { limits: [games({ packages: ["com.example.blocks"] }), total()] }, "limit_apps_removed", "loosens"],
  ["a schedule that starts earlier", { schedules: [bedtime({ start: "20:30" }), school()] }, "schedule_times", "tightens"],
  ["a schedule that starts later", { schedules: [bedtime({ start: "21:30" }), school()] }, "schedule_times", "loosens"],
  ["a schedule that ends later", { schedules: [bedtime({ end: "07:30" }), school()] }, "schedule_times", "tightens"],
  ["a schedule that ends earlier", { schedules: [bedtime({ end: "06:30" }), school()] }, "schedule_times", "loosens"],
  ["a schedule moved earlier, both ends", { schedules: [bedtime({ start: "20:00", end: "06:00" }), school()] }, "schedule_times", "loosens"],
  ["a schedule on more days", { schedules: [bedtime({ days: ["sun", "mon", "tue", "wed", "thu", "fri"] }), school()] }, "schedule_days_added", "tightens"],
  ["a schedule on fewer days", { schedules: [bedtime({ days: ["sun", "mon", "tue", "wed"] }), school()] }, "schedule_days_removed", "loosens"],
  ["a new schedule", { schedules: [bedtime(), school(), { ...school({ id: "s-dinner", kind: "custom", name: "Dinner", start: "18:00", end: "19:00" }) }] }, "schedule_added", "tightens"],
  ["a schedule removed", { schedules: [bedtime()] }, "schedule_removed", "loosens"],
  ["an app no longer left open in a schedule", { schedules: [bedtime({ allow: [] }), school()] }, "schedule_no_longer_allows", "tightens"],
  ["an app left open in a schedule", { schedules: [bedtime({ allow: ["com.example.audiobooks", "com.example.music"] }), school()] }, "schedule_allows", "loosens"],
  ["a schedule that locks the screen", { schedules: [bedtime({ lock: true }), school()] }, "schedule_locks", "tightens"],
  ["an app no longer exempt", { exempt: [] }, "exempt_removed", "tightens"],
  ["an app exempt", { exempt: ["com.example.homework", "com.example.chat"] }, "exempt_added", "loosens"],
  ["keeping them open when Belay can't count", { if_unmeasured: "keep_open" }, "if_unmeasured", "loosens"],
  ["fewer self-serve minutes", { self_serve: { minutes: 5, times: 2 } }, "self_serve", "tightens"],
  ["more self-serve minutes", { self_serve: { minutes: 15, times: 2 } }, "self_serve", "loosens"],
  ["fewer self-serve times", { self_serve: { minutes: 10, times: 1 } }, "self_serve", "tightens"],
  ["more self-serve times", { self_serve: { minutes: 10, times: 3 } }, "self_serve", "loosens"],
  ["no more self-serve", { self_serve: null }, "self_serve", "tightens"],
  ["self-serve: fewer minutes but more times", { self_serve: { minutes: 5, times: 3 } }, "self_serve", "loosens"],
  ["another warning", { warn_before: 10 }, "warn_before", "neither"],
  ["a lower stage", { stage: { number: 1, name: "Starter" } }, "stage", "tightens"],
  ["a higher stage", { stage: { number: 3, name: "Navigator" } }, "stage", "loosens"],
  ["off its stage", { stage: null }, "stage", "loosens"],
  ["a day it doesn't start", { schedules: [bedtime({ skip: ["2026-11-26"] }), school()] }, "schedule_skips_added", "loosens"],
  ["measuring off", { measure: false }, "measure", "neither"],
  ["another zone", { zone: "America/New_York" }, "zone", "loosens"],
  ["days starting later", { day_starts: "04:00" }, "day_starts", "loosens"],
  ["extra time", { extra: [{ id: "x-1", limit_id: "l-games", minutes: 15, day: "2026-11-17", request_id: null, package: null }] }, "extra_added", "loosens"],
  ["a renamed limit", { limits: [games({ name: "Gaming" }), total()] }, "limit_renamed", "neither"],
  ["a schedule of another kind", { schedules: [bedtime({ kind: "custom" }), school()] }, "schedule_kind", "neither"],
];

describe("classifyScreenTimeChange, one change at a time", () => {
  it.each(ONE_CHANGE)("%s", (_what, change, kind, effect) => {
    const result = classifyScreenTimeChange(base(), base(change));
    expect(result.changes.map((c) => [c.kind, c.effect])).toEqual([[kind, effect]]);
    expect(result.onlyTightens).toBe(effect === "tightens");
    expect(result.effect).toBe(effect);
  });

  it("the other way round, each loosening tightens and each tightening loosens", () => {
    // Moving a schedule both ways, or fewer minutes but more times, loosens either way: something is
    // given up. So does onto a stage from none (only a lower stage tightens), and another zone or
    // day start, which move every limit and schedule.
    const bothWays = new Set(["a schedule moved earlier, both ends", "self-serve: fewer minutes but more times", "off its stage", "another zone", "days starting later"]);
    for (const [what, change, kind, effect] of ONE_CHANGE) {
      if (effect === "neither" || kind === "limit_removed" || kind === "schedule_removed" || kind.endsWith("_added") || kind === "schedule_skips_added") continue;
      const back = classifyScreenTimeChange(base(change), base());
      const opposite = bothWays.has(what) ? "loosens" : effect === "tightens" ? "loosens" : "tightens";
      expect(back.changes.map((c) => c.effect), what).toEqual([opposite]);
    }
    // Added one way is removed the other way.
    expect(classifyScreenTimeChange(base({ exempt: ["com.example.homework", "com.example.chat"] }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([["exempt_removed", "tightens"]]);
    expect(classifyScreenTimeChange(base({ limits: [games({ packages: ["com.example.blocks", "com.example.racer", "com.example.cards"] }), total()] }), base()).changes.map((c) => c.kind)).toEqual([
      "limit_apps_removed",
    ]);
    // Removed one way is added the other way.
    expect(classifyScreenTimeChange(base({ limits: [total()] }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([["limit_added", "tightens"]]);
    expect(classifyScreenTimeChange(base({ schedules: [bedtime()] }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([["schedule_added", "tightens"]]);
    // A day it doesn't start, taken off the list: the schedule runs that day again.
    expect(classifyScreenTimeChange(base({ schedules: [bedtime({ skip: ["2026-11-26"] }), school()] }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([
      ["schedule_skips_removed", "tightens"],
    ]);
    // Back to pausing apps with a limit when Belay can't count.
    expect(classifyScreenTimeChange(base({ if_unmeasured: "keep_open" }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([["if_unmeasured", "tightens"]]);
    expect(classifyScreenTimeChange(base({ schedules: [bedtime({ lock: true }), school()] }), base()).changes.map((c) => [c.kind, c.effect])).toEqual([
      ["schedule_no_longer_locks", "loosens"],
    ]);
  });

  it("a change that both tightens and loosens loosens: an AI app can only propose it", () => {
    const mixed = classifyScreenTimeChange(base(), base({ limits: [games({ minutes: 30 }), total({ minutes: 240 })] }));
    expect(mixed.changes.map((c) => c.effect).sort()).toEqual(["loosens", "tightens"]);
    expect(mixed).toMatchObject({ onlyTightens: false, effect: "loosens", none: false });
    // Tightening with a warning change isn't only tightening either.
    expect(classifyScreenTimeChange(base(), base({ warn_before: 1, limits: [games({ minutes: 30 }), total()] })).onlyTightens).toBe(false);
  });

  it("measuring on or off is collection, whichever way", () => {
    expect(classifyScreenTimeChange(base({ measure: false }), base()).collection).toBe(true);
    expect(classifyScreenTimeChange(base(), base({ measure: false })).collection).toBe(true);
    expect(classifyScreenTimeChange(base(), base({ measure: false })).onlyTightens).toBe(false);
  });

  it("nothing changed is none, and null is no rules at all", () => {
    expect(classifyScreenTimeChange(base(), base())).toEqual({ changes: [], none: true, onlyTightens: false, collection: false, effect: "none" });
    expect(classifyScreenTimeChange(null, null).none).toBe(true);
    const fromNothing = classifyScreenTimeChange(null, { limits: [games()], schedules: [bedtime()] });
    expect(fromNothing.changes.map((c) => c.kind)).toEqual(["limit_added", "schedule_added"]);
    expect(fromNothing.onlyTightens).toBe(true);
  });

  it("a bedtime that runs past midnight: an earlier end the next morning loosens, a later one tightens", () => {
    const earlier = classifyScreenTimeChange({ schedules: [bedtime()] }, { schedules: [bedtime({ end: "06:00" })] });
    expect(earlier.changes[0]).toMatchObject({ kind: "schedule_times", effect: "loosens" });
    expect(classifyScreenTimeChange({ schedules: [bedtime()] }, { schedules: [bedtime({ end: "08:00" })] }).onlyTightens).toBe(true);
    // All day (start = end) from 21:00 to 07:00 only adds time.
    expect(classifyScreenTimeChange({ schedules: [bedtime()] }, { schedules: [bedtime({ end: "21:00" })] }).onlyTightens).toBe(true);
  });
});

describe("matching, as the phone's Stages.kt matches", () => {
  it("limits: by id, then by the same apps, then by name; a daily total only matches a daily total", () => {
    // Another id with the same apps is the same limit, with other minutes.
    const sameApps = classifyScreenTimeChange({ limits: [games()] }, { limits: [games({ id: "l-other", name: "Video games", minutes: 30 })] });
    expect(sameApps.changes.map((c) => c.kind)).toEqual(["limit_minutes"]);
    // Another id and other apps, the same name (any case): the same limit, its apps changed.
    const sameName = classifyScreenTimeChange({ limits: [games()] }, { limits: [games({ id: "l-other", name: " games ", packages: ["com.example.blocks"] })] });
    expect(sameName.changes.map((c) => c.kind)).toEqual(["limit_apps_removed"]);
    // An app limit that becomes a daily total is one limit gone and another new: that loosens.
    const toTotal = classifyScreenTimeChange({ limits: [games()] }, { limits: [games({ packages: ["*"] })] });
    expect(toTotal.changes.map((c) => c.kind).sort()).toEqual(["limit_added", "limit_removed"]);
    expect(toTotal.effect).toBe("loosens");
  });

  it("schedules: by id, then by kind and name, then by kind when each side has one of it", () => {
    const byKind = classifyScreenTimeChange({ schedules: [bedtime()] }, { schedules: [bedtime({ id: "s-new", name: "Lights out", start: "20:30" })] });
    expect(byKind.changes.map((c) => [c.kind, c.effect])).toEqual([
      ["schedule_times", "tightens"],
      ["schedule_renamed", "neither"],
    ]);
    // Two of a kind on one side: no pairing by kind, so one goes and one comes.
    const two = classifyScreenTimeChange({ schedules: [bedtime(), bedtime({ id: "s-nap", name: "Nap" })] }, { schedules: [bedtime({ id: "s-x", name: "Lights out" })] });
    expect(two.changes.map((c) => c.kind).sort()).toEqual(["schedule_added", "schedule_removed", "schedule_removed"]);
  });

  it("a stage's changes are only what a stage bundles", () => {
    const changes = stageChanges(base(), base({ measure: false, zone: "UTC", limits: [games({ minutes: 90 }), total()], stage: { number: 3, name: "Navigator" } }));
    expect(changes.map((c) => c.kind)).toEqual(["limit_minutes"]);
  });
});

describe("the words", () => {
  const kid = { for: "kid" as const, label: packageNames };
  const words = (before: RulesSide, after: RulesSide) => classifyScreenTimeChange(before, after).changes.map((c) => changeSentence(c, kid));

  it("say a change the way the phone's KidText drafts do", () => {
    expect(words({ limits: [total({ minutes: 90 })] }, { limits: [total({ minutes: 120 })] })).toEqual(["Daily screen time goes from 1 h 30 min to 2 h, every day"]);
    expect(words({ limits: [games()] }, { limits: [games({ by_day: { sat: 90, sun: 90 } })] })).toEqual(["Games: 1 h 30 min a day instead of 1 h, Saturday and Sunday"]);
    expect(words({}, { schedules: [bedtime()] })).toEqual(["New: Bedtime from 9:00 pm to 7:00 am, Sunday to Thursday"]);
    expect(words({ schedules: [bedtime()] }, { schedules: [bedtime({ start: "21:30" })] })).toEqual(["Bedtime: 9:30 pm to 7:00 am instead of 9:00 pm to 7:00 am"]);
    expect(words({ self_serve: null }, { self_serve: { minutes: 10, times: 2 } })).toEqual(["You can take 10 more minutes, twice a day, without asking"]);
    expect(words({ exempt: [] }, { exempt: ["com.example.homework"] })).toEqual(["com.example.homework never counts toward a limit"]);
    expect(words({ limits: [games()] }, {})).toEqual(["No more time limit for Games"]);
    expect(words({}, { if_unmeasured: "keep_open" })).toEqual(["When Belay can't count, apps with a limit stay open"]);
    expect(words({ schedules: [bedtime()] }, { schedules: [bedtime({ days: ["mon", "wed", "fri"] })] })).toEqual(["Bedtime also on Friday", "No Bedtime on Tuesday, Thursday and Sunday"]);
    expect(words({ schedules: [bedtime()] }, { schedules: [bedtime({ days: ["sun", "mon"] })] })).toEqual(["No Bedtime on Tuesday to Thursday"]);
  });

  it("speak about the kid for the parents, and use the apps' names", () => {
    const labels = (p: string) => ({ "com.example.blocks": "Block Party" })[p] ?? p;
    const parent = classifyScreenTimeChange({ self_serve: null }, { self_serve: { minutes: 10, times: 1 } }).changes.map((c) => changeSentence(c, { for: "parent", label: labels }));
    expect(parent).toEqual(["The kid can take 10 more minutes, once a day, without asking (self-serve)"]);
    const apps = classifyScreenTimeChange({ limits: [games({ packages: ["com.example.racer"] })] }, { limits: [games()] }).changes.map((c) => changeSentence(c, { for: "kid", label: labels }));
    expect(apps).toEqual(["Block Party now counts toward Games"]);
  });

  it("durations, clocks and days, compactly", () => {
    expect([duration(0), duration(45), duration(60), duration(90), duration(1440)]).toEqual(["0 min", "45 min", "1 h", "1 h 30 min", "24 h"]);
    expect([clock("00:00"), clock("07:05"), clock("12:00"), clock("21:30")]).toEqual(["12:00 am", "7:05 am", "12:00 pm", "9:30 pm"]);
    expect([days(["mon", "tue", "wed", "thu", "fri"]), days(["sat", "sun"]), days(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), days(["mon", "wed"])]).toEqual([
      "Monday to Friday",
      "Saturday and Sunday",
      "every day",
      "Monday and Wednesday",
    ]);
    // Days in a row across the week's end, and days apart, each named.
    expect([days(["thu", "sun", "mon", "tue", "wed"]), days(["sun", "mon"]), days(["mon", "wed", "fri", "sun"])]).toEqual([
      "Sunday to Thursday",
      "Sunday and Monday",
      "Monday, Wednesday, Friday and Sunday",
    ]);
  });

  it("are at most 300 characters, as the policy's unlocks are", () => {
    const long = classifyScreenTimeChange({}, { limits: [games({ name: "x".repeat(60), packages: Array.from({ length: 50 }, (_, i) => `com.example.app${i}`) })] });
    for (const c of long.changes) expect(changeSentence(c, { for: "kid", label: () => "y".repeat(200) }).length).toBeLessThanOrEqual(300);
  });
});

describe("a school day's preview", () => {
  const rules: RuleSet = { ...NO_RULES, limits: [games(), total({ minutes: 120 })], schedules: [school(), bedtime()] };

  it("lists the open times between the schedules, and the minutes of each limit that day", () => {
    const p = dayPreview(rules);
    expect(p.day).toBe("mon");
    // Sunday's bedtime holds Monday until 7:00; school 8 to 3; bedtime from 9.
    expect(p.open).toEqual([
      [7 * 60, 8 * 60],
      [15 * 60, 21 * 60],
    ]);
    expect(previewWords(p, true)).toBe(
      "With these rules, a school day (Monday) has apps open from 7:00 am to 8:00 am, from 3:00 pm to 9:00 pm. Within that: 1 h of Games, 2 h of screen time in all. Calls, texts, 911 and 988 always work.",
    );
    expect(previewWords(dayPreview(NO_RULES), false)).toContain("apps open all day");
  });
});

describe("days as the phone counts them", () => {
  it("start at day_starts in the zone, and the day before until then", () => {
    const ny = dayClock("America/New_York", "04:00");
    const at3 = Date.UTC(2026, 10, 17, 8, 0); // 3:00 a.m. in New York
    expect(dayAt(at3, ny)).toBe("2026-11-16");
    expect(dayAt(at3 + 3_600_000, ny)).toBe("2026-11-17");
    expect(isoInZone(startOf("2026-11-17", ny), "America/New_York")).toBe("2026-11-17T04:00:00-05:00");
  });

  it("are 23 or 25 hours long when the clocks change, and a start in a gap is later by the gap", () => {
    const ny = dayClock("America/New_York", "00:00");
    expect(startOf("2026-03-09", ny) - startOf("2026-03-08", ny)).toBe(23 * 3_600_000);
    expect(startOf("2026-11-02", ny) - startOf("2026-11-01", ny)).toBe(25 * 3_600_000);
    const atTwoThirty = dayClock("America/New_York", "02:30");
    expect(isoInZone(startOf("2026-03-08", atTwoThirty), "America/New_York")).toBe("2026-03-08T03:30:00-04:00");
    expect(dayAt(Date.UTC(2026, 2, 8, 7, 15), atTwoThirty)).toBe("2026-03-07"); // 3:15 a.m. EDT: before 3:30
  });

  it("follow the phone's own zone for \"phone\", else the family's", () => {
    expect(resolveZone("phone", "Europe/Paris", "UTC")).toBe("Europe/Paris");
    expect(resolveZone("phone", "Mars/Olympus", "America/New_York")).toBe("America/New_York");
    expect(resolveZone("Asia/Kolkata", "Europe/Paris", "UTC")).toBe("Asia/Kolkata");
  });

  it("dates", () => {
    expect([validDay("2026-02-28"), validDay("2026-02-29"), validDay("2026-13-01"), validDay("26-1-1")]).toEqual([true, false, false, false]);
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(weekdayOf("2026-11-16")).toBe("mon");
    expect(isoInZone(at("2026-11-16", 21 * 60, "America/Los_Angeles"), "America/Los_Angeles")).toBe("2026-11-16T21:00:00-08:00");
  });
});
