/**
 * Each phone's screen-time rules as the server keeps them, and the policy's `screen_time` and
 * `stage` built from them (docs/protocol.md, "Screen time rules"). Reads and writes only: the
 * changes, with who may make them, are in changes.ts.
 *
 * A stage is a named set of rules, family-wide. A phone on a stage gets the stage's rules with
 * the phone's own changes on top: each limit or schedule of the stage kept, changed for this
 * phone or removed from it, and the phone's own ones besides; exempt apps added or taken off;
 * and its own self-serve, "can't count" rule and warnings if it has them. Moving a phone to
 * another stage clears those changes, so it gets exactly the new stage's rules. measure, zone and
 * day_starts are the family's settings for the phone, never a stage's.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DB } from "../../db.js";
import { type Policy, ScreenTime } from "../../device/schemas.js";
import { getSettings } from "../../settings.js";
import { cleanText, oneLine } from "../../text.js";
import { type RulesSide, stageChanges } from "./classify.js";
import { addDays, dayAt, dayClock, resolveZone } from "./days.js";
import { tidyLimit, tidySchedule } from "./names.js";
import { type Labels, changeSentence } from "./words.js";

export type Limit = ScreenTime["limits"][number];
export type Schedule = ScreenTime["schedules"][number];
export type SelfServe = NonNullable<ScreenTime["self_serve"]>;
export type IfUnmeasured = ScreenTime["if_unmeasured"];
export type Extra = ScreenTime["extra"][number];

/** What a stage bundles. */
export interface RuleSet {
  limits: Limit[];
  schedules: Schedule[];
  exempt: string[];
  if_unmeasured: IfUnmeasured;
  self_serve: SelfServe | null;
  warn_before: number;
}

export const NO_RULES: RuleSet = { limits: [], schedules: [], exempt: [], if_unmeasured: "pause_limited", self_serve: null, warn_before: 5 };

/** The family's settings for one phone. */
export interface PhoneSettings {
  /** Count app time and send it to the server (POST /usage). Limits are counted on the phone either way. */
  measure: boolean;
  /** An IANA zone, or "phone". */
  zone: string;
  /** "HH:MM": when a day's limits reset. */
  day_starts: string;
}

export const DEFAULT_PHONE_SETTINGS: PhoneSettings = { measure: false, zone: "phone", day_starts: "00:00" };

/** One of the phone's own: a limit or schedule of its own, one of its stage's changed for it, or one of its stage's removed. */
export type OwnEntry<T> = { id: string; rule: T; ofStage: boolean } | { id: string; removed: true };

/** A phone's own rules, on top of its stage's. Null scalars: the stage's. */
export interface OwnRules {
  limits: OwnEntry<Limit>[];
  schedules: OwnEntry<Schedule>[];
  exempt: { add: string[]; remove: string[] };
  if_unmeasured: IfUnmeasured | null;
  /** Undefined: the stage's; null: none for this phone. */
  self_serve: SelfServe | null | undefined;
  warn_before: number | null;
}

export const NO_OWN: OwnRules = { limits: [], schedules: [], exempt: { add: [], remove: [] }, if_unmeasured: null, self_serve: undefined, warn_before: null };

// ── Ids ─────────────────────────────────────────────────────────────────

/** "l-…", "s-…", "x-…": short, random, and valid as the policy's rule ids. */
export function newRuleId(prefix: "l" | "s" | "x"): string {
  return `${prefix}-${randomBytes(9).toString("base64url")}`;
}

// ── Reading stored JSON, leniently: what doesn't read is left out ──────

const LimitSchema = ScreenTime.shape.limits.element;
const ScheduleSchema = ScreenTime.shape.schedules.element;
const SelfServeSchema = ScreenTime.shape.self_serve.unwrap();
const packages = z.array(z.string());

function json(text: string | null | undefined): unknown {
  if (text === null || text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function parsedList<T>(value: unknown, schema: z.ZodType<T>): T[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v) => {
    const parsed = schema.safeParse(v);
    return parsed.success ? [parsed.data] : [];
  });
}

