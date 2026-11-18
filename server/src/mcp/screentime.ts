/**
 * Phase 3 over MCP (docs/design/phase3-screen-time.md, "MCP"): screen time and the rules, read;
 * change_screen_time, which applies a change only when it only tightens and otherwise records a
 * proposal for a parent; and lock_phone, which tightens (the family_check_in prompt is in
 * prompts.ts). Names the family wrote (limits, schedules, stages, the agreement) and app names
 * are in `untrusted` fields; screen time is under the `screen_time` scope, the stage and
 * agreement under `agreement`. Every call is in the activity log.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { packageName, ruleId } from "../device/schemas.js";
import { type CommandState, listCommands } from "../family/commands.js";
import { type DeviceRow, deviceFacts, findDeviceByName, listDevices } from "../family/devices.js";
import { type Changer, LOCK_MINUTES, LOCK_NOW_MS, RuleRefused, lockPhone, type PolicyContext } from "../family/policy.js";
import { MAX_PENDING_PROPOSALS, changeWords, createProposal, listProposals, screenTimeWords } from "../family/proposals.js";
import { recentRequests } from "../family/requests.js";
import { currentAgreement } from "../family/screentime/agreement.js";
import { AI_MIN_SCHEDULE_MINUTES, aiScheduleProblem, locksTouched, setPhoneRules } from "../family/screentime/changes.js";
import { classifyScreenTimeChange } from "../family/screentime/classify.js";
import { WEEKDAYS, addDays, validDay, weekdayOf } from "../family/screentime/days.js";
import { NAME_MAX, SCHEDULE_NAMES, appNamesOn, limitName } from "../family/screentime/names.js";
import { patchOf } from "../family/screentime/patch.js";
import {
  type Limit,
  type RuleSet,
  type Schedule,
  canonical,
  extraSince,
  findStageByName,
  listStages,
  newRuleId,
  phoneDay,
  phoneLabels,
  phoneRules,
  phoneZone,
  sideOf,
  stageFor,
} from "../family/screentime/rules.js";
import { GAP_WORDS, oneEach, usageDays } from "../family/screentime/usage.js";
import { changeSentence } from "../family/screentime/words.js";
import { notifyParents, proposalNotice } from "../push.js";
import { AI_PER_HOUR } from "../ratelimit.js";
import { type AiScope, AI_SCOPES, getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { isValidTimeZone, isoInZone } from "../time.js";
import { aiCounted, aiLimited, aiRefused } from "./limits.js";
import type { Caller } from "./server.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const TIGHTEN = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const deviceParam = z.string().min(1).max(100).describe("The phone's name, as list_devices shows it");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day like 2026-11-16");
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "a time like 21:00");
const dayMinutes = z.int().min(0).max(1440);
const weekday = z.enum(WEEKDAYS as [string, ...string[]]) as z.ZodType<Schedule["days"][number]>;

const STATE_WORDS = { open: "time left", used_up: "used up", extra: "used up, running on extra time" } as const;
const LOCK_STATE_WORDS: Record<CommandState, string> = {
  waiting: "sent, waiting for the phone",
  done: "done: the phone locked its screen",
  failed: "the phone couldn't lock its screen",
  expired: "not done: the phone got it too late, so it didn't lock",
  not_done: "not done: the phone didn't get it in time",
  replaced: "replaced by a newer one",
};
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;
/** At most this many days in one get_screen_time. */
const MAX_DAYS = 92;

const isTotal = (l: Limit) => l.packages.includes("*");

/** With the Apps category off: the rules' apps, counted, never named. */
const APPS_HIDDEN =
  "A parent turned off AI access to apps in Belay's settings, so the apps under each rule are only counted: their names and package names are hidden. The names of limits and schedules are the family's (or the one Belay gave a limit after its apps), as the kid sees them.";

