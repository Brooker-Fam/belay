/**
 * Phase 11's "stop collecting" (docs/design/phase11-off-belay.md, "Winding down"): what the server
 * keeps about one phone, data category by data category (the AI scopes' ids, settings.ts, and the
 * phone's core/DataCategory.kt), and a parent's choice to stop collecting one and delete what's
 * kept of it, after a confirmation that lists exactly what goes. Only a person does it (the parent
 * page), never an AI app, and it's in the activity log with what went.
 *
 * Stopping is a switch where the phone has one: screen time's measuring, location (with lost mode
 * and keeping location on), and recording calls (Phase 5). The phone always sends its app list and app changes while Belay
 * is on it (its rules work from them), and the kid can always ask for things ("I need help" must
 * always reach a parent), so for those two what goes is what's kept now. A request the kid's phone
 * still shows keeps a bare record (that it was asked, and the answer, without anyone's words), so
 * the phone doesn't show it as waiting again. Requests waiting for a parent, and help requests no
 * parent has seen, stay as they are.
 *
 * Every table with a phone's rows belongs to one of these, or to RECORDS (tested), so a new kind
 * of data can't be left out.
 */
import { createHash } from "node:crypto";
import type { DB } from "../db.js";
import { setCalls } from "./calls/changes.js";
import { callSettings, listContacts, listNumbers } from "./calls/store.js";
import { setLocation, setLost } from "./location/changes.js";
import { listPlaces, locationSettings } from "./location/store.js";
import { type Changed, type Person, type PolicyContext, RuleRefused, changePolicy } from "./policy.js";
import { setPhoneSettings } from "./screentime/changes.js";
import { phoneRules } from "./screentime/rules.js";

export const COLLECTED = ["apps", "screen_time", "location", "calls", "requests"] as const;
export type Collected = (typeof COLLECTED)[number];

/** The tables each category's rows are in (location's checks are the phone's locate_now commands). */
export const COLLECTED_TABLES: Record<Collected, readonly string[]> = {
  apps: ["apps", "app_events", "snapshots", "reviews"],
  screen_time: ["usage_days", "usage_apps"],
  location: ["fixes", "place_events", "places"],
  calls: ["call_records"],
  requests: ["requests"],
};

/**
 * A phone's rows that aren't collected data: its rules and settings, and records of what parents,
 * AI apps and the phone did. Kept until the phone is deleted (the activity log beyond that, for
 * as long as the family keeps it: maintenance.ts).
 */
export const RECORDS: readonly string[] = [
  "policies",
  "app_decisions",
  "proposals",
  "agent_offers",
  "recovery_keys",
  "commands",
  "phone_stages",
  "screen_time_rules",
  "extra_time",
  "agreements",
  "location_settings",
  "phone_help",
  // Phase 5: the calls rules, the contacts a parent approved, and the private and blocked numbers.
  "call_settings",
  "contacts",
  "contact_numbers",
  "call_numbers",
  "handovers",
  "enrollment_codes",
  "audit_log",
];

/**
 * How long the kid's phone keeps its own requests (core's Requests.KEEP_MS, 60 days), with a day
 * to spare: for these, a bare record stays, so the phone still shows the answer.
 */
export const PHONE_KEEPS_REQUESTS_MS = 61 * 86_400_000;

export const COLLECTED_TITLES: Record<Collected, string> = {
  apps: "Apps",
  screen_time: "Screen time",
  location: "Where the phone is",
  calls: "Calls",
  requests: "Requests",
};

export interface Kept {
  category: Collected;
  title: string;
  /** Exactly what deleting removes now, in words with counts; empty when nothing is kept. */
  goes: string[];
  /** What stopping does to what the phone collects. */
  stopping: string;
  /** What stays, and why. */
  stays: string[];
  /** Whether stopping changes anything: something to delete, or a switch to turn off. */
  anything: boolean;
  /** Changes when what goes changes: the confirmation's form carries it, so what's deleted is what was listed. */
  fingerprint: string;
}

const count = (db: DB, sql: string, ...params: (string | number)[]): number =>
  db.prepare<(string | number)[], { n: number }>(`SELECT COUNT(*) AS n FROM ${sql}`).get(...params)?.n ?? 0;

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Removed apps without a parent's allow or block now: a decision keeps its app's row, which says what it's about. */
const REMOVED_APPS = `apps AS a WHERE a.device_id = ? AND a.present = 0 AND NOT EXISTS (
  SELECT 1 FROM app_decisions d WHERE d.device_id = a.device_id AND d.package = a.package AND d.state != 'undecided'
    AND d.id = (SELECT MAX(id) FROM app_decisions WHERE device_id = a.device_id AND package = a.package))`;

