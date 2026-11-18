/**
 * Changes to screen time, each through family/policy.ts's changePolicy (or changePolicies, for a
 * stage every phone on it gets): one transaction, the activity log, and a new policy version when
 * what the phone would see changed. Who may change what is checked here as well as in the callers:
 *
 * - An AI app may change a phone's limits, schedules, exempt apps, self-serve and "can't count"
 *   rule only when the change only tightens (classifyScreenTimeChange); anything else is a
 *   proposal for a parent (family/proposals.ts). A schedule that locks the screen is a parent's
 *   too (locksTouched), and each schedule an AI app adds or changes runs at least 15 minutes
 *   (aiScheduleProblem): otherwise schedules would lock or pause the phone past the few times an
 *   hour mcp/limits.ts lets an AI app. Parents aren't limited.
 * - Measuring, the zone and when days start, stages (a phone's and their rules), extra time and
 *   the family agreement are a person's: a parent on the parent page, or the server's CLI.
 *   Measuring is a choice about collecting, so an AI app can't even propose it.
 */
import { newId } from "../../crypto.js";
import type { DB } from "../../db.js";
import { ScreenTime } from "../../device/schemas.js";
import { cleanText, oneLine } from "../../text.js";
import { isValidTimeZone } from "../../time.js";
import { type Changed, type Changer, NEVER_BLOCKED, type Person, type PolicyContext, RuleRefused, changePolicies, changePolicy, neverBlockedOn } from "../policy.js";
import { type Section, cleanSections, insertAgreement, recordKidAnswer } from "./agreement.js";
import { type Classification, classifyScreenTimeChange } from "./classify.js";
import { clockMinutes } from "./days.js";
import { appNamesOn, followNames, noAppNames, tidyNames } from "./names.js";
import {
  NO_OWN,
  NO_RULES,
  type PhoneSettings,
  type RuleSet,
  type Schedule,
  canonical,
  familyLabels,
  getStage,
  insertExtra,
  listStages,
  merge,
  ownFor,
  phoneDay,
  phoneLabels,
  phoneRow,
  phoneRules,
  phonesOnStage,
  savePhoneRow,
  sideOf,
  type StageView,
} from "./rules.js";
import { type Labels, changeSentence, clock } from "./words.js";

/** The types already say so; this keeps it true at run time too. */
function onlyPeople(who: Changer): void {
  if (who.kind === "ai") throw new Error("Only a person changes this: an AI app can only propose it");
}

export const STAGE_LIMITS = { name: 60, how: 1000, maxStages: 20 } as const;

/** The changes in the parents' words, for the activity log and the Proposals page. */
export function changeWords(classification: Classification, label: Labels, limitName?: (id: string) => string | null): string[] {
  return classification.changes.map((c) => changeSentence(c, { for: "parent", label, limitName }));
}

const PLAIN_FIELDS: Record<string, string> = {
  limits: "limits",
  schedules: "schedules",
  exempt: "exempt apps",
  self_serve: "self-serve",
  warn_before: "the warning",
};

/**
 * Refuses rules the phone couldn't take or that would pause what must stay open: at most 50
 * limits and 20 schedules, each id once, and no limit on an app the phone never pauses (the
 * dialer, texting, Belay…), so 911 and 988 always work. `never` says why for a package, or null.
 */
export function checkRuleSet(rules: RuleSet, never: (pkg: string) => string | null): void {
  if (rules.limits.length > 50) throw new RuleRefused("That's more than 50 time limits, the most a phone takes. Remove some first.");
  if (rules.schedules.length > 20) throw new RuleRefused("That's more than 20 schedules, the most a phone takes. Remove some first.");
  const ids = [...rules.limits, ...rules.schedules].map((r) => r.id);
  if (new Set(ids).size !== ids.length) throw new RuleRefused("Two limits or schedules have the same id.");
  for (const limit of rules.limits) {
    for (const pkg of limit.packages) {
      const why = pkg === "*" ? null : never(pkg);
      if (why) throw new RuleRefused(`${pkg} can't have a time limit. ${why}`);
    }
  }
  const parsed = ScreenTime.safeParse({ measure: false, zone: "phone", day_starts: "00:00", ...rules, extra: [] });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const field = PLAIN_FIELDS[String(issue?.path[0] ?? "")] ?? "the rules";
    throw new RuleRefused(`Not saved: something in ${field} isn't valid (${issue?.message ?? "invalid"}).`);
  }
}