export function parseRuleSet(text: string | null | undefined): RuleSet {
  const raw = json(text);
  const r = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const exempt = packages.safeParse(r.exempt);
  const selfServe = SelfServeSchema.safeParse(r.self_serve);
  // Names as the kid sees them, kept before Belay tidied every name it saves (names.ts) included.
  return {
    limits: parsedList(r.limits, LimitSchema).map((l) => tidyLimit(l)),
    schedules: parsedList(r.schedules, ScheduleSchema).map(tidySchedule),
    exempt: exempt.success ? [...new Set(exempt.data)].sort() : [],
    if_unmeasured: r.if_unmeasured === "keep_open" ? "keep_open" : "pause_limited",
    self_serve: selfServe.success ? selfServe.data : null,
    warn_before: typeof r.warn_before === "number" && Number.isInteger(r.warn_before) && r.warn_before >= 0 && r.warn_before <= 60 ? r.warn_before : 5,
  };
}

function ownEntries<T>(value: unknown, schema: z.ZodType<T>): OwnEntry<T>[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((v): OwnEntry<T>[] => {
    if (!v || typeof v !== "object") return [];
    const e = v as Record<string, unknown>;
    if (typeof e.id !== "string") return [];
    if (e.removed === true) return [{ id: e.id, removed: true }];
    const rule = schema.safeParse(e.rule);
    return rule.success ? [{ id: e.id, rule: rule.data, ofStage: e.ofStage === true }] : [];
  });
}

// ── A phone's rules, and its stage's ───────────────────────────────────

interface RulesRow {
  measure: number;
  zone: string;
  day_starts: string;
  limits: string;
  schedules: string;
  exempt: string;
  if_unmeasured: IfUnmeasured | null;
  self_serve: string | null;
  warn_before: number | null;
  changed_at: number;
}

export function phoneRow(db: DB, deviceId: string): { settings: PhoneSettings; own: OwnRules; changedAt: number | null } {
  const row = db.prepare<[string], RulesRow>("SELECT * FROM screen_time_rules WHERE device_id = ?").get(deviceId);
  if (!row) return { settings: { ...DEFAULT_PHONE_SETTINGS }, own: structuredClone(NO_OWN), changedAt: null };
  const exempt = json(row.exempt) as { add?: unknown; remove?: unknown } | undefined;
  const add = packages.safeParse(exempt?.add);
  const remove = packages.safeParse(exempt?.remove);
  const selfServe = row.self_serve === null ? undefined : row.self_serve === "null" ? null : SelfServeSchema.safeParse(json(row.self_serve));
  return {
    settings: { measure: row.measure === 1, zone: row.zone, day_starts: row.day_starts },
    own: {
      limits: ownEntries(json(row.limits), LimitSchema).map((e) => ("rule" in e ? { ...e, rule: tidyLimit(e.rule) } : e)),
      schedules: ownEntries(json(row.schedules), ScheduleSchema).map((e) => ("rule" in e ? { ...e, rule: tidySchedule(e.rule) } : e)),
      exempt: { add: add.success ? add.data : [], remove: remove.success ? remove.data : [] },
      if_unmeasured: row.if_unmeasured,
      self_serve: selfServe === undefined || selfServe === null ? selfServe : selfServe.success ? selfServe.data : undefined,
      warn_before: row.warn_before,
    },
    changedAt: row.changed_at,
  };
}

export function savePhoneRow(db: DB, deviceId: string, settings: PhoneSettings, own: OwnRules, now: number): void {
  db.prepare(
    `INSERT INTO screen_time_rules (device_id, measure, zone, day_starts, limits, schedules, exempt, if_unmeasured, self_serve, warn_before, changed_at)
     VALUES (@device_id, @measure, @zone, @day_starts, @limits, @schedules, @exempt, @if_unmeasured, @self_serve, @warn_before, @now)
     ON CONFLICT (device_id) DO UPDATE SET measure = excluded.measure, zone = excluded.zone, day_starts = excluded.day_starts,
       limits = excluded.limits, schedules = excluded.schedules, exempt = excluded.exempt, if_unmeasured = excluded.if_unmeasured,
       self_serve = excluded.self_serve, warn_before = excluded.warn_before, changed_at = excluded.changed_at`,
  ).run({
    device_id: deviceId,
    measure: settings.measure ? 1 : 0,
    zone: settings.zone,
    day_starts: settings.day_starts,
    limits: JSON.stringify(own.limits),
    schedules: JSON.stringify(own.schedules),
    exempt: JSON.stringify(own.exempt),
    if_unmeasured: own.if_unmeasured,
    self_serve: own.self_serve === undefined ? null : JSON.stringify(own.self_serve),
    warn_before: own.warn_before,
    now,
  });
}

