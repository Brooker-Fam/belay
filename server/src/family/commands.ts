/**
 * One-shot commands to a phone (docs/protocol.md, "Commands"). It's in the policy's commands until
 * the phone reports its result in enforcement.commands; after expires_at the phone doesn't run it
 * and reports it expired.
 *
 * - remove_other_users (Phase 10): the phone removes every other user or profile, such as the one
 *   Android's own Parental Controls make. A parent issues it on the parent page, or the CLI does
 *   as a person; never an AI client. It lasts 7 days.
 * - lock_now (Phase 3): the phone locks its screen once. MCP's lock_phone sends it with a pause
 *   (policy.ts, lockPhone); the CLI's lock-now sends it alone. It lasts 10 minutes by default:
 *   a lock that arrives much later would surprise the kid.
 * - locate_now (Phase 4): the phone takes one fix and sends it, naming the command. A parent's
 *   "Check now", the CLI's locate-now, or MCP's locate_now (family/location/changes.ts). It lasts
 *   2 minutes: a check is about now.
 */
import type { DB } from "../db.js";
import { type CommandKind, LOCK_NOW_MS, changePolicy, insertCommandRow, type Changed, type Person, type PolicyContext } from "./policy.js";

export type { CommandKind } from "./policy.js";
export const COMMAND_LIFETIME_MS = 7 * 86_400_000;
/** Phase 4: a check of where the phone is lasts this long. */
export const LOCATE_NOW_MS = 2 * 60_000;
const LIFETIME: Record<CommandKind, number> = { remove_other_users: COMMAND_LIFETIME_MS, lock_now: LOCK_NOW_MS, locate_now: LOCATE_NOW_MS };

/** "waiting" for the phone; "not_done": it expired with no word from the phone; "replaced" by a newer one. */
export type CommandState = "waiting" | "done" | "failed" | "expired" | "not_done" | "replaced";

export interface Command {
  id: string;
  kind: CommandKind;
  issuedAt: number;
  expiresAt: number | null;
  issuedBy: string | null;
  /** The AI app a parent used to send it, by the name it registered with: untrusted. Null when a person sent it. */
  via: string | null;
  result: "done" | "failed" | "expired" | null;
  /** The phone's clock. */
  resultAt: number | null;
  /** The phone's words when it failed: untrusted. */
  problem: string | null;
  /** An expired lock_now whose lock waited for a call that was still on (not one the phone got too late). */
  waitedForCall: boolean;
  reportedAt: number | null;
  state: CommandState;
}

interface CommandRow {
  id: string;
  kind: CommandKind;
  issued_at: number;
  expires_at: number | null;
  issued_by_name: string | null;
  client_name: string | null;
  result: Command["result"];
  result_at: number | null;
  problem: string | null;
  waited_for_call: number;
  reported_at: number | null;
  replaced_at: number | null;
}

function toCommand(r: CommandRow, now: number): Command {
  const state: CommandState =
    r.result ?? (r.replaced_at !== null ? "replaced" : r.expires_at !== null && now > r.expires_at ? "not_done" : "waiting");
  return {
    id: r.id,
    kind: r.kind,
    issuedAt: r.issued_at,
    expiresAt: r.expires_at,
    issuedBy: r.issued_by_name,
    via: r.client_name,
    result: r.result,
    resultAt: r.result_at,
    problem: r.problem,
    waitedForCall: r.waited_for_call === 1,
    reportedAt: r.reported_at,
    state,
  };
}

const SELECT = `SELECT c.id, c.kind, c.issued_at, c.expires_at, p.name AS issued_by_name, c.client_name, c.result, c.result_at, c.problem, c.waited_for_call, c.reported_at, c.replaced_at
  FROM commands c LEFT JOIN parents p ON p.id = c.issued_by`;

/** The phone's commands, newest first; of one kind, if given. */
export function listCommands(db: DB, deviceId: string, now: number, opts: { kind?: CommandKind; limit?: number } = {}): Command[] {
  return db
    .prepare<[string, string | null, string | null, number], CommandRow>(
      `${SELECT} WHERE c.device_id = ? AND (? IS NULL OR c.kind = ?) ORDER BY c.issued_at DESC, c.rowid DESC LIMIT ?`,
    )
    .all(deviceId, opts.kind ?? null, opts.kind ?? null, opts.limit ?? 10)
    .map((r) => toCommand(r, now));
}

/**
 * Sends a command to the phone with its next policy. remove_other_users is one at a time: while
 * one is still waiting and not expired, that's the answer (`already`); an expired one without a
 * result is replaced. lock_now is always a new one, replacing any still waiting: the phone locks
 * once, for the newest; so is locate_now. A person's action here (an AI app locks only through
 * lockPhone, and checks where the phone is only through family/location/changes.ts's locateNow).
 */
export function issueCommand(
  ctx: PolicyContext,
  deviceId: string,
  kind: CommandKind,
  who: Person,
  opts: { expiresInMs?: number } = {},
): Changed<{ command: Command; already: boolean }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a person sends a phone a command");
  const { db, now } = ctx;
  const lifetime = opts.expiresInMs ?? LIFETIME[kind];
  return changePolicy(ctx, deviceId, who, (log) => {
    const waiting = kind !== "remove_other_users" ? undefined : listCommands(db, deviceId, now, { kind, limit: 50 }).find((c) => c.state === "waiting");
    if (waiting) return { command: waiting, already: true };
    db.prepare("UPDATE commands SET replaced_at = ? WHERE device_id = ? AND kind = ? AND result IS NULL AND replaced_at IS NULL").run(now, deviceId, kind);
    const id = insertCommandRow(db, deviceId, kind, now, now + lifetime, who);
    log("command.issued", { kind, command: id, expires_at: now + lifetime });
    const command = listCommands(db, deviceId, now, { kind, limit: 1 })[0];
    if (!command) throw new Error("command vanished");
    return { command, already: false };
  });
}
