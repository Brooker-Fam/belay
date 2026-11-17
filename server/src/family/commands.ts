/**
 * Phase 10: one-shot commands to a phone (docs/protocol.md, "Commands"). A parent issues one on the
 * parent page, or the CLI does as a person; never an AI client. It's in the policy's commands
 * until the phone reports its result in enforcement.commands; after expires_at (7 days) the phone
 * doesn't run it and reports it expired. The first kind is remove_other_users: the phone removes
 * every other user or profile, such as the one Android's own Parental Controls make.
 */
import { newId } from "../crypto.js";
import type { DB } from "../db.js";
import { changePolicy, type Changed, type Person, type PolicyContext } from "./policy.js";

export type CommandKind = "remove_other_users";
export const COMMAND_LIFETIME_MS = 7 * 86_400_000;

/** "waiting" for the phone; "not_done": it expired with no word from the phone; "replaced" by a newer one. */
export type CommandState = "waiting" | "done" | "failed" | "expired" | "not_done" | "replaced";

export interface Command {
  id: string;
  kind: CommandKind;
  issuedAt: number;
  expiresAt: number | null;
  issuedBy: string | null;
  result: "done" | "failed" | "expired" | null;
  /** The phone's clock. */
  resultAt: number | null;
  /** The phone's words when it failed: untrusted. */
  problem: string | null;
  reportedAt: number | null;
  state: CommandState;
}

interface CommandRow {
  id: string;
  kind: CommandKind;
  issued_at: number;
  expires_at: number | null;
  issued_by_name: string | null;
  result: Command["result"];
  result_at: number | null;
  problem: string | null;
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
    result: r.result,
    resultAt: r.result_at,
    problem: r.problem,
    reportedAt: r.reported_at,
    state,
  };
}

const SELECT = `SELECT c.id, c.kind, c.issued_at, c.expires_at, p.name AS issued_by_name, c.result, c.result_at, c.problem, c.reported_at, c.replaced_at
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
 * Sends a command to the phone with its next policy. One of a kind at a time: while one is still
 * waiting and not expired, that's the answer (`already`); an expired one without a result is
 * replaced. A person's action, never an AI client's.
 */
export function issueCommand(ctx: PolicyContext, deviceId: string, kind: CommandKind, who: Person): Changed<{ command: Command; already: boolean }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a person sends a phone a command");
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const waiting = listCommands(db, deviceId, now, { kind, limit: 50 }).find((c) => c.state === "waiting");
    if (waiting) return { command: waiting, already: true };
    db.prepare("UPDATE commands SET replaced_at = ? WHERE device_id = ? AND kind = ? AND result IS NULL AND replaced_at IS NULL").run(now, deviceId, kind);
    const id = newId();
    db.prepare("INSERT INTO commands (id, device_id, kind, issued_at, expires_at, issued_by) VALUES (?, ?, ?, ?, ?, ?)").run(
      id,
      deviceId,
      kind,
      now,
      now + COMMAND_LIFETIME_MS,
      who.kind === "parent" ? who.parentId : null,
    );
    log("command.issued", { kind, command: id, expires_at: now + COMMAND_LIFETIME_MS });
    const command = listCommands(db, deviceId, now, { kind, limit: 1 })[0];
    if (!command) throw new Error("command vanished");
    return { command, already: false };
  });
}