/** A request with the kid's own words: why they asked, or (Phase 5) the name they gave a contact. */
const KID_WORDS = "(reason IS NOT NULL OR (kind = 'contact' AND contact_name IS NOT contact_number))";

/** Requests that stay as they are: waiting for a parent, or a help request no parent has seen. */
const KEPT_REQUEST = "(status = 'pending' OR (kind = 'help' AND seen_at IS NULL AND status IN ('pending', 'withdrawn')))";

function appsKept(db: DB, deviceId: string): Omit<Kept, "fingerprint"> {
  const changes = count(db, "app_events WHERE device_id = ?", deviceId);
  const reviews = count(db, "reviews WHERE device_id = ?", deviceId);
  const removed = count(db, REMOVED_APPS, deviceId);
  const lists = count(db, "snapshots WHERE device_id = ?", deviceId);
  const present = count(db, "apps WHERE device_id = ? AND present = 1", deviceId);
  const goes = [
    ...(changes ? [`${plural(changes, "app change")} (installs, updates and removals)`] : []),
    ...(reviews ? [`${plural(reviews, "review")} of apps, with their notes`] : []),
    ...(removed ? [`${plural(removed, "app")} that ${removed === 1 ? "isn't" : "aren't"} on the phone any more`] : []),
    ...(lists ? [`the record of ${plural(lists, "app list")} the phone sent (when, and how many apps)`] : []),
  ];
  return {
    category: "apps",
    title: COLLECTED_TITLES.apps,
    goes,
    stopping: "Belay on the phone keeps sending its app list and its app changes while it's on the phone: its rules work from them. What's kept now goes.",
    stays: [
      `The ${plural(present, "app")} on the phone now, and your allow and block decisions. New app changes arrive as they happen.`,
    ],
    anything: goes.length > 0,
  };
}

function screenTimeKept(db: DB, deviceId: string): Omit<Kept, "fingerprint"> {
  const days = count(db, "usage_days WHERE device_id = ?", deviceId);
  const phone = phoneRules(db, deviceId);
  const rules = phone.rules.limits.length + phone.rules.schedules.length;
  return {
    category: "screen_time",
    title: COLLECTED_TITLES.screen_time,
    goes: days ? [`${plural(days, "day")} of screen time: minutes in each app, opens, the hours the phone was used, and unlocks`] : [],
    stopping: phone.settings.measure ? "Measuring turns off: the phone stops sending how long apps are used." : "Measuring is off: the phone doesn't send how long apps are used.",
    stays: rules
      ? [
          `This phone's ${plural(phone.rules.limits.length, "time limit")} and ${plural(phone.rules.schedules.length, "schedule")}: while it has them, its check-ins still say whether each limit is used up today and which schedule is on (Off belay has none).`,
        ]
      : [],
    anything: days > 0 || phone.settings.measure,
  };
}

function locationKept(db: DB, deviceId: string): Omit<Kept, "fingerprint"> {
  const fixes = count(db, "fixes WHERE device_id = ?", deviceId);
  const events = count(db, "place_events WHERE device_id = ?", deviceId);
  const places = listPlaces(db, deviceId);
  const checks = count(db, "commands WHERE device_id = ? AND kind = 'locate_now'", deviceId);
  const s = locationSettings(db, deviceId);
  const on = s !== null && (s.mode !== "off" || s.keepOn || s.lost !== null);
  const goes = [
    ...(fixes ? [`${plural(fixes, "fix", "fixes")} (where the phone was), including any shared with a help request`] : []),
    ...(events ? [plural(events, "arrival or departure", "arrivals and departures")] : []),
    ...(places.length ? [`${plural(places.length, "place")}: ${places.map((p) => p.name).join(", ")}`] : []),
    ...(checks ? [`the record of ${plural(checks, "check")} of where the phone was`] : []),
  ];
  return {
    category: "location",
    title: COLLECTED_TITLES.location,
    goes,
    stopping: on
      ? "Location turns off, with lost mode and keeping location on: Belay stops taking fixes, and gives up the location permission."
      : "Location is off: Belay takes no fixes.",
    stays: ["A help request still carries where the phone is if the kid chooses to share it, once, as it always can."],
    anything: goes.length > 0 || on,
  };
}

