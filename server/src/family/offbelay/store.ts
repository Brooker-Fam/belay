/**
 * Phase 11, off belay (docs/design/phase11-off-belay.md): what the policy and the parent pages
 * read. Off belay is every family's last stage (migration 8): it blocks nothing, and the family
 * writes when it comes, which the kid's phone shows from the first day. The hand-over is a
 * parent's: the changes, with who may make them, are in changes.ts.
 */
import type { DB } from "../../db.js";
import type { Policy } from "../../device/schemas.js";
import { cleanText, oneLine } from "../../text.js";
import { type PhoneRules, nextStage, offBelayStage, phoneRules } from "../screentime/rules.js";

/** Off belay's name: Belay's own word, which the kid's phone uses too. */
export const OFF_BELAY_NAME = "Off belay";

/** A phone being handed over to the kid. */
export interface Handover {
  at: number;
  byParentId: string | null;
  /** The parent's name; null for the server's CLI (or a parent account since removed). */
  byName: string | null;
  /** The rules version that carried it to the phone. */
  version: number;
}

export function handoverOf(db: DB, deviceId: string): Handover | null {
  const row = db
    .prepare<[string], { at: number; by_parent: string | null; by_name: string | null; version: number }>(
      "SELECT h.at, h.by_parent, p.name AS by_name, h.version FROM handovers h LEFT JOIN parents p ON p.id = h.by_parent WHERE h.device_id = ?",
    )
    .get(deviceId);
  return row ? { at: row.at, byParentId: row.by_parent, byName: row.by_name, version: row.version } : null;
}

/** The policy's `handover`: when, and the parent's name for the kid's screen. */
export function handoverFor(db: DB, deviceId: string): Policy["handover"] {
  const handover = handoverOf(db, deviceId);
  // The kid sees the name: on one line, nothing hidden or reordered, like every name in the policy.
  return handover ? { at: handover.at, by: handover.byName === null ? null : oneLine(handover.byName, 60) || null } : null;
}

/**
 * The policy's `off_belay`: the family's words for when it comes, and whether this phone is on it,
 * it's the phone's next stage, or later (a stage or more between, or the phone is on none).
 */
export function offBelayFor(db: DB, deviceId: string, phone: PhoneRules = phoneRules(db, deviceId)): Policy["off_belay"] {
  const stage = offBelayStage(db);
  if (!stage) return null;
  const current = phone.stage?.stage ?? null;
  const position = current?.id === stage.id ? "on" : current && nextStage(db, current.number)?.id === stage.id ? "next" : "later";
  return { how: stage.how === null ? null : cleanText(stage.how, 1000) || null, position };
}
