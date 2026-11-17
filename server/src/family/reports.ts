/**
 * What the phone reports about itself, in its check-ins and app lists (docs/protocol.md,
 * "Device"): saved, and acted on. Some of it changes what the phone gets (the update offered to
 * it leaves the policy once it runs that version), so a report goes through changePolicy, as
 * the phone's own change: the version goes up when what the phone would see changed. What's new
 * in it for the parents (an update that failed) comes back as `tell`, for the caller to push
 * once the change is saved.
 */
import type { Device } from "../device/schemas.js";
import { LIMITS } from "../device/schemas.js";
import { cleanText } from "../text.js";
import { changePolicy, type Changed, type Log, type PolicyContext } from "./policy.js";

/** Something the parents hear about at once. The words are the server's, never the phone's. */
export type Tell = { kind: "update_failed"; version: string };

/** The phone's words, kept as the phone said them, less what hides or reorders text: untrusted. */
const phoneWords = (text: string | null | undefined): string | null => (text ? cleanText(text, LIMITS.maxProblem) || null : null);

export function receiveReport(ctx: PolicyContext, deviceId: string, device: Device): Changed<{ tell: Tell[] }> {
  const { db, now } = ctx;
  return changePolicy(ctx, deviceId, { kind: "phone", deviceId }, (log) => {
    db.prepare("UPDATE devices SET facts = ?, facts_at = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(device), now, now, deviceId);
    // The first signing certificate the server hears is pinned; a different one later shows as a problem.
    if (device.agent_signing_sha256) {
      db.prepare("UPDATE devices SET agent_signing_sha256 = ?, agent_signing_at = ? WHERE id = ? AND agent_signing_sha256 IS NULL").run(device.agent_signing_sha256, now, deviceId);
    }
    const tell: Tell[] = [];
    noteUpdate(ctx, deviceId, device, log, tell);
    return { tell };
  });
}

interface OfferRow {
  version_code: number;
  version_name: string | null;
  installing_at: number | null;
  done_at: number | null;
  failure_told_at: number | null;
}

/** How the offered update is going: the phone's state for it, when it ran it, whether it failed. */
function noteUpdate(ctx: PolicyContext, deviceId: string, device: Device, log: Log, tell: Tell[]): void {
  const { db, now } = ctx;
  const offer = db
    .prepare<[string], OfferRow>(
      `SELECT f.version_code, f.version_name, o.installing_at, o.done_at, o.failure_told_at
       FROM agent_offers o JOIN agent_files f ON f.sha256 = o.sha256 WHERE o.device_id = ?`,
    )
    .get(deviceId);
  if (!offer) return;
  const version = offer.version_name ? `${offer.version_name} (version ${offer.version_code})` : `version ${offer.version_code}`;
  const report = device.enforcement?.agent_update;
  // A report about another version (an earlier offer) says nothing about this one.
  if (report && report.version_code === offer.version_code) {
    const problem = phoneWords(report.problem);
    db.prepare(
      `UPDATE agent_offers SET state = ?, problem = ?, state_at = ?, reported_at = ?,
         installing_at = COALESCE(installing_at, CASE WHEN ? = 'installing' THEN ? END) WHERE device_id = ?`,
    ).run(report.state, problem, report.at, now, report.state, now, deviceId);
    if (report.state === "failed" && offer.failure_told_at === null && offer.done_at === null) {
      db.prepare("UPDATE agent_offers SET failure_told_at = ? WHERE device_id = ?").run(now, deviceId);
      log("agent.update_failed", { version_code: offer.version_code, version_name: offer.version_name ?? undefined });
      tell.push({ kind: "update_failed", version });
    }
  }
  if (device.agent_version_code >= offer.version_code && offer.done_at === null) {
    db.prepare("UPDATE agent_offers SET done_at = ? WHERE device_id = ?").run(now, deviceId);
    log("agent.updated", { version_code: offer.version_code, version_name: offer.version_name ?? undefined, running: device.agent_version_code });
  }
}