/** Why the phone never pauses an app, for a stage (no phone in particular): the well-known ones. */
const neverAnywhere = (pkg: string): string | null => (NEVER_BLOCKED.has(pkg) ? "The phone never pauses it, so 911 and 988 always work." : null);

/** The shortest schedule an AI app may add, or leave when it changes one, in minutes. A parent's may be shorter. */
export const AI_MIN_SCHEDULE_MINUTES = 15;

/** How long a schedule runs each time, in minutes: to its end, the next day when that's at or before its start; null when a time doesn't read. */
export function scheduleMinutes(s: Pick<Schedule, "start" | "end">): number | null {
  const start = clockMinutes(s.start);
  const end = clockMinutes(s.end);
  if (start === null || end === null) return null;
  return end > start ? end - start : end + 24 * 60 - start;
}

/** The schedules `after` adds, or changes from `before` (by id), as they'd be; a new name alone doesn't count (Belay writes it). */
function touchedSchedules(before: RuleSet, after: RuleSet): Schedule[] {
  const key = (s: Schedule) => canonical({ ...s, name: null });
  const was = new Map(before.schedules.map((s) => [s.id, key(s)]));
  return after.schedules.filter((s) => was.get(s.id) !== key(s));
}

/**
 * The schedules a change would leave locking the screen that it adds or changes: a new one that
 * locks, one whose lock goes on, or a change to one that locks (the phone locks once each time a
 * schedule starts, and one that starts at another time or on another day is a start it locks for
 * again: core/screentime/Schedules.kt's Occurrence.key). An AI app locks the phone only with
 * lock_phone, a few times an hour (mcp/limits.ts), so for an AI app these make the change a
 * proposal: a parent decides. Parents aren't limited.
 */
export function locksTouched(before: RuleSet, after: RuleSet): Schedule[] {
  return touchedSchedules(before, after).filter((s) => s.lock);
}

/**
 * Why an AI app can't make this change at all, in words, or null: a schedule it adds or changes
 * would run less than 15 minutes. Twenty one-minute schedules would otherwise pause the phone twenty
 * times an hour. Parents aren't limited.
 */
export function aiScheduleProblem(before: RuleSet, after: RuleSet): string | null {
  for (const s of touchedSchedules(before, after)) {
    const minutes = scheduleMinutes(s);
    if (minutes !== null && minutes < AI_MIN_SCHEDULE_MINUTES) {
      return `Not changed: a schedule an AI app adds or changes runs at least ${AI_MIN_SCHEDULE_MINUTES} minutes, and ${clock(s.start)} to ${clock(s.end)} is ${minutes} minute${minutes === 1 ? "" : "s"}. A parent can make a shorter one on the parent page.`;
    }
  }
  return null;
}

/**
 * Sets the phone's rules to `rules` (what a stage bundles: limits, schedules, exempt apps,
 * self-serve, "can't count", warnings), keeping its stage: what differs from the stage's is the
 * phone's own. An AI app may only make a change that only tightens, touches no schedule that locks
 * the screen, and leaves each schedule it adds or changes at least 15 minutes long. Every name is
 * tidied, and the names Belay wrote follow what they name (names.ts): the kid sees them.
 */
export function setPhoneRules(
  ctx: PolicyContext,
  deviceId: string,
  rules: RuleSet,
  who: Changer,
  opts: { proposalId?: string } = {},
): Changed<{ classification: Classification }> {
  const { db } = ctx;
  const appNames = appNamesOn(db, deviceId);
  const wanted = tidyNames(rules, appNames);
  checkRuleSet(wanted, neverBlockedOn(db, deviceId));
  return changePolicy(ctx, deviceId, who, (log) => {
    const current = phoneRules(db, deviceId);
    const classification = classifyScreenTimeChange(sideOf(current.settings, current.rules), sideOf(current.settings, wanted));
    if (who.kind === "ai") {
      if (!classification.onlyTightens) throw new Error("An AI app can only tighten screen time: anything else is a proposal for a parent");
      const short = aiScheduleProblem(current.rules, wanted);
      if (short) throw new RuleRefused(short);
      if (locksTouched(current.rules, wanted).length) throw new Error("An AI app can't make a schedule lock the screen: that's a proposal for a parent");
    }
    if (classification.none) return { classification };
    // A name Belay wrote follows the change, as no change of its own: the words say what changed.
    savePhoneRow(db, deviceId, current.settings, ownFor(current.stage?.stage.rules ?? null, followNames(current.rules, wanted, appNames)), ctx.now);
    const names = new Map(current.rules.limits.map((l) => [l.id, l.name]));
    log("screen_time.changed", {
      effect: classification.effect,
      changes: changeWords(classification, phoneLabels(db, deviceId), (id) => names.get(id) ?? null),
      ...(opts.proposalId ? { proposal: opts.proposalId } : {}),
    });
    return { classification };
  });
}

