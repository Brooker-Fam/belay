/**
 * The demo's made-up week (docs/demo.md): one parent, the simulated phone, and about seven days of
 * their life, played through the server's own code with a clock that runs from a week ago to now.
 * The phone's side goes through the device API (the simulated phone, demo/phone.ts, against the
 * server's app in this process); the parent's side through the functions the parent pages call
 * (family/*, auth/parents.ts), so everything is checked, versioned and in the activity log as if
 * it had happened. Location and network logging stay off: a parent can turn them on in the demo.
 */
import { createApp } from "../src/app.js";
import { audit } from "../src/audit.js";
import { createParent } from "../src/auth/parents.js";
import type { Config } from "../src/config.js";
import type { DB } from "../src/db.js";
import { makeDeps } from "../src/deps.js";
import { createEnrollmentCode } from "../src/device/enroll.js";
import type { Package, UsageDay } from "../src/device/schemas.js";
import { markReviewed } from "../src/family/apps.js";
import { putContact, setCalls } from "../src/family/calls/changes.js";
import { changeFamilySettings, setKidNumber } from "../src/family/kidside-changes.js";
import { type PolicyContext, answerRequest, protect } from "../src/family/policy.js";
import { moveToStage, saveAgreement, saveStage, setPhoneSettings } from "../src/family/screentime/changes.js";
import { addDays, at, clockMinutes, dateIn, dayClock, endOf, startOf, weekdayOf } from "../src/family/screentime/days.js";
import { newRuleId, offBelayStage } from "../src/family/screentime/rules.js";
import { updateSettings } from "../src/settings.js";
import { AGREEMENT, APPS, BELAY, CONTACTS, FIRST_APPS, GAMES, NUMBERS, PARENT, PHONE_NAME, STAGES, explorerRules, packageOf, starterRules } from "./family.js";
import { type PhoneState, SimPhone, newPhoneState } from "./phone.js";

const MINUTE = 60_000;

export interface SeedOptions {
  db: DB;
  config: Config;
  /** The real time now: the made-up history ends here. */
  now: number;
  /** The family's timezone, and the phone's. */
  zone: string;
  password: string;
  /** Keeps the simulated phone's state as it changes. */
  save?: (state: PhoneState) => void;
  /** Sees each device API request the phone makes (tests check them against the schemas). */
  observe?: (method: string, url: string, body: string | null) => void;
}

export interface Seeded {
  parentId: string;
  deviceId: string;
  phone: PhoneState;
  /** The requests left waiting for a parent: the new app, and more time. */
  waiting: { app: string; moreTime: string };
}

/** A stretch of the kid using the phone: `pkg` null is time in apps never counted per app (the phone app, texting). */
interface Session {
  /** Minutes after midnight, local. */
  at: number;
  minutes: number;
  pkg: string | null;
}

type Template = readonly (readonly [start: string, minutes: number, pkg: string | null])[];

/** A school day: a little before school, the bus, texting at lunch, then after school until bedtime at 9. */
const SCHOOL_DAY: Template = [
  ["07:05", 6, null],
  ["07:15", 10, APPS.lyricLoop.package],
  ["07:30", 12, APPS.wordGarden.package],
  ["08:05", 4, APPS.busBuddy.package],
  ["12:10", 4, null],
  ["15:05", 4, APPS.busBuddy.package],
  ["15:20", 25, APPS.pebblePath.package],
  ["15:50", 18, APPS.doodleDen.package],
  ["16:20", 15, APPS.fractionForest.package],
  ["16:45", 20, APPS.cometKart.package],
  ["17:15", 12, null],
  ["17:40", 15, APPS.lyricLoop.package],
  ["18:30", 8, APPS.skyAtlas.package],
  ["19:00", 25, APPS.pebblePath.package],
  ["19:40", 10, null],
  ["20:00", 12, APPS.wordGarden.package],
  ["20:20", 6, APPS.trailMaps.package],
  ["20:35", 12, APPS.lyricLoop.package],
];

/** A weekend day: a later start, more games and a hike with Trail Maps. */
const WEEKEND: Template = [
  ["08:40", 8, null],
  ["08:55", 30, APPS.cometKart.package],
  ["09:40", 20, APPS.doodleDen.package],
  ["10:30", 25, APPS.trailMaps.package],
  ["12:30", 10, null],
  ["13:00", 35, APPS.pebblePath.package],
  ["14:00", 15, APPS.skyAtlas.package],
  ["15:00", 20, APPS.fractionForest.package],
  ["16:00", 25, APPS.wordGarden.package],
  ["17:00", 20, APPS.lyricLoop.package],
  ["18:30", 15, null],
  ["19:15", 30, APPS.cometKart.package],
  ["20:10", 20, APPS.lyricLoop.package],
];