export interface StageView {
  id: string;
  number: number;
  name: string;
  /** The family's words: how to reach this stage, shown on the phone under the one before. */
  how: string | null;
  rules: RuleSet;
  createdAt: number;
  updatedAt: number;
  updatedBy: string | null;
  /** Phase 11: Off belay, the family's last stage (family/offbelay): it blocks nothing, and keeps its name and place. */
  offBelay: boolean;
}

interface StageRow {
  id: string;
  number: number;
  name: string;
  how: string | null;
  rules: string;
  created_at: number;
  updated_at: number;
  updated_by_name: string | null;
  off_belay: number;
}

const STAGE_SELECT = "SELECT s.*, p.name AS updated_by_name FROM stages s LEFT JOIN parents p ON p.id = s.updated_by";

const toStage = (r: StageRow): StageView => ({
  id: r.id,
  number: r.number,
  name: r.name,
  how: r.how,
  rules: parseRuleSet(r.rules),
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by_name,
  offBelay: r.off_belay === 1,
});

/** The family's stages, first one first. */
export function listStages(db: DB): StageView[] {
  return db.prepare<[], StageRow>(`${STAGE_SELECT} ORDER BY s.number`).all().map(toStage);
}

export function getStage(db: DB, id: string): StageView | null {
  const row = db.prepare<[string], StageRow>(`${STAGE_SELECT} WHERE s.id = ?`).get(id);
  return row ? toStage(row) : null;
}

/** A stage by its name, ignoring case and surrounding space. */
export function findStageByName(db: DB, name: string): StageView | null {
  const row = db.prepare<[string], StageRow>(`${STAGE_SELECT} WHERE s.name = ? COLLATE NOCASE`).get(name.trim());
  return row ? toStage(row) : null;
}

/** Phase 11: Off belay, the family's last stage (every family has it, from migration 8). */
export function offBelayStage(db: DB): StageView | null {
  const row = db.prepare<[], StageRow>(`${STAGE_SELECT} WHERE s.off_belay = 1`).get();
  return row ? toStage(row) : null;
}

/** The stage after this one (the next number up), if any. */
export function nextStage(db: DB, number: number): StageView | null {
  const row = db.prepare<[number], StageRow>(`${STAGE_SELECT} WHERE s.number > ? ORDER BY s.number LIMIT 1`).get(number);
  return row ? toStage(row) : null;
}

export interface PhoneStage {
  stage: StageView;
  since: number;
  setBy: string | null;
}

export function phoneStage(db: DB, deviceId: string): PhoneStage | null {
  const row = db
    .prepare<[string], { stage_id: string; since: number; set_by_name: string | null }>(
      "SELECT ps.stage_id, ps.since, p.name AS set_by_name FROM phone_stages ps LEFT JOIN parents p ON p.id = ps.set_by WHERE ps.device_id = ?",
    )
    .get(deviceId);
  const stage = row ? getStage(db, row.stage_id) : null;
  return row && stage ? { stage, since: row.since, setBy: row.set_by_name } : null;
}

/** The phones on a stage. */
export function phonesOnStage(db: DB, stageId: string): { id: string; name: string }[] {
  return db
    .prepare<[string], { id: string; name: string }>(
      "SELECT d.id, d.name FROM phone_stages ps JOIN devices d ON d.id = ps.device_id WHERE ps.stage_id = ? ORDER BY d.name COLLATE NOCASE",
    )
    .all(stageId);
}

// ── Putting a phone's own on top of its stage's, and back ──────────────

/** A stable form for comparing rules: object keys sorted. */
export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : v,
  );
}
const same = (a: unknown, b: unknown) => canonical(a) === canonical(b);

function mergeList<T extends { id: string }>(base: T[], own: OwnEntry<T>[]): T[] {
  const byId = new Map(own.map((e) => [e.id, e]));
  const baseIds = new Set(base.map((r) => r.id));
  const out: T[] = [];
  for (const rule of base) {
    const entry = byId.get(rule.id);
    if (!entry) out.push(rule);
    else if ("rule" in entry) out.push({ ...entry.rule, id: rule.id });
  }
  // A change to a stage's rule that's no longer in the stage is dropped with it.
  for (const entry of own) if ("rule" in entry && !entry.ofStage && !baseIds.has(entry.id)) out.push(entry.rule);
  return out;
}