/** Measuring, the zone the phone's days follow, and when its days start: the family's settings for the phone. */
export function setPhoneSettings(ctx: PolicyContext, deviceId: string, change: Partial<PhoneSettings>, who: Person): Changed<{ settings: PhoneSettings }> {
  onlyPeople(who);
  if (change.zone !== undefined && change.zone !== "phone" && !isValidTimeZone(change.zone)) throw new RuleRefused("Pick a time zone from the list, or the phone's own.");
  if (change.day_starts !== undefined && clockMinutes(change.day_starts) === null) throw new RuleRefused("When a day starts is a time like 00:00 or 04:30.");
  const { db } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const row = phoneRow(db, deviceId);
    const settings = { ...row.settings, ...change };
    savePhoneRow(db, deviceId, settings, row.own, ctx.now);
    if (settings.measure !== row.settings.measure) log("screen_time.measure", { on: settings.measure });
    if (settings.zone !== row.settings.zone || settings.day_starts !== row.settings.day_starts) {
      log("screen_time.settings", { zone: settings.zone, day_starts: settings.day_starts });
    }
    return { settings };
  });
}

/**
 * Puts the phone on a stage (null: on none). On a stage, the phone gets exactly the stage's rules:
 * its own changes are cleared. Off its stage, it keeps the rules it had, as its own, so nothing
 * changes until a parent changes them. Either way a parent's action (an AI app may propose it).
 */
export function moveToStage(ctx: PolicyContext, deviceId: string, stageId: string | null, who: Person, opts: { proposalId?: string } = {}): Changed<{ from: StageView | null; to: StageView | null }> {
  onlyPeople(who);
  const { db, now } = ctx;
  const to = stageId === null ? null : getStage(db, stageId);
  if (stageId !== null && !to) throw new RuleRefused("There's no such stage.");
  return changePolicy(ctx, deviceId, who, (log) => {
    const current = phoneRules(db, deviceId);
    const from = current.stage?.stage ?? null;
    if (from?.id === to?.id) return { from, to };
    if (to) {
      checkRuleSet(to.rules, neverBlockedOn(db, deviceId));
      savePhoneRow(db, deviceId, current.settings, structuredClone(NO_OWN), now);
      db.prepare(
        "INSERT INTO phone_stages (device_id, stage_id, since, set_by) VALUES (?, ?, ?, ?) ON CONFLICT (device_id) DO UPDATE SET stage_id = excluded.stage_id, since = excluded.since, set_by = excluded.set_by",
      ).run(deviceId, to.id, now, who.kind === "parent" ? who.parentId : null);
    } else {
      savePhoneRow(db, deviceId, current.settings, ownFor(null, current.rules), now);
      db.prepare("DELETE FROM phone_stages WHERE device_id = ?").run(deviceId);
    }
    const classification = classifyScreenTimeChange(
      sideOf(current.settings, current.rules, from && { number: from.number, name: from.name }),
      sideOf(current.settings, to ? to.rules : current.rules, to && { number: to.number, name: to.name }),
    );
    log("stage.moved", {
      from: from?.name ?? undefined,
      to: to?.name ?? undefined,
      effect: classification.effect,
      ...(opts.proposalId ? { proposal: opts.proposalId } : {}),
    });
    return { from, to };
  });
}

/** Clears the phone's own changes to its stage's rules: it gets exactly the stage's again. */
export function resetToStage(ctx: PolicyContext, deviceId: string, who: Person): Changed<{ classification: Classification }> {
  onlyPeople(who);
  const { db } = ctx;
  const stage = phoneRules(db, deviceId).stage;
  if (!stage) throw new RuleRefused("This phone isn't on a stage.");
  return setPhoneRules(ctx, deviceId, stage.stage.rules, who);
}

export interface StageInput {
  name: string;
  /** Where it goes: 1 is the first stage. Left out: after the last, before Off belay. */
  number?: number;
  how: string | null;
  rules: RuleSet;
}

