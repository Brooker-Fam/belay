/**
 * What AI apps propose that would loosen a rule (docs/protocol.md: "anything that loosens is
 * only a proposal until a parent approves it on the parent page"). Approving applies the
 * change in the approving parent's name; rejecting changes nothing.
 *
 * There is no kind of proposal for hardening (factory reset, debugging, reset protection) or
 * maintenance mode, and lift_restriction never covers factory_reset or debugging: AI apps
 * can't touch them, even as a proposal.
 */
import { audit } from "../audit.js";
import { newId } from "../crypto.js";
import type { DB } from "../db.js";
import { oneLine } from "../text.js";
import {
  LOCK_RESTRICTIONS,
  RESTRICTION_NAMES,
  RuleRefused,
  SAFE_RESTRICTIONS,
  activePause,
  currentDecision,
  decideApp,
  getRules,
  neverBlockedReason,
  resumePhone,
  setNewApps,
  setRestrictions,
  setWeb,
  type PolicyContext,
} from "./policy.js";
import { moveToStage, setPhoneRules } from "./screentime/changes.js";
import { classifyScreenTimeChange, type RuleChange } from "./screentime/classify.js";
import { type RulesPatch, applyPatch, emptyPatch, patchSides } from "./screentime/patch.js";
import { canonical, getStage, phoneLabels, phoneRules } from "./screentime/rules.js";
import { type Labels, changeSentence, packageNames } from "./screentime/words.js";

/** Proposals waiting for a parent, per phone, before an AI app must wait for the parent to look. */
export const MAX_PENDING_PROPOSALS = 20;

/** What propose_change takes. Screen time's proposals come from change_screen_time instead. */
export const PROPOSAL_KINDS = ["allow_app", "resume", "lift_restriction", "web_filter_off", "new_apps_allow"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number] | "screen_time" | "move_stage";

/** The locks an AI app may propose lifting: never factory reset or debugging. */
export const LIFTABLE = [...SAFE_RESTRICTIONS, ...LOCK_RESTRICTIONS] as const;
export type Liftable = (typeof LIFTABLE)[number];

export type ProposalChange =
  | { kind: "allow_app"; package: string }
  | { kind: "resume" }
  | { kind: "lift_restriction"; restriction: Liftable }
  | { kind: "web_filter_off" }
  | { kind: "new_apps_allow" }
  /** Phase 3: a change to a phone's screen-time rules that doesn't only tighten. */
  | { kind: "screen_time"; patch: RulesPatch }
  /** Phase 3: moving a phone to another stage, which is always a parent's. */
  | { kind: "move_stage"; stageId: string; stageName: string };

/** "outdated": a parent tried to approve it, but what it was about had changed since, so nothing was applied. */
export type ProposalStatus = "pending" | "approved" | "rejected" | "outdated";

/**
 * What a proposal was about when it was made, to tell when a parent approves it whether that
 * changed since: the app's latest decision, the pause in force, the web filter, the phone's stage.
 * A screen-time change keeps what each part was in its patch.
 */
type Context =
  | { kind: "allow_app"; decision: number }
  | { kind: "resume"; until: number | null; note: string | null; set_at: number | null }
  | { kind: "web_filter_off"; private_dns: string | null }
  | { kind: "move_stage"; stage_id: string | null; since: number | null };

export interface Proposal {
  id: string;
  deviceId: string;
  deviceName: string;
  change: ProposalChange;
  /** For allow_app: the app's name, from its developer (untrusted), when the server knows it. */
  label: string | null;
  /** The AI app's words. */
  reason: string;
  clientName: string;
  /** Whose connection the AI app used. */
  parentName: string | null;
  createdAt: number;
  status: ProposalStatus;
  decidedBy: string | null;
  decidedAt: number | null;
  /** For "outdated": what changed, in words. */
  outdatedWhy: string | null;
  context: Context | null;
}

interface ProposalRow {
  id: string;
  device_id: string;
  device_name: string;
  kind: ProposalKind;
  package: string | null;
  restriction: string | null;
  payload: string | null;
  label: string | null;
  reason: string;
  client_name: string;
  parent_name: string | null;
  created_at: number;
  status: ProposalStatus;
  decided_by_name: string | null;
  decided_at: number | null;
  outdated_why: string | null;
  context: string | null;
}

