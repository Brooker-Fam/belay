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
export type Tell = { kind: "update_failed"; version: string } | { kind: "recovery_used" };

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
    noteRecovery(ctx, deviceId, device, log, tell);
    noteCommands(ctx, deviceId, device, log);
    return { tell };
  });
}

/**
 * The phone's results for one-shot commands (enforcement.commands, its last 20): each command the
 * server sent this phone gets its first result, and leaves the policy. Results for ids the server
 * never sent this phone (a test's own command, say) are ignored.
 */
function noteCommands(ctx: PolicyContext, deviceId: string, device: Device, log: Log): void {
  const { db, now } = ctx;
  const record = db.prepare("UPDATE commands SET result = ?, result_at = ?, problem = ?, reported_at = ? WHERE device_id = ? AND id = ? AND result IS NULL");
  const kindOf = db.prepare<[string, string], { kind: string }>("SELECT kind FROM commands WHERE device_id = ? AND id = ?");
  for (const r of device.enforcement?.commands ?? []) {
    if (record.run(r.result, r.at, phoneWords(r.problem), now, deviceId, r.id).changes === 1) {
      log(`command.${r.result}`, { kind: kindOf.get(deviceId, r.id)?.kind, command: r.id });
    }
  }
}

/**
 * The phone reports the recovery key was used (enforcement.recovery): the server takes it for the
 * key the policy carries now, the phone's newest, and only once. Then the key's check leaves the
 * policy and the parents hear, in words that say it's the phone's report: nothing but the phone
 * says so, and a phone token could send it. A report about an earlier key, one already used, or a
 * version the server never made changes nothing.
 */
function noteRecovery(ctx: PolicyContext, deviceId: string, device: Device, log: Log, tell: Tell[]): void {
  const use = device.enforcement?.recovery;
  if (!use) return;
  const { db, now } = ctx;
  const key = db
    .prepare<[string, number, string], { used_at: number | null }>(
      "SELECT used_at FROM recovery_keys WHERE device_id = ? AND version = ? AND version = (SELECT MAX(version) FROM recovery_keys WHERE device_id = ?)",
    )
    .get(deviceId, use.version, deviceId);
  if (!key || key.used_at !== null) return;
  db.prepare("UPDATE recovery_keys SET used_at = ?, open_until = ?, use_reported_at = ? WHERE device_id = ? AND version = ?").run(use.used_at, use.until, now, deviceId, use.version);
  log("recovery.used", { key_version: use.version, used_at: use.used_at, until: use.until });
  tell.push({ kind: "recovery_used" });
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
