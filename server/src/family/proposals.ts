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
  SAFE_RESTRICTIONS,
  activePause,
  currentDecision,
  decideApp,
  getRules,
  neverBlocked,
  resumePhone,
  setNewApps,
  setRestrictions,
  setWeb,
  type PolicyContext,
} from "./policy.js";

export const PROPOSAL_KINDS = ["allow_app", "resume", "lift_restriction", "web_filter_off", "new_apps_allow"] as const;
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

/** The locks an AI app may propose lifting: never factory reset or debugging. */
export const LIFTABLE = [...SAFE_RESTRICTIONS, ...LOCK_RESTRICTIONS] as const;
export type Liftable = (typeof LIFTABLE)[number];

export type ProposalChange =
  | { kind: "allow_app"; package: string }
  | { kind: "resume" }
  | { kind: "lift_restriction"; restriction: Liftable }
  | { kind: "web_filter_off" }
  | { kind: "new_apps_allow" };

export type ProposalStatus = "pending" | "approved" | "rejected";

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
}

interface ProposalRow {
  id: string;
  device_id: string;
  device_name: string;
  kind: ProposalKind;
  package: string | null;
  restriction: string | null;
  label: string | null;
  reason: string;
  client_name: string;
  parent_name: string | null;
  created_at: number;
  status: ProposalStatus;
  decided_by_name: string | null;
  decided_at: number | null;
}

const isLiftable = (value: string | null): value is Liftable => (LIFTABLE as readonly (string | null)[]).includes(value);

function changeOf(r: Pick<ProposalRow, "kind" | "package" | "restriction">): ProposalChange {
  switch (r.kind) {
    case "allow_app":
      return { kind: "allow_app", package: r.package ?? "" };
    case "lift_restriction":
      return { kind: "lift_restriction", restriction: isLiftable(r.restriction) ? r.restriction : "safe_boot" };
    default:
      return { kind: r.kind };
  }
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
  };
}

const SELECT = `SELECT x.id, x.device_id, d.name AS device_name, x.kind, x.package, x.restriction,
    COALESCE((SELECT a.label FROM apps a WHERE a.device_id = x.device_id AND a.package = x.package),
             (SELECT r.label FROM requests r WHERE r.device_id = x.device_id AND r.package = x.package ORDER BY r.received_at DESC LIMIT 1)) AS label,
    x.reason, x.client_name, p.name AS parent_name, x.created_at, x.status, q.name AS decided_by_name, x.decided_at
  FROM proposals x JOIN devices d ON d.id = x.device_id
  LEFT JOIN parents p ON p.id = x.parent_id LEFT JOIN parents q ON q.id = x.decided_by`;

/** "Allow "Chatter Box"", and "allowing "Chatter Box"" for a sentence. */
export function changeWords(change: ProposalChange, label: string | null): { title: string; gerund: string } {
  switch (change.kind) {
    case "allow_app": {
      const name = label ? `"${oneLine(label, 60)}"` : change.package;
      return { title: `Allow ${name}`, gerund: `allowing ${name}` };
    }
    case "resume":
      return { title: "Resume the paused phone", gerund: "resuming the paused phone" };
    case "lift_restriction": {
      const what = RESTRICTION_NAMES[change.restriction].toLowerCase();
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
      if (neverBlocked(change.package)) return `${change.package} always runs: Belay never blocks it.`;
      return currentDecision(db, deviceId, change.package)?.state === "allowed" ? "That app is already allowed." : null;
    case "resume":
      return activePause(rules, now) ? null : "The phone isn't paused.";
    case "lift_restriction":
      return rules.restrictions[change.restriction] ? null : `${RESTRICTION_NAMES[change.restriction]} isn't locked.`;
    case "web_filter_off":
      return rules.privateDns ? null : "There's no web filter to turn off.";
    case "new_apps_allow":
      return rules.newApps === "ask" ? null : "New apps already run without asking.";
  }
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
  return db.transaction(() => {
    const pkg = change.kind === "allow_app" ? change.package : null;
    const restriction = change.kind === "lift_restriction" ? change.restriction : null;
    const same = db
      .prepare<[string, string, string | null, string | null], { id: string }>(
        "SELECT id FROM proposals WHERE device_id = ? AND kind = ? AND package IS ? AND restriction IS ? AND status = 'pending'",
      )
      .get(deviceId, change.kind, pkg, restriction);
    const id = same?.id ?? newId();
    if (!same) {
      db.prepare(
        `INSERT INTO proposals (id, device_id, kind, package, restriction, reason, client_name, parent_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, deviceId, change.kind, pkg, restriction, reason.trim().slice(0, 1000), by.clientName, by.parentId, now);
    }
    const proposal = getProposal(db, id);
    if (!proposal) throw new Error("proposal vanished");
    if (!same) {
      audit(db, now, { kind: "ai", parentId: by.parentId, clientName: by.clientName }, "proposal.created", {
        deviceId,
        detail: { change: changeWords(change, proposal.label).title, package: pkg ?? undefined },
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

export type Decided = { ok: true; proposal: Proposal } | { ok: false; reason: string };

/**
 * A parent approves a proposal: the change is applied in their name, with their note (for an
 * app, the note goes with the kid's request's answer too).
 */
export function approveProposal(ctx: PolicyContext, id: string, parentId: string, note: string | null = null): Decided {
  const { db, now } = ctx;
  return db.transaction((): Decided => {
    const proposal = getProposal(db, id);
    if (!proposal) return { ok: false, reason: "There's no such proposal." };
    if (proposal.status !== "pending") return { ok: false, reason: `It was already ${proposal.status}.` };
    const parent = { kind: "parent", parentId } as const;
    const change = proposal.change;
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