function callsKept(db: DB, deviceId: string): Omit<Kept, "fingerprint"> {
  const records = count(db, "call_records WHERE device_id = ?", deviceId);
  const s = callSettings(db, deviceId);
  const rules = listContacts(db, deviceId).length + listNumbers(db, deviceId, "private").length + listNumbers(db, deviceId, "blocked").length;
  return {
    category: "calls",
    title: COLLECTED_TITLES.calls,
    goes: records ? [`${plural(records, "call record")}: who called whom, when, for how long, and what happened`] : [],
    stopping: s?.log
      ? "Recording calls turns off: the phone stops sending who calls and who is called."
      : "Calls aren't recorded: the phone doesn't send who calls and who is called.",
    stays: [
      ...(s?.enabled ? ["Calls stay on, with their rules: Belay as the phone app still decides who rings."] : []),
      ...(rules ? ["The contacts, and the private and blocked numbers: they're this phone's rules."] : []),
    ],
    anything: records > 0 || s?.log === true,
  };
}

function requestsKept(db: DB, deviceId: string, now: number): Omit<Kept, "fingerprint"> {
  const recent = now - PHONE_KEEPS_REQUESTS_MS;
  const closed = `requests WHERE device_id = ? AND NOT ${KEPT_REQUEST}`;
  const words = count(db, `${closed} AND ${KID_WORDS}`, deviceId);
  const notes = count(db, `${closed} AND note IS NOT NULL`, deviceId);
  const old = count(db, `${closed} AND received_at < ? AND asked_at < ?`, deviceId, recent, recent);
  const bare = count(db, `${closed} AND (received_at >= ? OR asked_at >= ?)`, deviceId, recent, recent);
  const shared = count(db, `fixes WHERE device_id = ? AND reason = 'help' AND request_id IN (SELECT id FROM ${closed})`, deviceId, deviceId);
  const waiting = count(db, `requests WHERE device_id = ? AND ${KEPT_REQUEST}`, deviceId);
  const goes = [
    ...(words ? [`what the kid wrote in ${plural(words, "request")}`] : []),
    ...(notes ? [`your notes on ${plural(notes, "answer")} (they go from the kid's phone too)`] : []),
    ...(shared ? [`where the phone was, shared with ${plural(shared, "help request")}`] : []),
    ...(old ? [`${plural(old, "request")} from more than 60 days ago, entirely`] : []),
  ];
  return {
    category: "requests",
    title: COLLECTED_TITLES.requests,
    goes,
    stopping: "The kid can always ask for things, so new requests still reach you, and \"I need help\" always does.",
    stays: [
      ...(waiting ? [`${plural(waiting, "request")} waiting for you (or a help request nobody has seen), as ${waiting === 1 ? "it is" : "they are"}.`] : []),
      ...(bare
        ? [`For ${plural(bare, "request")} of the last 60 days, that the kid asked (for which app, or what) and your answer, without anyone's words: the kid's phone keeps its own list that long, and still shows your answers.`]
        : []),
    ],
    anything: goes.length > 0,
  };
}

const fingerprintOf = (kept: Omit<Kept, "fingerprint">): string =>
  createHash("sha256").update(JSON.stringify([kept.category, kept.goes, kept.stopping])).digest("base64url").slice(0, 22);

/** What the server keeps about the phone in one category, and what stopping it would do. */
export function keptFor(db: DB, deviceId: string, category: Collected, now: number): Kept {
  const kept =
    category === "apps"
      ? appsKept(db, deviceId)
      : category === "screen_time"
        ? screenTimeKept(db, deviceId)
        : category === "location"
          ? locationKept(db, deviceId)
          : category === "calls"
            ? callsKept(db, deviceId)
            : requestsKept(db, deviceId, now);
  return { ...kept, fingerprint: fingerprintOf(kept) };
}

/** Every category, for the phone's page. */
export function keptAbout(db: DB, deviceId: string, now: number): Kept[] {
  return COLLECTED.map((category) => keptFor(db, deviceId, category, now));
}

export const isCollected = (value: string): value is Collected => (COLLECTED as readonly string[]).includes(value);

/** The rows it deleted (or erased), by kind, for the activity log. */
export type Deleted = Record<string, number>;