export function registerScreenTimeTools(server: McpServer, deps: Deps, caller: Caller): void {
  const { db } = deps;
  const ai: Changer = { kind: "ai", parentId: caller.parentId, clientName: caller.clientName };
  const ctx = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });
  const tz = () => getSettings(db).timezone;
  const iso = (ms: number | null | undefined) => (ms == null ? null : isoInZone(ms, tz()));
  const scopeOn = (scope: AiScope) => getSettings(db).aiScopes[scope];
  const scopeOff = (scope: AiScope): CallToolResult | null =>
    scopeOn(scope) ? null : refusal(`A parent turned off AI access to ${AI_SCOPES[scope].split(":")[0]?.toLowerCase() ?? scope} in Belay's settings, so this isn't available.`);
  const logRead = (what: string, deviceId: string) => {
    audit(db, deps.now(), ai, "ai.read", { deviceId, detail: { what } });
  };
  const phone = (name: string): DeviceRow | CallToolResult => {
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), deps.now()).map((d) => d.name);
    return refusal(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };
  const isRefusal = (v: DeviceRow | CallToolResult): v is CallToolResult => "content" in v;
  const parentsPage = (path: string) => `${deps.config.publicUrl}${path}`;

  /**
   * The phone's rules, in words: ids in plain fields (for change_screen_time), the family's names
   * and apps untrusted. With the Apps category off (`apps` false), the apps under each rule are
   * only counted: a package name says which app is on the phone as plainly as its label does.
   */
  const rulesEntry = (deviceId: string, apps: boolean) => {
    const p = phoneRules(db, deviceId);
    const label = phoneLabels(db, deviceId);
    const app = (pkg: string) => ({ label: label(pkg), package: pkg });
    const from = (id: string) => (p.stage ? { from: { stage: "the stage's", changed: "the stage's, changed for this phone", own: "this phone's own" }[p.origin(id)] } : {});
    return {
      ...(apps ? {} : { which_apps: APPS_HIDDEN }),
      measuring: p.settings.measure
        ? "on: the phone sends how long apps are used, for get_screen_time"
        : "off: the phone counts only to enforce its limits, and sends no minutes. Only a parent turns measuring on, on the parent page.",
      days: { follow: p.settings.zone === "phone" ? "the phone's own time zone" : p.settings.zone, limits_reset_at: p.settings.day_starts },
      limits: p.rules.limits.map((l) => ({
        id: l.id,
        ...(isTotal(l) ? { daily_total: "every app that isn't exempt" } : apps ? {} : { apps: new Set(l.packages).size }),
        minutes_a_day: l.minutes,
        ...(l.by_day && Object.keys(l.by_day).length ? { minutes_on: l.by_day } : {}),
        ...from(l.id),
        untrusted: { name: l.name, ...(isTotal(l) || !apps ? {} : { apps: [...new Set(l.packages)].map(app) }) },
      })),
      schedules: p.rules.schedules.map((s) => ({
        id: s.id,
        kind: s.kind,
        days: s.days,
        from_time: s.start,
        to_time: s.end,
        ...(s.end <= s.start ? { ends: "the next day" } : {}),
        locks_the_screen: s.lock,
        ...(s.skip.length ? { not_on: s.skip } : {}),
        ...(s.allow.length && !apps ? { stay_open: s.allow.length } : {}),
        ...from(s.id),
        untrusted: { name: s.name, ...(s.allow.length && apps ? { stay_open: s.allow.map(app) } : {}) },
      })),
      exempt: p.rules.exempt.length
        ? { never_counted_or_paused: p.rules.exempt.length, ...(apps ? { untrusted: { apps: p.rules.exempt.map(app) } } : {}) }
        : "none",
      self_serve: p.rules.self_serve ? `the kid may take ${p.rules.self_serve.minutes} more minutes, ${p.rules.self_serve.times} times a day, without asking` : "none",
      when_belay_cant_count: p.rules.if_unmeasured === "pause_limited" ? "apps with a limit are paused (usage access is off)" : "apps with a limit stay open",
      warning: p.rules.warn_before ? `${p.rules.warn_before} minutes before time's up or a schedule starts` : "none",
    };
  };

  // ── get_rules ──────────────────────────────────────────────────────

  server.registerTool(
    "get_rules",
    {
      title: "A phone's screen-time rules",
      description:
        "One phone's screen-time rules: measuring, its limits (with ids, for change_screen_time) and schedules, exempt apps, self-serve, what happens when Belay can't count, extra time given today, the last \"lock now\" and how it went, and proposals waiting for a parent. The apps under each rule need the Apps category: without it they're only counted. With the Screen time category, today's state (\"Games: 20 minutes left\"); with the Requests category, more-time requests waiting; with the Stage and agreement category, the stage, what the next one changes, and the family agreement.",
      inputSchema: { device: deviceParam },
      annotations: READ,
    },
    ({ device }) => {
      const row = phone(device);
      if (isRefusal(row)) return row;
      const now = deps.now();
      logRead("the phone's screen-time rules", row.id);
      const apps = scopeOn("apps");
      // With the Apps category off, words about the rules count apps instead of naming them.
      const label = apps ? phoneLabels(db, row.id) : null;
      const p = phoneRules(db, row.id);
      const names = new Map(p.rules.limits.map((l) => [l.id, l.name]));
      const limitName = (id: string) => (id === "*" ? "every limit" : (names.get(id) ?? "a limit that isn't in the rules any more"));
      const today = phoneDay(db, row.id, now, p.settings);
      const facts = deviceFacts(db, row.id);
      const report = facts?.enforcement?.screen_time;
      const extra = extraSince(db, row.id, today).filter((e) => e.day === today);
      const settings = getSettings(db);
      const proposals = listProposals(db, { deviceId: row.id, status: "pending" }).filter((x) => x.change.kind === "screen_time" || x.change.kind === "move_stage");
      const requests = settings.aiScopes.requests ? recentRequests(db, now, { deviceId: row.id, kind: "more_time", status: "pending" }) : [];
      const agreement = settings.aiScopes.agreement ? currentAgreement(db, row.id) : null;
      const stage = settings.aiScopes.agreement ? stageFor(db, row.id, p, label) : null;
      return result({
        phone: row.name,
        day_on_the_phone: today,
        ...rulesEntry(row.id, apps),
        extra_time_today: extra.map((e) => ({ minutes: e.minutes, given: iso(e.givenAt), by: e.givenBy ?? "the server's admin command", untrusted: { limit: limitName(e.limit_id) } })),
        today: !settings.aiScopes.screen_time
          ? "Hidden: a parent turned off AI access to screen time."
          : report
            ? {
                day: report.day,
                belay_can_count: report.measured ? "yes" : "no: usage access for Belay is off on the phone",
                ...(report.used_minutes != null ? { screen_minutes_so_far: report.used_minutes } : {}),
                limits: report.limits.map((s) => ({
                  id: s.id,
                  state: STATE_WORDS[s.state],
                  ...(s.used != null ? { used_minutes: s.used } : {}),
                  ...(s.left != null ? { minutes_left: s.left } : {}),
                  untrusted: { name: limitName(s.id) },
                })),
                ...(report.schedule ? { schedule_now: { id: report.schedule.id, until: iso(report.schedule.until) } } : {}),
                ...(report.self_serve?.length ? { self_serve_taken: report.self_serve.map((t) => ({ minutes: t.minutes, at: iso(t.at) })) } : {}),
                reported: iso(row.facts_at),
              }
            : "The phone hasn't reported screen time yet.",
        ...(settings.aiScopes.requests
          ? {
              more_time_requests_waiting: requests.map((r) =>
                r.kind === "more_time" ? { asked: iso(Math.min(r.askedAt, r.receivedAt)), minutes: r.minutes, untrusted: { limit: limitName(r.limitId), ...(r.reason ? { reason: r.reason } : {}) } } : {},
              ),
            }
          : {}),
        stage: !settings.aiScopes.agreement
          ? "Hidden: a parent turned off AI access to the stage and agreement."
          : p.stage && stage
            ? {
                number: p.stage.stage.number,
                since: iso(p.stage.since),
                untrusted: { name: stage.name, ...(stage.next ? { next: { name: stage.next.name, how_to_get_there: stage.next.how, what_changes: stage.next.unlocks } } : {}) },
                ...(stage.next ? {} : { next: "This is the last stage." }),
                who_moves_it: "Only a parent moves the phone to another stage, on the parent page. You can propose it with change_screen_time's stage, except Off belay, the last stage: only a parent chooses it.",
              }
            : "This phone isn't on a stage.",
        agreement: !settings.aiScopes.agreement
          ? "Hidden: a parent turned off AI access to the stage and agreement."
          : agreement
            ? {
                version: agreement.version,
                written: iso(agreement.createdAt),
                parents_agreed: iso(agreement.parentsAgreedAt),
                kid: agreement.kidAnswer === "agree" ? `agreed, ${iso(agreement.kidAnsweredAt) ?? ""}` : agreement.kidAnswer === "talk" ? `wants to talk about it (${iso(agreement.kidAnsweredAt) ?? ""})` : "hasn't answered yet",
                untrusted: { sections: agreement.sections },
              }
            : "There's no family agreement for this phone yet.",
        ...((lock) =>
          lock
            ? {
                last_lock: {
                  sent: iso(lock.issuedAt),
                  state: LOCK_STATE_WORDS[lock.state],
                  ...(lock.resultAt !== null ? { phone_said_at: iso(lock.resultAt) } : {}),
                  ...(lock.state === "failed" && lock.problem ? { untrusted: { why_belay_on_the_phone_says: lock.problem } } : {}),
                },
              }
            : {})(listCommands(db, row.id, now, { kind: "lock_now", limit: 5 }).find((x) => x.state !== "replaced")),
        proposals_waiting: proposals.map((x) => ({ proposed: iso(x.createdAt), by: x.clientName, untrusted: { change: changeWords(x.change, x.label, label).title } })),
        how_to_change: `change_screen_time applies a change at once only when it only tightens; anything else, and any schedule that locks the screen, becomes a proposal a parent approves on the parent page (${parentsPage("/proposals")}). lock_phone pauses and locks the phone now.`,
      });
    },
  );

  // ── get_screen_time ────────────────────────────────────────────────

  server.registerTool(
    "get_screen_time",
    {
      title: "Screen time",
      description:
        "How one phone was used, day by day, as the phone counts its days: screen minutes, unlocks, the hours it was used, the apps most used with minutes and opens, and the times Belay couldn't count, with why. Days the phone sent nothing for are listed as not sent: that's not zero. The last 7 days by default, at most 92. Calls and texting are never counted per app. Needs the Screen time category; the apps' names need the Apps category too (without it, their package names).",
      inputSchema: {
        device: deviceParam,
        from: day.optional().describe("The first day, like 2026-11-10. Default: 6 days before `to`."),
        to: day.optional().describe("The last day, included. Default: today on the phone."),
      },
      annotations: READ,
    },
    ({ device, from, to }) => {
      const off = scopeOff("screen_time");
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      const now = deps.now();
      const p = phoneRules(db, row.id);
      const last = to ?? phoneDay(db, row.id, now, p.settings);
      const first = from ?? addDays(last, -6);
      if (!validDay(first) || !validDay(last)) return refusal("from and to must be days that exist, like 2026-11-10.");
      if (first > last) return refusal("from must be on or before to.");
      if (first < addDays(last, -(MAX_DAYS - 1))) return refusal(`Ask for at most ${MAX_DAYS} days at a time.`);
      logRead(`screen time from ${first} to ${last}`, row.id);
      const zone = phoneZone(db, row.id, p.settings);
      // The apps' names come from the phone's app list: with the Apps category off, only the package names the phone counted.
      const named = scopeOn("apps");
      const label = phoneLabels(db, row.id);
      const sent = new Map(oneEach(usageDays(db, row.id, { from: first, to: last })).map((d) => [d.day, d]));
      const days: unknown[] = [];
      for (let d = last; d >= first; d = addDays(d, -1)) {
        const u = sent.get(d);
        if (!u) {
          days.push({ day: d, weekday: DAY_NAMES[weekdayOf(d)], not_sent: "Belay sent nothing for this day: not zero, unknown" });
          continue;
        }
        const rest = u.apps.slice(10);
        days.push({
          day: u.day,
          weekday: DAY_NAMES[weekdayOf(u.day)],
          ...(u.zone !== zone ? (isValidTimeZone(u.zone) ? { counted_in: u.zone } : { untrusted: { counted_in: u.zone } }) : {}),
          day_over: u.complete,
          counted_until: iso(u.asOf),
          screen_minutes: u.screenMinutes,
          unlocks: u.unlocks,
          minutes_by_hour: Object.fromEntries(u.byHour.flatMap((m, h) => (m > 0 ? [[`${String(h).padStart(2, "0")}:00`, m]] : []))),
          top_apps: u.apps.slice(0, 10).map((a) => ({ minutes: a.minutes, opens: a.opens, untrusted: { ...(named ? { label: label(a.package) } : {}), package: a.package } })),
          ...(rest.length ? { other_apps: { count: rest.length, minutes: rest.reduce((n, a) => n + a.minutes, 0) } } : {}),
          couldnt_count: u.gaps.map((g) => ({ from: iso(g.from), to: iso(g.to), why: GAP_WORDS[g.reason] })),
        });
      }
      return result({
        phone: row.name,
        from: first,
        to: last,
        days_follow: p.settings.zone === "phone" ? `the phone's own time zone (${zone})` : zone,
        measuring: p.settings.measure ? "on" : "off: the phone sends no minutes now, so newer days aren't here. Only a parent turns it on.",
        days,
        reminder: "Screen time is a number, not a verdict about the kid. Report it plainly, don't guess why, and don't moralize.",
      });
    },
  );

  // ── change_screen_time ─────────────────────────────────────────────

  const limitInput = z.strictObject({
    id: ruleId.optional().describe("To change a limit get_rules lists; leave it out to add one"),
    name: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Never used as you write it: Belay names a limit after its apps. One unlike the limit's name proposes Belay's"),
    packages: z.array(packageName.or(z.literal("*"))).min(1).max(500).optional().describe('The apps that share it; ["*"] for a daily total of every app'),
    minutes: dayMinutes.optional().describe("Minutes a day, 0 to 1440"),
    by_day: z
      .strictObject(Object.fromEntries(WEEKDAYS.map((d) => [d, dayMinutes.optional()])) as Record<string, z.ZodOptional<typeof dayMinutes>>)
      .nullable()
      .optional()
      .describe("Minutes on some days instead, like {sat: 120}; null clears them"),
  });
  const scheduleInput = z.strictObject({
    id: ruleId.optional().describe("To change a schedule get_rules lists; leave it out to add one"),
    kind: z.enum(["school", "bedtime", "custom"]).optional(),
    name: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe("Never used as you write it: Belay names a schedule by its kind. One unlike the schedule's name proposes Belay's"),
    days: z.array(weekday).max(7).optional().describe('Like ["mon","tue","wed","thu","fri"]; a new one: every day'),
    start: hhmm.optional().describe(`Like 21:00, the phone's time; at least ${AI_MIN_SCHEDULE_MINUTES} minutes before end`),
    end: hhmm.optional().describe("Like 07:00; at or before start: the next day"),
    allow: z.array(packageName).max(500).optional().describe("Apps that stay open during it (the whole list)"),
    lock: z.boolean().optional().describe("Lock the screen when it starts: always a proposal for a parent, never applied at once"),
    skip: z.array(day).max(366).optional().describe("Days it doesn't start (the whole list)"),
  });

  server.registerTool(
    "change_screen_time",
    {
      title: "Change screen time",
      description:
        `Changes one phone's screen-time rules: add or change limits (by id from get_rules) and schedules, remove them, add or remove exempt apps, set self-serve, or what happens when Belay can't count. The server decides: a change that only tightens (a lower or new limit, more apps under a limit, a schedule that starts earlier, ends later or runs on more days, fewer apps left open or exempt, less self-serve, pausing apps when Belay can't count) applies at once, within seconds when the phone is online; use it only when the parent asks. Anything else, or a mix, becomes a proposal a parent approves or rejects on the parent page, and so does anything about a schedule that locks the screen (a new one, a lock turned on, a change to one that locks): lock_phone locks the phone now, a few times an hour. A schedule you add or change must run at least ${AI_MIN_SCHEDULE_MINUTES} minutes: a shorter one is refused, not proposed. Moving the phone to another stage (stage, alone; needs the Stage and agreement category) is always a proposal, and to Off belay, the last stage, not even that: only a parent moves a phone there. Measuring isn't something you can change. The kid sees each limit's and schedule's name, so Belay names one you add or rename, never in your words: a limit after its apps ("Chess Club and Puzzle Pop"; a daily total is "Screen time"), a schedule after its kind (School, Bedtime, Schedule). Only a parent gives one a name of their own, on the parent page.`,
      inputSchema: {
        device: deviceParam,
        change: z
          .strictObject({
            limits: z.array(limitInput).max(50).optional(),
            remove_limits: z.array(ruleId).max(50).optional().describe("Ids of limits to remove"),
            schedules: z.array(scheduleInput).max(20).optional(),
            remove_schedules: z.array(ruleId).max(20).optional().describe("Ids of schedules to remove"),
            exempt_add: z.array(packageName).max(500).optional().describe("Apps never counted or paused"),
            exempt_remove: z.array(packageName).max(500).optional(),
            self_serve: z
              .strictObject({ minutes: z.int().min(1).max(240), times: z.int().min(1).max(10) })
              .nullable()
              .optional()
              .describe("Extra minutes the kid may take without asking, times a day; null for none"),
            if_unmeasured: z.enum(["pause_limited", "keep_open"]).optional().describe("When Belay can't count: pause apps with a limit, or keep them open"),
            stage: z.string().min(1).max(60).optional().describe("Move the phone to this stage, by its name: always a proposal, on its own"),
          })
          .describe("What to change"),
        reason: z.string().min(1).max(1000).describe("Why, in a sentence or two, for the parent"),
      },
      annotations: { ...TIGHTEN, idempotentHint: false },
    },
    ({ device, change, reason }) => {
      const row = phone(device);
      if (isRefusal(row)) return row;
      if (row.revoked_at !== null) return refusal(`${row.name} is disconnected, so Belay can't change anything on it.`);
      const now = deps.now();
      const p = phoneRules(db, row.id);
      const label = phoneLabels(db, row.id);
      // What this AI app reads back names no app while the Apps category is off: the apps are counted.
      const said = scopeOn("apps") ? label : null;
      // The kid sees the names: Belay writes them for what the AI app adds or renames (names.ts).
      const appNames = appNamesOn(db, row.id);
      const renames = (given: string | undefined, current: string) => given !== undefined && oneLine(given, NAME_MAX).toLowerCase() !== current.toLowerCase();
      const tooMany = () =>
        listProposals(db, { deviceId: row.id, status: "pending", limit: MAX_PENDING_PROPOSALS }).length >= MAX_PENDING_PROPOSALS
          ? refusal(`${MAX_PENDING_PROPOSALS} proposals for ${row.name} are already waiting. Ask the parent to look at them on the Proposals page first.`)
          : null;

      // Another stage: a parent's decision, always.
      if (change.stage !== undefined) {
        if (Object.keys(change).length > 1) return refusal("Propose moving to another stage on its own, without other changes.");
        const off = scopeOff("agreement");
        if (off) return off;
        const stage = findStageByName(db, change.stage);
        if (!stage) {
          const names = listStages(db).map((s) => s.name);
          return refusal(names.length ? `No stage is called "${change.stage}". The stages are: ${names.join(", ")}.` : "The family has no stages yet.");
        }
        if (p.stage?.stage.id === stage.id) return refusal(`Nothing to propose: ${row.name} is already on that stage.`);
        // Phase 11: the last stage, and the hand-over after it, are a parent's alone.
        if (stage.offBelay) return refusal(`Only a parent moves ${row.name} to ${stage.name}, on the parent page: an AI app can't propose it.`);
        const busy = tooMany();
        if (busy) return busy;
        const classification = classifyScreenTimeChange(
          sideOf(p.settings, p.rules, p.stage && { number: p.stage.stage.number, name: p.stage.stage.name }),
          sideOf(p.settings, stage.rules, { number: stage.number, name: stage.name }),
        );
        const made = createProposal(db, now, row.id, { kind: "move_stage", stageId: stage.id, stageName: stage.name }, reason, { parentId: caller.parentId, clientName: caller.clientName });
        const words = changeWords(made.proposal.change, null);
        if (!made.duplicate && deps.limits.noticesPerPhone.hit(row.id).ok) notifyParents(deps, proposalNotice(row.name, caller.clientName, words.gerund));
        return result({
          phone: row.name,
          status: "proposed: waiting for a parent to approve or reject it",
          effect: classification.effect,
          untrusted: { proposed: words.title, what_changes: classification.changes.map((c) => changeSentence(c, { for: "parent", label: said })) },
          ...(made.duplicate ? { note: "The same change was already proposed, and is still waiting." } : {}),
          where: parentsPage("/proposals"),
          reminder: "Only a parent moves a phone to another stage. Nothing has changed yet: tell the parent it's waiting for them on the Proposals page.",
        });
      }

      // The rules as the change would leave them.
      const wanted: RuleSet = structuredClone(p.rules);
      for (const input of change.limits ?? []) {
        if (input.id !== undefined) {
          const index = wanted.limits.findIndex((l) => l.id === input.id);
          const limit = wanted.limits[index];
          if (!limit) return refusal(`No limit on ${row.name} has the id ${input.id}. get_rules lists them.`);
          const changed: Limit = {
            ...limit,
            ...(input.packages !== undefined ? { packages: input.packages.includes("*") ? ["*"] : [...new Set(input.packages)] } : {}),
            ...(input.minutes !== undefined ? { minutes: input.minutes } : {}),
            ...(input.by_day !== undefined ? { by_day: input.by_day } : {}),
          };
          wanted.limits[index] = renames(input.name, limit.name) ? { ...changed, name: limitName(changed.packages, appNames) } : changed;
        } else {
          if (!input.packages || input.minutes === undefined) return refusal("A new limit needs packages (or [\"*\"] for a daily total) and minutes.");
          const apps = input.packages.includes("*") ? ["*"] : [...new Set(input.packages)];
          wanted.limits.push({ id: newRuleId("l"), name: limitName(apps, appNames), packages: apps, minutes: input.minutes, by_day: input.by_day ?? null });
        }
      }
      for (const id of change.remove_limits ?? []) {
        if (!wanted.limits.some((l) => l.id === id)) return refusal(`No limit on ${row.name} has the id ${id}. get_rules lists them.`);
        wanted.limits = wanted.limits.filter((l) => l.id !== id);
      }
      for (const input of change.schedules ?? []) {
        if (input.id !== undefined) {
          const index = wanted.schedules.findIndex((s) => s.id === input.id);
          const schedule = wanted.schedules[index];
          if (!schedule) return refusal(`No schedule on ${row.name} has the id ${input.id}. get_rules lists them.`);
          const kind = input.kind ?? schedule.kind;
          wanted.schedules[index] = {
            ...schedule,
            kind,
            ...(renames(input.name, schedule.name) ? { name: SCHEDULE_NAMES[kind] } : {}),
            ...(input.days !== undefined ? { days: [...new Set(input.days)] } : {}),
            ...(input.start !== undefined ? { start: input.start } : {}),
            ...(input.end !== undefined ? { end: input.end } : {}),
            ...(input.allow !== undefined ? { allow: [...new Set(input.allow)] } : {}),
            ...(input.lock !== undefined ? { lock: input.lock } : {}),
            ...(input.skip !== undefined ? { skip: [...new Set(input.skip)] } : {}),
          };
        } else {
          if (!input.start || !input.end) return refusal("A new schedule needs start and end, like 21:00 and 07:00.");
          const kind = input.kind ?? "custom";
          wanted.schedules.push({
            id: newRuleId("s"),
            kind,
            name: SCHEDULE_NAMES[kind],
            days: input.days ? [...new Set(input.days)] : [...WEEKDAYS],
            start: input.start,
            end: input.end,
            allow: [...new Set(input.allow ?? [])],
            lock: input.lock ?? false,
            skip: [...new Set(input.skip ?? [])],
          });
        }
      }
      for (const id of change.remove_schedules ?? []) {
        if (!wanted.schedules.some((s) => s.id === id)) return refusal(`No schedule on ${row.name} has the id ${id}. get_rules lists them.`);
        wanted.schedules = wanted.schedules.filter((s) => s.id !== id);
      }
      const exempt = new Set(wanted.exempt);
      for (const pkg of change.exempt_add ?? []) exempt.add(pkg);
      for (const pkg of change.exempt_remove ?? []) exempt.delete(pkg);
      wanted.exempt = [...exempt].sort();
      if (change.self_serve !== undefined) wanted.self_serve = change.self_serve;
      if (change.if_unmeasured !== undefined) wanted.if_unmeasured = change.if_unmeasured;

      if (canonical(wanted) === canonical(p.rules)) return refusal(`Nothing to change: ${row.name}'s rules are already like that.`);
      // Not even as a proposal: twenty one-minute schedules would pause the phone twenty times an hour.
      const short = aiScheduleProblem(p.rules, wanted);
      if (short) {
        aiRefused(deps, caller, "change_screen_time", row.id, "short_schedule");
        return refusal(short);
      }
      const classification = classifyScreenTimeChange(sideOf(p.settings, p.rules), sideOf(p.settings, wanted));
      const names = new Map(p.rules.limits.map((l) => [l.id, l.name]));
      const changes = classification.changes.map((c) => ({ effect: c.effect, untrusted: { change: changeSentence(c, { for: "parent", label: said, limitName: (id) => names.get(id) ?? null }) } }));
      // A schedule that locks the screen is a parent's, even one that only tightens: lock_phone is an AI app's way to lock, a few times an hour.
      const locks = locksTouched(p.rules, wanted).length > 0;

      if (classification.onlyTightens && !locks) {
        try {
          const done = setPhoneRules(ctx(), row.id, wanted, ai);
          return result({
            phone: row.name,
            status: "done: it only tightens, so it applies at once",
            changes,
            version: done.version,
            what_happens: "The phone gets it within seconds if it's online, or as soon as it's back online.",
            reminder: "Only a parent can loosen it again, on the parent page. To suggest that, use change_screen_time: it becomes a proposal.",
          });
        } catch (error) {
          if (error instanceof RuleRefused) return refusal(error.message);
          throw error;
        }
      }
      const busy = tooMany();
      if (busy) return busy;
      const made = createProposal(db, now, row.id, { kind: "screen_time", patch: patchOf(p.rules, wanted) }, reason, { parentId: caller.parentId, clientName: caller.clientName });
      const words = changeWords(made.proposal.change, null, label);
      if (!made.duplicate && deps.limits.noticesPerPhone.hit(row.id).ok) notifyParents(deps, proposalNotice(row.name, caller.clientName, words.gerund));
      return result({
        phone: row.name,
        status: "proposed: waiting for a parent to approve or reject it",
        why:
          classification.effect === "loosens"
            ? "Part of it loosens the rules, so a parent decides."
            : locks
              ? `A schedule that locks the screen is a parent's to approve, even one that only tightens: an AI app locks the phone only with lock_phone, at most ${AI_PER_HOUR.locks} times an hour.`
              : "It doesn't only tighten the rules, so a parent decides.",
        changes: screenTimeWords({ kind: "screen_time", patch: patchOf(p.rules, wanted) }, said).map((c) => ({ effect: c.effect, untrusted: { change: c.words } })),
        ...(made.duplicate ? { note: "The same change was already proposed, and is still waiting." } : {}),
        where: parentsPage("/proposals"),
        reminder: "Nothing has changed yet. Tell the parent it's waiting for them on the Proposals page; don't say it's done.",
      });
    },
  );

  // ── lock_phone ─────────────────────────────────────────────────────

  server.registerTool(
    "lock_phone",
    {
      title: "Lock the phone now",
      description: `Pauses a phone at once for ${LOCK_MINUTES.min} to ${LOCK_MINUTES.max} minutes, as pause_phone does, and locks its screen if the phone gets this within ${LOCK_NOW_MS / 60_000} minutes; calls, texts, 911 and 988 still work. Use it only when the parent asks. A pause already running for longer stays as it is. The kid's phone says so in Belay's own words, never yours. Only a parent can resume early, on the parent page (you can propose that with propose_change). At most ${AI_PER_HOUR.locks} locks and pauses (pause_phone) an hour per phone through this connection, each lock counted: past that it says when to try again.`,
      inputSchema: {
        device: deviceParam,
        minutes: z.int().min(LOCK_MINUTES.min).max(LOCK_MINUTES.max).describe("How long the phone stays paused"),
      },
      annotations: { ...TIGHTEN, idempotentHint: false },
    },
    ({ device, minutes }) => {
      const row = phone(device);
      if (isRefusal(row)) return row;
      if (row.revoked_at !== null) return refusal(`${row.name} is disconnected, so Belay can't change anything on it.`);
      const limited = aiLimited(deps, caller, "lock_phone", row);
      if (limited) return limited;
      const done = lockPhone(ctx(), row.id, { minutes }, ai);
      aiCounted(deps, caller, "lock_phone", row.id);
      return result({
        phone: row.name,
        paused_until: done.result.until === null ? "a parent resumes it" : iso(done.result.until),
        ...(done.result.kept ? { note: "It was already paused at least that long, and that stays as it was." } : {}),
        locks: `The phone locks its screen when it gets this, within seconds if it's online, if that's within ${LOCK_NOW_MS / 60_000} minutes.`,
        version: done.version,
        still_works: "The phone app and texting, so 911 and 988 always work.",
        reminder: "Only a parent can resume it early, on the parent page. To suggest that, use propose_change with kind resume.",
      });
    },
  );
}