/** The rules a phone gets: its stage's (or none), with its own on top. */
export function merge(stage: RuleSet | null, own: OwnRules): RuleSet {
  const base = stage ?? NO_RULES;
  const remove = new Set(own.exempt.remove);
  return {
    limits: mergeList(base.limits, own.limits),
    schedules: mergeList(base.schedules, own.schedules),
    exempt: [...new Set([...base.exempt.filter((p) => !remove.has(p)), ...own.exempt.add])].sort(),
    if_unmeasured: own.if_unmeasured ?? base.if_unmeasured,
    self_serve: own.self_serve !== undefined ? own.self_serve : base.self_serve,
    warn_before: own.warn_before ?? base.warn_before,
  };
}

function ownList<T extends { id: string }>(base: T[], wanted: T[]): OwnEntry<T>[] {
  const byId = new Map(wanted.map((r) => [r.id, r]));
  const baseIds = new Set(base.map((r) => r.id));
  const out: OwnEntry<T>[] = [];
  for (const rule of base) {
    const want = byId.get(rule.id);
    if (!want) out.push({ id: rule.id, removed: true });
    else if (!same(want, rule)) out.push({ id: rule.id, rule: want, ofStage: true });
  }
  for (const rule of wanted) if (!baseIds.has(rule.id)) out.push({ id: rule.id, rule, ofStage: false });
  return out;
}

/** The phone's own rules that, on top of its stage's, give exactly `wanted`. */
export function ownFor(stage: RuleSet | null, wanted: RuleSet): OwnRules {
  const base = stage ?? NO_RULES;
  return {
    limits: ownList(base.limits, wanted.limits),
    schedules: ownList(base.schedules, wanted.schedules),
    exempt: { add: wanted.exempt.filter((p) => !base.exempt.includes(p)).sort(), remove: base.exempt.filter((p) => !wanted.exempt.includes(p)).sort() },
    if_unmeasured: wanted.if_unmeasured === base.if_unmeasured ? null : wanted.if_unmeasured,
    self_serve: same(wanted.self_serve, base.self_serve) ? undefined : wanted.self_serve,
    warn_before: wanted.warn_before === base.warn_before ? null : wanted.warn_before,
  };
}

/** Where each limit or schedule comes from, for the phone's page: its stage, changed for it, or its own. */
export type Origin = "stage" | "changed" | "own";

export interface PhoneRules {
  settings: PhoneSettings;
  /** What the phone gets. */
  rules: RuleSet;
  stage: PhoneStage | null;
  own: OwnRules;
  origin: (id: string) => Origin;
  /** The stage's limits and schedules removed for this phone. */
  removedFromStage: { limits: Limit[]; schedules: Schedule[] };
  changedAt: number | null;
}

export function phoneRules(db: DB, deviceId: string): PhoneRules {
  const { settings, own, changedAt } = phoneRow(db, deviceId);
  const stage = phoneStage(db, deviceId);
  const base = stage?.stage.rules ?? null;
  const byId = new Map([...own.limits, ...own.schedules].map((e) => [e.id, e]));
  const baseIds = new Set([...(base?.limits ?? []), ...(base?.schedules ?? [])].map((r) => r.id));
  const removed = new Set([...own.limits, ...own.schedules].filter((e) => "removed" in e).map((e) => e.id));
  return {
    settings,
    rules: merge(base, own),
    stage,
    own,
    origin: (id) => (!baseIds.has(id) ? "own" : byId.has(id) ? "changed" : "stage"),
    removedFromStage: { limits: (base?.limits ?? []).filter((l) => removed.has(l.id)), schedules: (base?.schedules ?? []).filter((s) => removed.has(s.id)) },
    changedAt,
  };
}

// ── Today, extra time, and the policy ──────────────────────────────────

/** The zone the phone's days follow now: its rules' zone, "phone" being the zone it last reported. */
export function phoneZone(db: DB, deviceId: string, settings: PhoneSettings): string {
  const facts = db.prepare<[string], { tz: string | null }>("SELECT json_extract(facts, '$.timezone') AS tz FROM devices WHERE id = ?").get(deviceId);
  return resolveZone(settings.zone, facts?.tz ?? null, getSettings(db).timezone);
}

/** The phone's day now, as its rules count days ("YYYY-MM-DD"). */
export function phoneDay(db: DB, deviceId: string, now: number, settings = phoneRow(db, deviceId).settings): string {
  return dayAt(now, dayClock(phoneZone(db, deviceId, settings), settings.day_starts));
}

export interface ExtraView extends Extra {
  givenAt: number;
  givenBy: string | null;
}