/**
 * Phase 11: Off belay (family/offbelay) keeps its name, stays the last stage and blocks nothing; a
 * family changes only its words for when it comes. Refuses anything else, for Off belay or for
 * another stage that would go after it.
 */
function checkOffBelay(existing: StageView | null, offBelay: StageView | null, name: string, number: number, rules: RuleSet): void {
  if (existing?.offBelay) {
    if (name.toLowerCase() !== existing.name.toLowerCase()) throw new RuleRefused(`${existing.name} keeps its name: it's Belay's last stage, and the kid's phone calls it that.`);
    if (number !== existing.number) throw new RuleRefused(`${existing.name} is always the last stage.`);
    if (canonical(rules) !== canonical(NO_RULES)) throw new RuleRefused(`${existing.name} blocks nothing: it has no time limits, schedules or other screen-time rules.`);
  } else if (offBelay && number > offBelay.number - (existing ? 1 : 0)) {
    throw new RuleRefused(`${offBelay.name} is always the last stage: give this one a number before ${offBelay.number}.`);
  }
}

/**
 * Makes a stage, or changes one (`id`). Every phone on it gets the change at once, with its own
 * changes kept on top. A number another stage has: a stage moving there swaps places with it; a
 * new stage goes in before it, and the ones after move up. A new stage without a number goes in
 * before Off belay, the last stage (Phase 11). A parent's action.
 */
export function saveStage(ctx: PolicyContext, id: string | null, input: StageInput, who: Person): { stage: StageView; phonesChanged: number } {
  onlyPeople(who);
  const { db, now } = ctx;
  // The kid sees them, so they're tidied like every name (names.ts): one line, nothing hidden or reordered.
  const name = oneLine(input.name.replace(/\s+/g, " "), STAGE_LIMITS.name);
  if (!name) throw new RuleRefused("Name the stage.");
  input = { ...input, rules: tidyNames(input.rules, noAppNames) };
  const existing = id === null ? null : getStage(db, id);
  if (id !== null && !existing) throw new RuleRefused("There's no such stage.");
  const others = listStages(db).filter((s) => s.id !== id);
  const offBelay = others.find((s) => s.offBelay) ?? null;
  if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new RuleRefused(`Another stage is already called ${name}.`);
  if (!existing && others.filter((s) => !s.offBelay).length >= STAGE_LIMITS.maxStages) throw new RuleRefused(`A family can have at most ${STAGE_LIMITS.maxStages} stages, besides Off belay.`);
  checkRuleSet(input.rules, neverAnywhere);
  const number = input.number ?? existing?.number ?? offBelay?.number ?? (others.at(-1)?.number ?? 0) + 1;
  if (!Number.isInteger(number) || number < 1 || number > 99) throw new RuleRefused("A stage's number is 1 to 99.");
  checkOffBelay(existing, offBelay, name, number, input.rules);
  for (const phone of id === null ? [] : phonesOnStage(db, id)) checkRuleSet(merge(input.rules, phoneRow(db, phone.id).own), neverBlockedOn(db, phone.id));
  // Every phone on any stage: a change of number changes which stage comes next. Off belay's
  // words are in every phone's rules (Phase 11), on a stage or not.
  const phones = existing?.offBelay
    ? db.prepare<[], { id: string }>("SELECT id FROM devices").all().map((r) => r.id)
    : db.prepare<[], { device_id: string }>("SELECT device_id FROM phone_stages").all().map((r) => r.device_id);
  const how = input.how ? cleanText(input.how, STAGE_LIMITS.how) || null : null;
  const stageId = id ?? newId();
  const done = changePolicies(ctx, phones, who, (log) => {
    const taken = others.find((s) => s.number === number);
    if (taken && existing) {
      // Swap, through a number no stage has (numbers are unique at every step).
      db.prepare("UPDATE stages SET number = 100000 WHERE id = ?").run(existing.id);
      db.prepare("UPDATE stages SET number = ? WHERE id = ?").run(existing.number, taken.id);
    } else if (taken) {
      // In before it: it and the later ones move up by one, through numbers no stage has.
      db.prepare("UPDATE stages SET number = number + 100000 WHERE number >= ?").run(number);
      db.prepare("UPDATE stages SET number = number - 99999 WHERE number >= 100000").run();
    }
    if (existing) {
      db.prepare("UPDATE stages SET number = ?, name = ?, how = ?, rules = ?, updated_at = ?, updated_by = ? WHERE id = ?").run(
        number,
        name,
        how,
        JSON.stringify(input.rules),
        now,
        who.kind === "parent" ? who.parentId : null,
        stageId,
      );
    } else {
      db.prepare("INSERT INTO stages (id, number, name, how, rules, created_at, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(
        stageId,
        number,
        name,
        how,
        JSON.stringify(input.rules),
        now,
        now,
        who.kind === "parent" ? who.parentId : null,
      );
    }
    const classification = classifyScreenTimeChange(existing ? existing.rules : null, input.rules);
    log(existing ? "stage.changed" : "stage.created", {
      stage: name,
      number,
      ...(existing ? { effect: classification.effect, changes: changeWords(classification, familyLabels(db)) } : {}),
    });
    return getStage(db, stageId);
  });
  if (!done.result) throw new Error("stage vanished");
  return { stage: done.result, phonesChanged: done.changed.length };
}

