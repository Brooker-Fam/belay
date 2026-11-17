/**
 * Phase 11's hand-over (docs/design/phase11-off-belay.md, "Winding down"): a parent hands the
 * phone over to the kid. Every step loosens or deletes, so each is a person's: a parent on the
 * parent page (handing over after typing the phone's name, as for hardening), or the server's
 * CLI acting as one. Never an AI app's, not even as a proposal, and nothing here reaches one.
 *
 * Handing over lifts factory reset, debugging and the accounts lock, empties reset protection and
 * Play's allowed accounts (family/policy.ts, liftForHandover), and sets the policy's `handover`: the phone clears its
 * reset protection policy and shows the kid what happens next. Release builds of Belay contain
 * nothing that switches Belay off, so the reset from Settings ends it. Afterwards a parent
 * disconnects the phone and deletes everything about it, as for any phone.
 */
import type { DB } from "../../db.js";
import { type Changed, type Person, type PolicyContext, type Restriction, RuleRefused, changePolicy, liftForHandover, policyVersion } from "../policy.js";
import { type Handover, handoverOf } from "./store.js";

/** The types already say so; this keeps it true at run time too. */
function onlyPeople(who: { kind: string }): void {
  if (who.kind === "ai") throw new Error("Only a parent hands a phone over: an AI app can't, not even as a proposal");
}

export interface HandedOver {
  /** It was handed over already: nothing changed. */
  already: boolean;
  handover: Handover;
  /** The locks it lifted (the ones that were on). */
  lifted: Restriction[];
  /** How many reset-protection accounts it removed. */
  frpAccounts: number;
  /** How many of Play's allowed accounts it removed: Play may use the kid's own account. */
  playAccounts: number;
}

function revoked(db: DB, deviceId: string): boolean {
  return db.prepare<[string], { revoked_at: number | null }>("SELECT revoked_at FROM devices WHERE id = ?").get(deviceId)?.revoked_at != null;
}

/**
 * Hands the phone over: the lifts and the record, in one transaction, and a new rules version the
 * phone gets within seconds. Handing over a phone that's being handed over changes nothing.
 */
export function handOver(ctx: PolicyContext, deviceId: string, who: Person): Changed<HandedOver> {
  onlyPeople(who);
  const { db, now } = ctx;
  const existing = handoverOf(db, deviceId);
  if (existing) return { result: { already: true, handover: existing, lifted: [], frpAccounts: 0, playAccounts: 0 }, version: policyVersion(db, deviceId), changed: false };
  if (revoked(db, deviceId)) throw new RuleRefused("This phone is disconnected, so it wouldn't get the hand-over.");
  return db.transaction(() => {
    const done = liftForHandover(ctx, deviceId, who, (log, lifted) => {
      db.prepare("INSERT INTO handovers (device_id, at, by_parent, version) VALUES (?, ?, ?, 0)").run(deviceId, now, who.kind === "parent" ? who.parentId : null);
      log("policy.handover", { lifted: lifted.restrictions, frp_accounts_removed: lifted.frpAccounts, play_accounts_removed: lifted.playAccounts });
      return lifted;
    });
    db.prepare("UPDATE handovers SET version = ? WHERE device_id = ?").run(done.version, deviceId);
    const handover = handoverOf(db, deviceId);
    if (!handover) throw new Error("the hand-over wasn't recorded");
    return { ...done, result: { already: false, handover, lifted: done.result.restrictions, frpAccounts: done.result.frpAccounts, playAccounts: done.result.playAccounts } };
  }).immediate();
}

/**
 * Takes a hand-over back: the phone stops showing it. What it lifted stays lifted until a parent
 * turns it on again (Hardening, and Settings the kid can't change).
 */
export function cancelHandover(ctx: PolicyContext, deviceId: string, who: Person): Changed<{ was: boolean }> {
  onlyPeople(who);
  const { db } = ctx;
  return changePolicy(ctx, deviceId, who, (log) => {
    const was = db.prepare("DELETE FROM handovers WHERE device_id = ?").run(deviceId).changes > 0;
    if (was) log("policy.handover_cancelled");
    return { was };
  });
}