/** Extra time a parent gave for these days or later, oldest first, at most 100 (the policy's limit). */
export function extraSince(db: DB, deviceId: string, fromDay: string): ExtraView[] {
  return db
    .prepare<[string, string], { id: string; limit_id: string; minutes: number; day: string; request_id: string | null; package: string | null; given_at: number; given_by_name: string | null }>(
      `SELECT x.id, x.limit_id, x.minutes, x.day, x.request_id, x.package, x.given_at, p.name AS given_by_name FROM extra_time x
       LEFT JOIN parents p ON p.id = x.given_by WHERE x.device_id = ? AND x.day >= ? ORDER BY x.given_at DESC, x.rowid DESC LIMIT 100`,
    )
    .all(deviceId, fromDay)
    .reverse()
    .map((r) => ({ id: r.id, limit_id: r.limit_id, minutes: r.minutes, day: r.day, request_id: r.request_id, package: r.package, givenAt: r.given_at, givenBy: r.given_by_name }));
}

/** Records extra time for one of the phone's days. Returns its id. */
export function insertExtra(
  db: DB,
  deviceId: string,
  e: { limitId: string; minutes: number; package: string | null; requestId: string | null; day: string },
  now: number,
  givenBy: string | null,
): string {
  const id = newRuleId("x");
  db.prepare("INSERT INTO extra_time (id, device_id, limit_id, package, minutes, day, request_id, given_at, given_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)").run(
    id,
    deviceId,
    e.limitId,
    e.package,
    e.minutes,
    e.day,
    e.requestId,
    now,
    givenBy,
  );
  return id;
}

/** Whether these rules enforce or collect anything: without, the policy's screen_time is null. */
export function decidesSomething(settings: PhoneSettings, rules: RuleSet): boolean {
  return settings.measure || rules.limits.length > 0 || rules.schedules.length > 0;
}

/**
 * The policy's `screen_time`: the stage's rules with the phone's own on top, and the extra time
 * for the phone's day (and the day before, in case the phone's clock is behind the server's).
 * Null when it would measure nothing and limit nothing.
 */
export function screenTimeFor(db: DB, deviceId: string, now: number, phone = phoneRules(db, deviceId)): Policy["screen_time"] {
  if (!decidesSomething(phone.settings, phone.rules)) return null;
  const today = phoneDay(db, deviceId, now, phone.settings);
  const extra = extraSince(db, deviceId, addDays(today, -1)).map(({ givenAt: _at, givenBy: _by, ...e }) => e);
  return { ...phone.settings, ...structuredClone(phone.rules), extra };
}

/** An app's name on this phone, from its app list (or a request), else its package name. */
export function phoneLabels(db: DB, deviceId: string): Labels {
  const find = db.prepare<[string, string], { label: string }>("SELECT label FROM apps WHERE device_id = ? AND package = ?");
  return (pkg) => find.get(deviceId, pkg)?.label ?? pkg;
}

/** An app's name on any of the family's phones, for a stage's words. */
export function familyLabels(db: DB): Labels {
  const find = db.prepare<[string], { label: string }>("SELECT label FROM apps WHERE package = ? ORDER BY present DESC, install_seen_at DESC LIMIT 1");
  return (pkg) => find.get(pkg)?.label ?? pkg;
}

/** The rules as one side of a change, with the phone's settings and stage. */
export function sideOf(settings: PhoneSettings, rules: RuleSet, stage: { number: number; name: string } | null = null): RulesSide {
  return { ...settings, ...rules, stage };
}

/**
 * The policy's `stage`, for the kid's screen: the stage, and the next one with what it changes
 * in the kid's words (the same changes the phone's Stages.changes finds) and its rules, which
 * are what the phone gets when it moves there. `label` names the apps in those words (the
 * phone's own names for them); null counts them instead, for an AI app with the Apps category off.
 */
export function stageFor(db: DB, deviceId: string, phone = phoneRules(db, deviceId), label: Labels | null = phoneLabels(db, deviceId)): Policy["stage"] {
  if (!phone.stage) return null;
  const { stage, since } = phone.stage;
  const next = nextStage(db, stage.number);
  return {
    name: oneLine(stage.name, 60),
    number: stage.number,
    since,
    next: next
      ? {
          name: oneLine(next.name, 60),
          unlocks: stageChanges(sideOf(phone.settings, phone.rules), sideOf(phone.settings, next.rules))
            .slice(0, 30)
            .map((c) => changeSentence(c, { for: "kid", label })),
          how: next.how === null ? null : cleanText(next.how, 1000) || null,
          screen_time: decidesSomething(phone.settings, next.rules) ? { ...phone.settings, ...structuredClone(next.rules), extra: [] } : null,
        }
      : null,
  };
}
