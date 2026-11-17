/**
 * What the phone reports about itself, in its check-ins and app lists (docs/protocol.md,
 * "Device"): saved, and acted on. Some of it changes what the phone gets: the update offered to
 * it leaves the policy once it runs that version. So a report goes through changePolicy, as the
 * phone's own change, and the version goes up when what the phone would see changed.
 */
import type { Device } from "../device/schemas.js";
import { changePolicy, type Changed, type PolicyContext } from "./policy.js";

export function receiveReport(ctx: PolicyContext, deviceId: string, device: Device): Changed<null> {
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, { kind: "phone", deviceId }, () => {
    db.prepare("UPDATE devices SET facts = ?, facts_at = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(device), now, now, deviceId);
    return null;
  });
}
