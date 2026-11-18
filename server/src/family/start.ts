/**
 * The Phones page's Getting started card (web/pages/start.tsx): the steps of setting Belay up, for
 * a new family, each checked off from the server's own state, never a stored tick. Some are the
 * family's (the phone, its rules, what AI apps may read, the backup passphrase), some each
 * parent's own (notifications in their browsers, their AI connections). The one thing kept is a
 * parent's choice to hide the card (parents.start_hidden_at, migration 016), which only their own
 * Phones page follows. It shows until that parent hides it, or until every essential step is done:
 * the phone, its first rules, notifications and encrypted backups, without which Belay doesn't
 * protect the kid or the family's data. Looking over the rules has no tick, since Belay can't tell
 * when a parent has; deciding what AI apps read and connecting Claude are worth doing, and optional.
 */
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import { pendingCodes } from "../device/enroll.js";
import { listGrants } from "../oauth/store.js";
import { backupPassphrase } from "../ops/backups.js";
import { opsOptions } from "../ops/options.js";
import { listSubscriptions } from "../push.js";
import { type AiScope, aiChoicesSaved, getSettings } from "../settings.js";
import { listDevices } from "./devices.js";
import { getRules } from "./policy.js";

/**
 * done: the server's own state says so. waiting: under way, and the phone's turn (an enrollment
 * code not used yet, rules it hasn't applied yet). todo: not yet. open: no tick, since Belay can't
 * tell (looking over the rules).
 */
export type StepState = "done" | "waiting" | "todo" | "open";

export interface StartPhone {
  id: string;
  name: string;
}

/** Where a phone's rules stand: none set yet, set and not applied yet, or applied (the phone's report). */
export type PhoneRulesState = "none" | "waiting" | "applied";

export type StartStep =
  | { id: "phone"; state: StepState; essential: true; phones: StartPhone[]; codes: { deviceName: string; expiresAt: number }[] }
  | { id: "rules"; state: StepState; essential: true; phones: (StartPhone & { rules: PhoneRulesState; protectedOn: boolean })[] }
  | { id: "look"; state: "open"; essential: false; phone: StartPhone | null }
  | { id: "notifications"; state: StepState; essential: true; browsers: string[] }
  | { id: "ai_reads"; state: StepState; essential: false; saved: boolean; on: AiScope[]; added: AiScope[] }
  | { id: "claude"; state: StepState; essential: false; connections: string[] }
  | { id: "backups"; state: StepState; essential: true; passphrase: "set" | "none" | "unusable"; problem: string | null };

export interface GettingStarted {
  steps: StartStep[];
  /** The essential steps: how many there are, and how many are done. */
  essential: { done: number; of: number };
  /** When this parent hid the card, or null. */
  hiddenAt: number | null;
  /** Whether their Phones page shows it: they haven't hidden it, and an essential step is left. */
  shown: boolean;
  /** The phone the optional parts' links go to: the first connected one, as the Phones page lists them, or null. */
  phone: StartPhone | null;
}

/** When this parent hid Getting started, or null. */
export function startHiddenAt(db: DB, parentId: string): number | null {
  return db.prepare<[string], { start_hidden_at: number | null }>("SELECT start_hidden_at FROM parents WHERE id = ?").get(parentId)?.start_hidden_at ?? null;
}

/** Hides Getting started on this parent's Phones page. False when it was hidden already. */
export function hideStart(db: DB, parentId: string, now: number): boolean {
  return db.prepare("UPDATE parents SET start_hidden_at = ? WHERE id = ? AND start_hidden_at IS NULL").run(now, parentId).changes === 1;
}

/** Shows Getting started on this parent's Phones page again (until its essential steps are done). False when it wasn't hidden. */
export function showStart(db: DB, parentId: string): boolean {
  return db.prepare("UPDATE parents SET start_hidden_at = NULL WHERE id = ? AND start_hidden_at IS NOT NULL").run(parentId).changes === 1;
}

/** The server's backup passphrase, as the daily backup reads it (ops/jobs.ts): set, not set, or set so it can't be used, with why. */
function passphraseState(deps: Deps): { passphrase: "set" | "none" | "unusable"; problem: string | null } {
  try {
    return { passphrase: backupPassphrase(opsOptions(deps).env ?? process.env) === null ? "none" : "set", problem: null };
  } catch (error) {
    return { passphrase: "unusable", problem: error instanceof Error ? error.message : "It can't be read." };
  }
}

/** Getting started for this parent, from what the server knows now. */
export function gettingStarted(deps: Deps, parentId: string): GettingStarted {
  const { db } = deps;
  const now = deps.now();
  const settings = getSettings(db);
  const phones = listDevices(db, settings, now).filter((d) => d.revokedAt === null);
  const codes = pendingCodes(db, now).map((c) => ({ deviceName: c.deviceName, expiresAt: c.expiresAt }));
  const first = phones[0] ? { id: phones[0].id, name: phones[0].name } : null;

  const rules = phones.map((d) => {
    const applied = d.enforcement?.policy_version ?? 0;
    const state: PhoneRulesState = applied >= 1 ? "applied" : d.policyVersion === 0 ? "none" : "waiting";
    return { id: d.id, name: d.name, rules: state, protectedOn: getRules(db, d.id).protectedAt !== null };
  });
  const rulesState: StepState =
    rules.length === 0 || rules.some((p) => p.rules === "none") ? "todo" : rules.some((p) => p.rules === "waiting") ? "waiting" : "done";

  const browsers = listSubscriptions(db, parentId).map((s) => s.name);
  const saved = aiChoicesSaved(db);
  const on = (Object.keys(settings.aiScopes) as AiScope[]).filter((k) => settings.aiScopes[k]);
  const connections = listGrants(db)
    .filter((g) => g.parentId === parentId)
    .map((g) => g.clientName);
  const backups = passphraseState(deps);

  const steps: StartStep[] = [
    {
      id: "phone",
      state: phones.length > 0 ? "done" : codes.length > 0 ? "waiting" : "todo",
      essential: true,
      phones: phones.map((d) => ({ id: d.id, name: d.name })),
      codes,
    },
    { id: "rules", state: rulesState, essential: true, phones: rules },
    { id: "look", state: "open", essential: false, phone: first },
    { id: "notifications", state: browsers.length > 0 ? "done" : "todo", essential: true, browsers },
    { id: "ai_reads", state: saved && settings.newAiScopes.length === 0 ? "done" : "todo", essential: false, saved, on, added: settings.newAiScopes },
    { id: "claude", state: connections.length > 0 ? "done" : "todo", essential: false, connections },
    { id: "backups", state: backups.passphrase === "set" ? "done" : "todo", essential: true, ...backups },
  ];
  const essential = steps.filter((s) => s.essential);
  const done = essential.filter((s) => s.state === "done").length;
  const hiddenAt = startHiddenAt(db, parentId);
  return { steps, essential: { done, of: essential.length }, hiddenAt, shown: hiddenAt === null && done < essential.length, phone: first };
}