function deleteApps(db: DB, deviceId: string): Deleted {
  return {
    app_changes: db.prepare("DELETE FROM app_events WHERE device_id = ?").run(deviceId).changes,
    reviews: db.prepare("DELETE FROM reviews WHERE device_id = ?").run(deviceId).changes,
    removed_apps: db.prepare(`DELETE FROM ${REMOVED_APPS}`).run(deviceId).changes,
    app_lists: db.prepare("DELETE FROM snapshots WHERE device_id = ?").run(deviceId).changes,
  };
}

function deleteScreenTime(db: DB, deviceId: string): Deleted {
  // usage_apps goes with its day.
  return { days: db.prepare("DELETE FROM usage_days WHERE device_id = ?").run(deviceId).changes };
}

function deleteLocation(db: DB, deviceId: string): Deleted {
  return {
    fixes: db.prepare("DELETE FROM fixes WHERE device_id = ?").run(deviceId).changes,
    place_events: db.prepare("DELETE FROM place_events WHERE device_id = ?").run(deviceId).changes,
    places: db.prepare("DELETE FROM places WHERE device_id = ?").run(deviceId).changes,
    checks: db.prepare("DELETE FROM commands WHERE device_id = ? AND kind = 'locate_now'").run(deviceId).changes,
  };
}

function deleteCalls(db: DB, deviceId: string): Deleted {
  return { call_records: db.prepare("DELETE FROM call_records WHERE device_id = ?").run(deviceId).changes };
}

function deleteRequests(db: DB, deviceId: string, now: number): Deleted {
  const recent = now - PHONE_KEEPS_REQUESTS_MS;
  const closed = `device_id = ? AND NOT ${KEPT_REQUEST}`;
  const words = count(db, `requests WHERE ${closed} AND ${KID_WORDS}`, deviceId);
  const notes = count(db, `requests WHERE ${closed} AND note IS NOT NULL`, deviceId);
  const shared = db.prepare(`DELETE FROM fixes WHERE device_id = ? AND reason = 'help' AND request_id IN (SELECT id FROM requests WHERE ${closed})`).run(deviceId, deviceId).changes;
  const old = db.prepare(`DELETE FROM requests WHERE ${closed} AND received_at < ? AND asked_at < ?`).run(deviceId, recent, recent).changes;
  // The rest the kid's phone still shows: a bare record (what was asked, when, and the answer), so
  // it still shows the answer and doesn't offer it as waiting again. A contact request needs a
  // name: its number, which (like an app's package) is what was asked, not the kid's words.
  db.prepare(
    `UPDATE requests SET reason = NULL, note = NULL, contact_name = CASE WHEN kind = 'contact' THEN contact_number ELSE contact_name END WHERE ${closed}`,
  ).run(deviceId);
  return { words, notes, shared_fixes: shared, old_requests: old };
}

/**
 * Stops collecting one category on the phone and deletes what's kept of it, in one transaction:
 * the switch first (a change of the phone's rules, logged as itself), then the rows. `fingerprint`
 * is the confirmation's: if what goes changed since the parent looked, nothing happens and the
 * caller shows the list again.
 */
export function stopCollecting(ctx: PolicyContext, deviceId: string, category: Collected, who: Person, fingerprint: string): Changed<{ deleted: Deleted }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a parent stops collecting and deletes a phone's data: an AI app can't");
  const { db, now } = ctx;
  return db.transaction(() => {
    if (keptFor(db, deviceId, category, now).fingerprint !== fingerprint) {
      throw new RuleRefused("Nothing was deleted: what the server keeps changed since you looked. Check the list again.");
    }
    if (category === "screen_time" && phoneRules(db, deviceId).settings.measure) setPhoneSettings(ctx, deviceId, { measure: false }, who);
    if (category === "location") {
      const s = locationSettings(db, deviceId);
      if (s?.lost) setLost(ctx, deviceId, null, who);
      if (s && (s.mode !== "off" || s.keepOn)) setLocation(ctx, deviceId, { mode: "off", keepOn: false }, who);
    }
    if (category === "calls" && callSettings(db, deviceId)?.log) setCalls(ctx, deviceId, { log: false }, who);
    return changePolicy(ctx, deviceId, who, (log) => {
      const deleted =
        category === "apps"
          ? deleteApps(db, deviceId)
          : category === "screen_time"
            ? deleteScreenTime(db, deviceId)
            : category === "location"
              ? deleteLocation(db, deviceId)
              : category === "calls"
                ? deleteCalls(db, deviceId)
                : deleteRequests(db, deviceId, now);
      log("collection.stopped", { category, deleted });
      return { deleted };
    });
  }).immediate();
}