/** Deletes a stage no phone is on. */
export function deleteStage(ctx: PolicyContext, id: string, who: Person): void {
  onlyPeople(who);
  const { db } = ctx;
  const stage = getStage(db, id);
  if (!stage) throw new RuleRefused("There's no such stage.");
  if (stage.offBelay) throw new RuleRefused(`Every family has ${stage.name}, the last stage: it can't be deleted.`);
  const on = phonesOnStage(db, id);
  if (on.length) throw new RuleRefused(`${on.map((p) => p.name).join(" and ")} ${on.length === 1 ? "is" : "are"} on this stage. Move ${on.length === 1 ? "it" : "them"} to another stage first.`);
  const phones = db.prepare<[], { device_id: string }>("SELECT device_id FROM phone_stages").all().map((r) => r.device_id);
  changePolicies(ctx, phones, who, (log) => {
    db.prepare("DELETE FROM stages WHERE id = ?").run(id);
    log("stage.deleted", { stage: stage.name });
  });
}

/** Extra time for one of the phone's limits ("*": every limit), for the phone's day now. A person's action: it loosens. */
export function giveExtraTime(ctx: PolicyContext, deviceId: string, input: { limitId: string; minutes: number; package?: string | null }, who: Person): Changed<{ id: string; day: string }> {
  onlyPeople(who);
  const { db, now } = ctx;
  if (!Number.isInteger(input.minutes) || input.minutes < 1 || input.minutes > 240) throw new RuleRefused("Give 1 to 240 minutes.");
  const limit = input.limitId === "*" ? null : phoneRules(db, deviceId).rules.limits.find((l) => l.id === input.limitId);
  if (input.limitId !== "*" && !limit) throw new RuleRefused("That limit isn't in the phone's rules.");
  return changePolicy(ctx, deviceId, who, (log) => {
    const day = phoneDay(db, deviceId, now);
    const id = insertExtra(db, deviceId, { limitId: input.limitId, minutes: input.minutes, package: input.package ?? null, requestId: null, day }, now, who.kind === "parent" ? who.parentId : null);
    log("extra.given", { limit: limit?.name ?? "every limit", minutes: input.minutes, day });
    return { id, day };
  });
}

/** A new version of the phone's family agreement: the parents agree to it as they save it, and the kid is asked again. */
export function saveAgreement(ctx: PolicyContext, deviceId: string, sections: Section[], who: Person): Changed<{ version: number }> {
  onlyPeople(who);
  const clean = cleanSections(sections);
  if (!clean.length) throw new RuleRefused("Write at least one section.");
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const version = insertAgreement(db, deviceId, clean, now, who.kind === "parent" ? who.parentId : null);
    // `agreement_version`, as the kid's answers say it: the activity log adds the rules' own `version`.
    log("agreement.saved", { agreement_version: version, sections: clean.length });
    return { version };
  });
}

/**
 * The kid's answers to the agreement, from their requests: the policy's kid_agreed_at follows, in
 * a new version. Never refused. The request itself is in the activity log already.
 */
export function recordAgreementAnswers(ctx: PolicyContext, deviceId: string, answers: { version: number; answer: "agree" | "talk"; at: number }[]): void {
  if (!answers.length) return;
  const { db } = ctx;
  changePolicy(ctx, deviceId, { kind: "phone", deviceId }, () => {
    for (const a of answers) recordKidAnswer(db, deviceId, a.version, a.answer, a.at);
  });
}

/** Whether a phone is on the stage, for pages. */
export function stageOfPhone(db: DB, deviceId: string): StageView | null {
  return phoneRules(db, deviceId).stage?.stage ?? null;
}