/** The same made-up week every time for a day: a small seeded generator (mulberry32). */
function random(seed: string): () => number {
  let a = 2_166_136_261;
  for (let i = 0; i < seed.length; i++) a = Math.imul(a ^ seed.charCodeAt(i), 16_777_619) >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

/**
 * A day's sessions, from the template for its kind of day, a little longer or shorter each time,
 * with games kept to the day's limit (as the phone would: it pauses them once the time is up) and
 * apps only from when they were allowed.
 */
function dayPlan(day: string, opts: { gamesLimit: number; from: number; allowedFrom: (pkg: string) => number }, zone: string): { sessions: Session[]; gamesUpAt: number | null } {
  const weekend = weekdayOf(day) === "sat" || weekdayOf(day) === "sun";
  const rand = random(`belay-demo ${day}`);
  let games = 0;
  let gamesUpAt: number | null = null;
  const sessions: Session[] = [];
  for (const [start, minutes, pkg] of weekend ? WEEKEND : SCHOOL_DAY) {
    const begin = clockMinutes(start) ?? 0;
    let length = Math.max(1, Math.round(minutes * (0.85 + rand() * 0.3)));
    const when = at(day, begin, zone);
    if (when < opts.from || (pkg !== null && when < opts.allowedFrom(pkg))) continue;
    if (pkg !== null && GAMES.includes(pkg)) {
      length = Math.min(length, opts.gamesLimit - games);
      if (length <= 0) continue;
      games += length;
      if (games === opts.gamesLimit) gamesUpAt = begin + length;
    }
    sessions.push({ at: begin, minutes: length, pkg });
  }
  return { sessions, gamesUpAt };
}

/** The day as the phone reports it (POST /usage), counted up to `upTo`. */
function usageOf(day: string, sessions: Session[], upTo: number, zone: string, gapUntil: number | null): UsageDay {
  const clock = dayClock(zone, "00:00");
  const end = endOf(day, clock);
  const complete = upTo >= end;
  const byHour = Array.from({ length: 24 }, () => 0);
  const apps = new Map<string, { minutes: number; opens: number }>();
  let screen = 0;
  let started = 0;
  for (const s of sessions) {
    const from = at(day, s.at, zone);
    if (from > upTo) continue;
    const minutes = Math.min(s.minutes, Math.floor((upTo - from) / MINUTE));
    started++;
    for (let m = 0; m < minutes; m++) {
      const hour = Math.floor((s.at + m) / 60) % 24;
      byHour[hour] = (byHour[hour] ?? 0) + 1;
    }
    screen += minutes;
    if (s.pkg !== null && minutes > 0) {
      const app = apps.get(s.pkg) ?? { minutes: 0, opens: 0 };
      apps.set(s.pkg, { minutes: app.minutes + minutes, opens: app.opens + 1 });
    }
  }
  const dayStart = startOf(day, clock);
  return {
    day,
    zone,
    as_of: complete ? end : Math.max(dayStart, upTo),
    complete,
    screen_minutes: screen,
    unlocks: started + Math.floor(started / 3),
    by_hour: byHour,
    apps: [...apps].map(([pkg, a]) => ({ package: pkg, minutes: a.minutes, opens: a.opens })).sort((a, b) => b.minutes - a.minutes),
    // The phone counts only from when measuring was turned on: the part of that day before is a gap.
    gaps: gapUntil !== null && gapUntil > dayStart ? [{ from: dayStart, to: Math.min(gapUntil, end), reason: "unknown" }] : [],
  };
}

/** The made-up week makes no network requests: no parent's browser has turned notifications on, and nothing else would. */
const noNetwork: typeof fetch = () => Promise.reject(new Error("The demo's made-up history makes no network requests"));

/**
 * Makes the demo's family on a new database: the parent (with `password`), the phone enrolled a
 * week ago, its apps, rules, stages and agreement, and a week of installs, updates, a removal, the
 * kid's requests and the answers, screen time and calls. Ends at `now`, with a new app and more
 * time waiting for a parent.
 */
export async function seedDemo(opts: SeedOptions): Promise<Seeded> {
  const { db, config, zone, password } = opts;
  const end = opts.now;
  const today = dateIn(end, zone);
  /** `hhmm` on the day `ago` days before today, in the family's timezone. */
  const T = (ago: number, hhmm: string) => at(addDays(today, -ago), clockMinutes(hhmm) ?? 0, zone);

  let clock = T(7, "17:30");
  const deps = makeDeps(config, db, { now: () => clock, fetch: noNetwork, log: () => undefined });
  const app = createApp(deps);
  const ctx = (): PolicyContext => ({
    db,
    now: clock,
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });

  // The phone as it was a week ago: its own apps, Belay (put on over adb just now), and the kid's apps from before.
  const firstApps: Package[] = FIRST_APPS.map((a, i) =>
    a.system ? packageOf(a, T(120, "10:00"), T(30, "03:00")) : a.package === BELAY ? packageOf(a, T(7, "17:20")) : packageOf(a, T(40 - i, "16:00"), T(12 - (i % 9), "04:00")),
  );
  const phone = new SimPhone({
    server: config.publicUrl,
    zone,
    state: newPhoneState({ now: clock, bootCount: 31, lastBootAt: T(9, "06:58"), apps: firstApps }),
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : String(input);
      opts.observe?.(init?.method ?? "GET", url, typeof init?.body === "string" ? init.body : null);
      return app.request(url, init);
    },
    now: () => clock,
    save: opts.save,
  });

  const ids = { games: newRuleId("l"), school: newRuleId("s"), bedtime: newRuleId("s") };
  const explorerIds = { games: newRuleId("l"), school: newRuleId("s"), bedtime: newRuleId("s") };
  let parentId = "";
  let deviceId = "";
  const parent = () => ({ kind: "parent", parentId }) as const;
  let measureFrom = Number.POSITIVE_INFINITY;

  // The steps of the week, in time order. Each runs at its time with the clock set to it.
  const steps: { at: number; n: number; run: () => unknown }[] = [];
  const step = (time: number, run: () => unknown) => steps.push({ at: time, n: steps.length, run });

  // ── A week ago, in the evening: the parent sets Belay up ──────────────
  step(T(7, "17:30"), async () => {
    const made = await createParent(db, clock, { name: PARENT.name, username: PARENT.username, password });
    parentId = made.id;
    updateSettings(db, { timezone: zone });
    audit(db, clock, parent(), "parent.setup");
  });
  step(T(7, "17:36"), () => changeFamilySettings(ctx(), { parentNumbers: [{ name: PARENT.name, number: NUMBERS.jordan }] }, parent()));
  step(T(7, "17:40"), async () => {
    const code = createEnrollmentCode(db, clock, { deviceName: PHONE_NAME, createdBy: parentId });
    audit(db, clock, parent(), "code.created", { detail: { name: PHONE_NAME } });
    clock += 8 * MINUTE;
    await phone.enroll(code.code);
    deviceId = phone.state.deviceId ?? "";
    await phone.sendInventory();
    await phone.checkin();
  });
  step(T(7, "17:55"), () => {
    const packages = firstApps.filter((a) => !a.system).map((a) => a.package);
    const done = markReviewed(db, clock, { deviceId, packages, note: "The apps Robin had before Belay: we went through them together.", parentId, via: "web" });
    audit(db, clock, parent(), "apps.reviewed", { deviceId, detail: { apps: done.marked.map((a) => a.label), note: "The apps Robin had before Belay: we went through them together." } });
  });
  step(T(7, "18:00"), async () => {
    protect(ctx(), deviceId, parent());
    await phone.sync();
  });
  step(T(7, "18:05"), async () => {
    const starter = saveStage(ctx(), null, { name: STAGES.starter.name, how: STAGES.starter.how, rules: starterRules(ids) }, parent()).stage;
    saveStage(ctx(), null, { name: STAGES.explorer.name, how: STAGES.explorer.how, rules: explorerRules(explorerIds) }, parent());
    const off = offBelayStage(db);
    if (off) saveStage(ctx(), off.id, { name: off.name, number: off.number, how: STAGES.offBelay, rules: off.rules }, parent());
    clock += 3 * MINUTE;
    moveToStage(ctx(), deviceId, starter.id, parent());
    clock += 2 * MINUTE;
    setPhoneSettings(ctx(), deviceId, { measure: true }, parent());
    measureFrom = clock;
    clock += 5 * MINUTE;
    saveAgreement(ctx(), deviceId, [...AGREEMENT], parent());
    clock += 5 * MINUTE;
    setCalls(ctx(), deviceId, { enabled: true, mode: "contacts", unknown: "voicemail", withheld: "reject", outgoing: "contacts", quiet: true, log: true }, parent());
    for (const c of CONTACTS) putContact(ctx(), deviceId, { name: c.name, number: c.number, calls: true, texts: true, parent: c.parent }, parent());
    setKidNumber(ctx(), deviceId, NUMBERS.kid, parent());
    clock += 5 * MINUTE;
    await phone.sync();
  });
  step(T(7, "19:30"), async () => {
    phone.answerAgreement(1, "agree");
    await phone.flush();
    await phone.sync();
  });

  // ── The plan of each day: what Robin does on the phone ────────────────
  const approvedAt = { fractionForest: T(5, "18:45") };
  const before = new Set(firstApps.map((a) => a.package));
  // Apps run from when they're allowed: those from before Belay, and Fraction Forest once approved.
  const allowedFrom = (pkg: string) => (before.has(pkg) ? 0 : pkg === APPS.fractionForest.package ? approvedAt.fractionForest : Number.POSITIVE_INFINITY);
  const gamesLimit = (day: string) => (weekdayOf(day) === "sat" || weekdayOf(day) === "sun" ? 90 : 60);
  const plans = new Map<string, Session[]>();
  const upAt = new Map<string, number | null>();
  for (let ago = 7; ago >= 0; ago--) {
    const day = addDays(today, -ago);
    const plan = dayPlan(day, { gamesLimit: gamesLimit(day), from: ago === 7 ? T(7, "18:15") : 0, allowedFrom }, zone);
    plans.set(day, plan.sessions);
    upAt.set(day, plan.gamesUpAt);
  }
  // Two days ago Robin asked for 15 more minutes of games, and got them: a race with Mia.
  const twoAgo = addDays(today, -2);
  const upTwoAgo = upAt.get(twoAgo) ?? clockMinutes("19:00") ?? 0;
  const askedAt = at(twoAgo, upTwoAgo + 6, zone);
  const answeredAt = askedAt + 5 * MINUTE;
  plans.get(twoAgo)?.push({ at: upTwoAgo + 13, minutes: 15, pkg: APPS.cometKart.package });

  /** What the phone counted today (and finished yesterday), then a check-in, as every 2 hours. */
  const report = async () => {
    const day = dateIn(clock, zone);
    const yesterday = addDays(day, -1);
    const last = plans.get(yesterday);
    if (last && !phone.state.usage[yesterday]?.complete) phone.recordUsage(usageOf(yesterday, last, clock, zone, measureFrom));
    const sessions = plans.get(day);
    if (sessions && clock >= measureFrom) phone.recordUsage(usageOf(day, sessions, clock, zone, measureFrom));
    await phone.flush();
    await phone.checkin();
  };
  /** Something happens on the phone, and it sends it at once, from its outbox. */
  const onPhone = (time: number, change: () => void) => {
    step(time, async () => {
      change();
      await phone.flush();
    });
  };
  /** The kid's requests, by what they're for: their ids are the phone's. */
  const asked: { fractionForest: string | null; clipStream: string | null; race: string | null; lanternChat: string | null; volcano: string | null } = {
    fractionForest: null,
    clipStream: null,
    race: null,
    lanternChat: null,
    volcano: null,
  };

  for (let ago = 7; ago >= 0; ago--) {
    for (const hhmm of ago === 7 ? ["20:05", "22:05"] : ["07:05", "12:05", "16:05", "20:05", "22:05"]) step(T(ago, hhmm), report);
    if (ago < 7) step(T(ago, "03:10"), () => phone.sendInventory());
  }

  // ── Six days ago: Trail Maps updates; a call with Grandma ─────────────
  onPhone(T(6, "15:40"), () => {
    phone.update(APPS.trailMaps.package, "3.2.0", 320);
  });
  onPhone(T(6, "17:10"), () => {
    phone.recordCall({ at: clock - 6 * MINUTE, direction: "out", number: NUMBERS.grandma, seconds: 360, outcome: "answered" });
  });

  // ── Five days ago: a math app for school, approved ────────────────────
  onPhone(T(5, "15:30"), () => {
    asked.fractionForest = phone.install(APPS.fractionForest);
  });
  onPhone(T(5, "15:34"), () => {
    if (asked.fractionForest) phone.explain(asked.fractionForest, "Ms. Rivera said our class should practice fractions on it.");
  });
  step(approvedAt.fractionForest, async () => {
    if (asked.fractionForest) answerRequest(ctx(), deviceId, asked.fractionForest, "approved", parent(), "Of course: it's for school.");
    const note = "A math practice app from the class list: no chat, no ads.";
    markReviewed(db, clock, { deviceId, packages: [APPS.fractionForest.package], note, parentId, via: "web" });
    audit(db, clock, parent(), "apps.reviewed", { deviceId, detail: { apps: [APPS.fractionForest.label], note } });
    await phone.sync();
  });

  // ── Four days ago: a video app, declined; a call from Jordan ──────────
  onPhone(T(4, "16:10"), () => {
    asked.clipStream = phone.install(APPS.clipStream);
  });
  onPhone(T(4, "16:13"), () => {
    if (asked.clipStream) phone.explain(asked.clipStream, "Everyone at lunch watches the funny animal videos on it.");
  });
  onPhone(T(4, "18:30"), () => {
    phone.recordCall({ at: clock - 2 * MINUTE, direction: "in", number: NUMBERS.jordan, seconds: 95, outcome: "answered" });
  });
  step(T(4, "19:30"), async () => {
    if (asked.clipStream) answerRequest(ctx(), deviceId, asked.clipStream, "declined", parent(), "Not yet. Let's talk about video apps at the weekend.");
    await phone.sync();
  });
  onPhone(T(4, "20:15"), () => {
    phone.update(APPS.lyricLoop.package, "2.13.0", 2130);
  });

  // ── Three days ago: a restart; Clip Stream removed; a stranger's call ─
  step(T(3, "07:31"), async () => {
    phone.reboot();
    await phone.flush();
    await phone.checkin();
    await phone.sendInventory();
  });
  onPhone(T(3, "16:20"), () => {
    phone.remove(APPS.clipStream.package);
  });
  onPhone(T(3, "16:45"), () => {
    phone.recordCall({ at: clock, direction: "in", number: NUMBERS.stranger, seconds: 0, outcome: "voicemail", reason: "unknown" });
  });

  // ── Two days ago: Pebble Path updates; 15 more minutes, given ─────────
  onPhone(T(2, "15:20"), () => {
    phone.update(APPS.pebblePath.package, "2.4.0", 240);
  });
  step(askedAt, async () => {
    asked.race = phone.askMoreTime(ids.games, 15, "Mia and I are one race from winning the cup!", APPS.cometKart.package);
    await report();
  });
  step(answeredAt, async () => {
    if (asked.race) answerRequest(ctx(), deviceId, asked.race, "approved", parent(), "15 more, then homework.", { minutes: 15 });
    await phone.sync();
  });
  onPhone(T(2, "20:40"), () => {
    phone.recordCall({ at: clock, direction: "in", number: NUMBERS.coach, seconds: 0, outcome: "missed" });
  });

  // ── Yesterday: a withheld number; a chat app and more time, waiting ───
  onPhone(T(1, "17:15"), () => {
    phone.recordCall({ at: clock, direction: "in", number: null, seconds: 0, outcome: "rejected", reason: "withheld" });
  });
  onPhone(T(1, "19:45"), () => {
    asked.lanternChat = phone.install(APPS.lanternChat);
  });
  onPhone(T(1, "19:48"), () => {
    if (asked.lanternChat) phone.explain(asked.lanternChat, "The robotics club plans our meetups in it. Can I have it?");
  });
  step(T(1, "20:10"), async () => {
    asked.volcano = phone.askMoreTime(ids.games, 30, "I'm one level from beating the volcano world!", APPS.pebblePath.package);
    await report();
  });

  // ── Today ─────────────────────────────────────────────────────────────
  onPhone(T(0, "15:35"), () => {
    phone.recordCall({ at: clock - MINUTE, direction: "out", number: NUMBERS.jordan, seconds: 70, outcome: "answered" });
  });
  step(end, report);

  steps.sort((a, b) => a.at - b.at || a.n - b.n);
  for (const s of steps) {
    if (s.at > end) continue;
    clock = Math.max(clock, s.at);
    await s.run();
  }
  if (!asked.lanternChat || !asked.volcano) throw new Error("The demo's week didn't make its waiting requests");
  return { parentId, deviceId, phone: phone.state, waiting: { app: asked.lanternChat, moreTime: asked.volcano } };
}
