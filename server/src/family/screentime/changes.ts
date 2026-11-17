/**
 * Changes to screen time, each through family/policy.ts's changePolicy (or changePolicies, for a
 * stage every phone on it gets): one transaction, the activity log, and a new policy version when
 * what the phone would see changed. Who may change what is checked here as well as in the callers:
 *
 * - An AI app may change a phone's limits, schedules, exempt apps, self-serve and "can't count"
 *   rule only when the change only tightens (classifyScreenTimeChange); anything else is a
 *   proposal for a parent (family/proposals.ts).
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
  type PhoneSettings,
  type RuleSet,
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
import { type Labels, changeSentence } from "./words.js";

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

/**
 * Sets the phone's rules to `rules` (what a stage bundles: limits, schedules, exempt apps,
 * self-serve, "can't count", warnings), keeping its stage: what differs from the stage's is the
 * phone's own. An AI app may only make a change that only tightens. Every name is tidied, and the
 * names Belay wrote follow what they name (names.ts): the kid sees them.
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
    if (who.kind === "ai" && !classification.onlyTightens) throw new Error("An AI app can only tighten screen time: anything else is a proposal for a parent");
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
  /** Where it goes: 1 is the first stage. Left out: after the last. */
  number?: number;
  how: string | null;
  rules: RuleSet;
}

/**
 * Makes a stage, or changes one (`id`). Every phone on it gets the change at once, with its own
 * changes kept on top. A number another stage has: a stage moving there swaps places with it; a
 * new stage goes in before it, and the ones after move up. A parent's action.
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
  if (others.some((s) => s.name.toLowerCase() === name.toLowerCase())) throw new RuleRefused(`Another stage is already called ${name}.`);
  if (!existing && others.length >= STAGE_LIMITS.maxStages) throw new RuleRefused(`A family can have at most ${STAGE_LIMITS.maxStages} stages.`);
  checkRuleSet(input.rules, neverAnywhere);
  const number = input.number ?? existing?.number ?? (others.at(-1)?.number ?? 0) + 1;
  if (!Number.isInteger(number) || number < 1 || number > 99) throw new RuleRefused("A stage's number is 1 to 99.");
  for (const phone of id === null ? [] : phonesOnStage(db, id)) checkRuleSet(merge(input.rules, phoneRow(db, phone.id).own), neverBlockedOn(db, phone.id));
  // Every phone on any stage: a change of number changes which stage comes next.
  const phones = db.prepare<[], { device_id: string }>("SELECT device_id FROM phone_stages").all().map((r) => r.device_id);
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
    log("agreement.saved", { version, sections: clean.length });
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