function parseContext(json: string | null): Context | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Context;
  } catch {
    return null;
  }
}

const isLiftable = (value: string | null): value is Liftable => (LIFTABLE as readonly (string | null)[]).includes(value);

function payloadOf(json: string | null): Record<string, unknown> {
  try {
    const value = json ? (JSON.parse(json) as unknown) : null;
    return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function changeOf(r: Pick<ProposalRow, "kind" | "package" | "restriction" | "payload">): ProposalChange {
  switch (r.kind) {
    case "allow_app":
      return { kind: "allow_app", package: r.package ?? "" };
    case "lift_restriction":
      return { kind: "lift_restriction", restriction: isLiftable(r.restriction) ? r.restriction : "safe_boot" };
    case "screen_time": {
      const patch = payloadOf(r.payload).patch as RulesPatch | undefined;
      return { kind: "screen_time", patch: patch && Array.isArray(patch.limits) && Array.isArray(patch.schedules) ? patch : { limits: [], schedules: [] } };
    }
    case "move_stage": {
      const p = payloadOf(r.payload);
      return { kind: "move_stage", stageId: typeof p.stage_id === "string" ? p.stage_id : "", stageName: typeof p.stage_name === "string" ? p.stage_name : "" };
    }
    default:
      return { kind: r.kind };
  }
}

/** What the change stores in its row besides its kind. */
function payloadFor(change: ProposalChange): string | null {
  if (change.kind === "screen_time") return canonical({ patch: change.patch });
  if (change.kind === "move_stage") return canonical({ stage_id: change.stageId, stage_name: change.stageName });
  return null;
}

/** A screen-time proposal's changes, as classifyScreenTimeChange finds them in its parts. */
export function screenTimeChanges(change: Extract<ProposalChange, { kind: "screen_time" }>): RuleChange[] {
  const { before, after } = patchSides(change.patch);
  return classifyScreenTimeChange(before, after).changes;
}

/** A screen-time proposal's changes in the parents' words, with their effect. */
export function screenTimeWords(change: Extract<ProposalChange, { kind: "screen_time" }>, labels: Labels = packageNames): { effect: RuleChange["effect"]; words: string }[] {
  return screenTimeChanges(change).map((c) => ({ effect: c.effect, words: changeSentence(c, { for: "parent", label: labels }) }));
}

function toProposal(r: ProposalRow): Proposal {
  return {
    id: r.id,
    deviceId: r.device_id,
    deviceName: r.device_name,
    change: changeOf(r),
    label: r.label,
    reason: r.reason,
    clientName: r.client_name,
    parentName: r.parent_name,
    createdAt: r.created_at,
    status: r.status,
    decidedBy: r.decided_by_name,
    decidedAt: r.decided_at,
    outdatedWhy: r.outdated_why,
    context: parseContext(r.context),
  };
}

const SELECT = `SELECT x.id, x.device_id, d.name AS device_name, x.kind, x.package, x.restriction, x.payload,
    COALESCE((SELECT a.label FROM apps a WHERE a.device_id = x.device_id AND a.package = x.package),
             (SELECT r.label FROM requests r WHERE r.device_id = x.device_id AND r.package = x.package AND r.kind = 'app' ORDER BY r.received_at DESC LIMIT 1)) AS label,
    x.reason, x.client_name, p.name AS parent_name, x.created_at, x.status, q.name AS decided_by_name, x.decided_at, x.outdated_why, x.context
  FROM proposals x JOIN devices d ON d.id = x.device_id
  LEFT JOIN parents p ON p.id = x.parent_id LEFT JOIN parents q ON q.id = x.decided_by`;

/** "Allow "Chatter Box"", and "allowing "Chatter Box"" for a sentence. */
export function changeWords(change: ProposalChange, label: string | null, labels: Labels = packageNames): { title: string; gerund: string } {
  switch (change.kind) {
    case "screen_time": {
      const words = screenTimeWords(change, labels).map((c) => c.words);
      const first = oneLine(words[0] ?? "a change", 120);
      const more = words.length > 1 ? ` (and ${words.length - 1} more change${words.length === 2 ? "" : "s"})` : "";
      return { title: `Change screen time: ${first}${more}`, gerund: `changing screen time: ${first}${more}` };
    }
    case "move_stage": {
      const name = `"${oneLine(change.stageName, 60)}"`;
      return { title: `Move to the stage ${name}`, gerund: `moving the phone to the stage ${name}` };
    }
    case "allow_app": {
      const name = label ? `"${oneLine(label, 60)}"` : change.package;
      return { title: `Allow ${name}`, gerund: `allowing ${name}` };
    }
    case "resume":
      return { title: "Resume the paused phone", gerund: "resuming the paused phone" };
    case "lift_restriction": {
      // "Safe mode" reads "safe mode" mid-sentence; "VPN settings" keeps its capitals.
      const name = RESTRICTION_NAMES[change.restriction];
      const what = /^[A-Z]{2}/.test(name) ? name : name.charAt(0).toLowerCase() + name.slice(1);
      return { title: `Lift the lock on ${what}`, gerund: `lifting the lock on ${what}` };
    }
    case "web_filter_off":
      return { title: "Turn off the web filter", gerund: "turning off the web filter" };
    case "new_apps_allow":
      return { title: "Let new apps run without asking", gerund: "letting new apps run without asking" };
  }
}

/** Why there's nothing to propose (the change wouldn't loosen anything now), or null. */
export function nothingToLoosen(db: DB, deviceId: string, change: ProposalChange, now: number): string | null {
  const rules = getRules(db, deviceId);
  switch (change.kind) {
    case "allow_app":
      if (neverBlockedReason(db, deviceId, change.package)) return `${change.package} always runs: Belay never blocks it.`;
      return currentDecision(db, deviceId, change.package)?.state === "allowed" ? "That app is already allowed." : null;
    case "resume":
      return activePause(rules, now) ? null : "The phone isn't paused.";
    case "lift_restriction":
      return rules.restrictions[change.restriction] ? null : `${RESTRICTION_NAMES[change.restriction]} isn't locked.`;
    case "web_filter_off":
      return rules.privateDns ? null : "There's no web filter to turn off.";
    case "new_apps_allow":
      return rules.newApps === "ask" ? null : "New apps already run without asking.";
    case "screen_time": {
      if (emptyPatch(change.patch)) return "It changes nothing.";
      const applied = applyPatch(phoneRules(db, deviceId).rules, change.patch);
      return "rules" in applied && canonical(applied.rules) === canonical(phoneRules(db, deviceId).rules) ? "The phone's screen time is already like that." : null;
    }
    case "move_stage": {
      if (!getStage(db, change.stageId)) return "That stage was deleted.";
      return phoneRules(db, deviceId).stage?.stage.id === change.stageId ? "The phone is already on that stage." : null;
    }
  }
}

/** The newest decision about one app on the phone (0: none). */
function latestDecisionId(db: DB, deviceId: string, pkg: string): number {
  return db.prepare<[string, string], { id: number | null }>("SELECT MAX(id) AS id FROM app_decisions WHERE device_id = ? AND package = ?").get(deviceId, pkg)?.id ?? 0;
}

/** What the change is about, now. */
function contextOf(db: DB, deviceId: string, change: ProposalChange, now: number): Context | null {
  switch (change.kind) {
    case "allow_app":
      return { kind: "allow_app", decision: latestDecisionId(db, deviceId, change.package) };
    case "resume": {
      const pause = activePause(getRules(db, deviceId), now);
      return pause ? { kind: "resume", until: pause.until, note: pause.note, set_at: pause.setAt } : null;
    }
    case "web_filter_off":
      return { kind: "web_filter_off", private_dns: getRules(db, deviceId).privateDns };
    case "move_stage": {
      const stage = phoneRules(db, deviceId).stage;
      return { kind: "move_stage", stage_id: stage?.stage.id ?? null, since: stage?.since ?? null };
    }
    default:
      return null;
  }
}

/**
 * Why approving the proposal now wouldn't do what it said when it was made, or null: it
 * wouldn't loosen anything any more, or what it was about changed since (a different pause, the
 * app's rule decided again, the kid's request for it answered, another web filter).
 */
export function outdatedBecause(db: DB, proposal: Proposal, now: number): string | null {
  const nothing = nothingToLoosen(db, proposal.deviceId, proposal.change, now);
  if (nothing) return nothing;
  const then = proposal.context;
  const change = proposal.change;
  if (then?.kind === "allow_app" && change.kind === "allow_app") {
    if (latestDecisionId(db, proposal.deviceId, change.package) !== then.decision) return "The app's rule changed after this was proposed.";
    const answered = db
      .prepare<[string, string, number], { n: number }>(
        "SELECT COUNT(*) AS n FROM requests WHERE device_id = ? AND package = ? AND answered_at > ? AND status IN ('declined', 'talk')",
      )
      .get(proposal.deviceId, change.package, proposal.createdAt);
    if (answered?.n) return "A parent answered the kid's request for this app after this was proposed.";
  }
  if (then?.kind === "resume" && change.kind === "resume") {
    const current = contextOf(db, proposal.deviceId, change, now);
    if (current?.kind === "resume" && (current.until !== then.until || current.note !== then.note || current.set_at !== then.set_at)) {
      return "The phone was paused again after this was proposed: it's a different pause now.";
    }
  }
  if (then?.kind === "web_filter_off" && change.kind === "web_filter_off" && getRules(db, proposal.deviceId).privateDns !== then.private_dns) {
    return "The web filter changed after this was proposed.";
  }
  // Screen time: each part it changes must still be as it was; the rest may have changed.
  if (change.kind === "screen_time") {
    const applied = applyPatch(phoneRules(db, proposal.deviceId).rules, change.patch);
    if ("outdated" in applied) return applied.outdated;
  }
  if (then?.kind === "move_stage" && change.kind === "move_stage") {
    const stage = phoneRules(db, proposal.deviceId).stage;
    if ((stage?.stage.id ?? null) !== then.stage_id || (stage?.since ?? null) !== then.since) return "The phone's stage changed after this was proposed.";
  }
  return null;
}

/**
 * Records an AI app's proposal, in the activity log too. The same change still waiting is
 * returned instead of a second one.
 */
export function createProposal(
  db: DB,
  now: number,
  deviceId: string,
  change: ProposalChange,
  reason: string,
  by: { parentId: string; clientName: string },
): { proposal: Proposal; duplicate: boolean } {
  // Phase 11: Off belay is a parent's step on the parent page, never an AI app's, not even as a proposal.
  if (change.kind === "move_stage" && getStage(db, change.stageId)?.offBelay) {
    throw new RuleRefused("Only a parent moves a phone to Off belay, on the parent page: an AI app can't propose it.");
  }
  return db.transaction(() => {
    const pkg = change.kind === "allow_app" ? change.package : null;
    const restriction = change.kind === "lift_restriction" ? change.restriction : null;
    const payload = payloadFor(change);
    const same = db
      .prepare<[string, string, string | null, string | null, string | null], { id: string }>(
        "SELECT id FROM proposals WHERE device_id = ? AND kind = ? AND package IS ? AND restriction IS ? AND payload IS ? AND status = 'pending'",
      )
      .get(deviceId, change.kind, pkg, restriction, payload);
    const id = same?.id ?? newId();
    if (!same) {
      const context = contextOf(db, deviceId, change, now);
      db.prepare(
        `INSERT INTO proposals (id, device_id, kind, package, restriction, payload, reason, client_name, parent_id, created_at, context)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, deviceId, change.kind, pkg, restriction, payload, reason.trim().slice(0, 1000), by.clientName, by.parentId, now, context ? JSON.stringify(context) : null);
    }
    const proposal = getProposal(db, id);
    if (!proposal) throw new Error("proposal vanished");
    if (!same) {
      audit(db, now, { kind: "ai", parentId: by.parentId, clientName: by.clientName }, "proposal.created", {
        deviceId,
        detail: { change: changeWords(change, proposal.label, phoneLabels(db, deviceId)).title, package: pkg ?? undefined },
      });
    }
    return { proposal, duplicate: !!same };
  })();
}

export function getProposal(db: DB, id: string): Proposal | null {
  const row = db.prepare<[string], ProposalRow>(`${SELECT} WHERE x.id = ?`).get(id);
  return row ? toProposal(row) : null;
}

/** Waiting ones first, then newest first. */
export function listProposals(db: DB, filter: { status?: ProposalStatus; deviceId?: string; limit?: number } = {}): Proposal[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.status) {
    where.push("x.status = ?");
    args.push(filter.status);
  }
  if (filter.deviceId) {
    where.push("x.device_id = ?");
    args.push(filter.deviceId);
  }
  return db
    .prepare<(string | number)[], ProposalRow>(
      `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY x.status = 'pending' DESC, x.created_at DESC, x.rowid DESC LIMIT ?`,
    )
    .all(...args, filter.limit ?? 200)
    .map(toProposal);
}

export function pendingProposalCount(db: DB): number {
  return db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM proposals WHERE status = 'pending'").get()?.n ?? 0;
}

export type Decided = { ok: true; proposal: Proposal } | { ok: false; reason: string; outdated?: boolean };

/**
 * A parent approves a proposal: the change is applied in their name, with their note (for an
 * app, the note goes with the kid's request's answer too). One that's out of date
 * (outdatedBecause) is marked so instead, and nothing changes.
 */
export function approveProposal(ctx: PolicyContext, id: string, parentId: string, note: string | null = null): Decided {
  const { db, now } = ctx;
  return db.transaction((): Decided => {
    const proposal = getProposal(db, id);
    if (!proposal) return { ok: false, reason: "There's no such proposal." };
    if (proposal.status !== "pending") return { ok: false, reason: `It was already ${proposal.status === "outdated" ? "out of date" : proposal.status}.` };
    const parent = { kind: "parent", parentId } as const;
    const change = proposal.change;
    const why = outdatedBecause(db, proposal, now);
    if (why) {
      db.prepare("UPDATE proposals SET status = 'outdated', decided_by = ?, decided_at = ?, outdated_why = ? WHERE id = ?").run(parentId, now, why, id);
      audit(db, now, parent, "proposal.outdated", {
        deviceId: proposal.deviceId,
        detail: { change: changeWords(change, proposal.label).title, client: proposal.clientName, why },
      });
      return { ok: false, outdated: true, reason: why };
    }
    switch (change.kind) {
      case "allow_app":
        decideApp(ctx, proposal.deviceId, change.package, "allowed", parent, { note, proposalId: proposal.id });
        break;
      case "resume":
        resumePhone(ctx, proposal.deviceId, parent);
        break;
      case "lift_restriction":
        setRestrictions(ctx, proposal.deviceId, { [change.restriction]: false }, parent);
        break;
      case "web_filter_off":
        setWeb(ctx, proposal.deviceId, { privateDns: null }, parent);
        break;
      case "new_apps_allow":
        setNewApps(ctx, proposal.deviceId, "allow", parent);
        break;
      case "screen_time": {
        const current = phoneRules(db, proposal.deviceId);
        const applied = applyPatch(current.rules, change.patch);
        // outdatedBecause checked it; this keeps it true.
        if ("outdated" in applied) throw new Error(applied.outdated);
        setPhoneRules(ctx, proposal.deviceId, applied.rules, parent, { proposalId: proposal.id });
        break;
      }
      case "move_stage":
        moveToStage(ctx, proposal.deviceId, change.stageId, parent, { proposalId: proposal.id });
        break;
    }
    db.prepare("UPDATE proposals SET status = 'approved', decided_by = ?, decided_at = ? WHERE id = ?").run(parentId, now, id);
    audit(db, now, parent, "proposal.approved", { deviceId: proposal.deviceId, detail: { change: changeWords(change, proposal.label).title, client: proposal.clientName } });
    return { ok: true, proposal: { ...proposal, status: "approved", decidedAt: now } };
  })();
}

/** A parent rejects a proposal: nothing changes on the phone. */
export function rejectProposal(db: DB, now: number, id: string, parentId: string): Decided {
  return db.transaction((): Decided => {
    const proposal = getProposal(db, id);
    if (!proposal) return { ok: false, reason: "There's no such proposal." };
    if (proposal.status !== "pending") return { ok: false, reason: `It was already ${proposal.status}.` };
    db.prepare("UPDATE proposals SET status = 'rejected', decided_by = ?, decided_at = ? WHERE id = ?").run(parentId, now, id);
    audit(db, now, { kind: "parent", parentId }, "proposal.rejected", {
      deviceId: proposal.deviceId,
      detail: { change: changeWords(proposal.change, proposal.label).title, client: proposal.clientName },
    });
    return { ok: true, proposal: { ...proposal, status: "rejected", decidedAt: now } };
  })();
}
