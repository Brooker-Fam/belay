/**
 * Phase 3's network logging switch, through family/policy.ts's changePolicy: one transaction, the
 * activity log, and a new policy version for the phone. Collecting is a parent's decision: the
 * parent page, or the server's CLI acting as one. An AI app can't turn it on or off, in either
 * direction, and can't propose to: more collection is a privacy choice, not a safety tightening.
 */
import { type Changed, type Person, type PolicyContext, changePolicy } from "../policy.js";
import { networkSettings } from "./store.js";

/** Turns the phone's network logging on or off. `already`: it was that way, and nothing changed. */
export function setNetworkLog(ctx: PolicyContext, deviceId: string, on: boolean, who: Person): Changed<{ already: boolean }> {
  // The types already say so; this keeps it true at run time too.
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a parent turns network logging on or off: an AI app can't, and can't propose it");
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    if ((networkSettings(db, deviceId)?.enabled ?? false) === on) return { already: true };
    db.prepare(
      `INSERT INTO network_settings (device_id, enabled, enabled_at, changed_at, changed_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET enabled = excluded.enabled, enabled_at = COALESCE(excluded.enabled_at, network_settings.enabled_at),
         changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
    ).run(deviceId, on ? 1 : 0, on ? now : null, now, who.kind === "parent" ? who.parentId : null);
    log(on ? "network.on" : "network.off");
    return { already: false };
  });
}
