/**
 * Phase 13's mobile data changes, through family/policy.ts's changePolicy: one transaction, the
 * activity log, and a new policy version for the phone.
 * - The measuring switch is a parent's alone (the parent page, or the server's CLI acting as one):
 *   collecting more is a privacy choice, not a safety tightening, so an AI app can't turn it on or
 *   off, and can't propose it.
 * - The Wi-Fi-only apps: adding an app tightens, so an AI app may (when the parent asks), but only
 *   an app the phone has reported; taking one off loosens, so it's a person's, or a parent
 *   approving an AI app's proposal (family/proposals.ts). Nobody adds an app the phone never
 *   blocks (the phone app, texting, the keyboard, the home screen, Android's own parts, Belay):
 *   calls, texts, 911 and 988 always work. At most 100 a phone.
 */
import { LIMITS } from "../../device/schemas.js";
import type { DB } from "../../db.js";
import { type Changed, type Changer, type Person, type PolicyContext, RuleRefused, changePolicy, neverBlockedOn } from "../policy.js";
import { classifyWifiOnlyChange } from "./classify.js";
import { mobileDataSettings, wifiOnlyPackages } from "./store.js";

/** A change to a phone's Wi-Fi-only apps: packages to add, and to take off. */
export interface WifiOnlyPatch {
  add: string[];
  remove: string[];
}

/** The types already say so; these keep it true at run time too. */
function onlyPeople(who: Changer, what: string): void {
  if (who.kind === "ai") throw new Error(`Only a parent ${what}: an AI app can't, and can't propose it`);
}

/** Turns measuring mobile data on or off for the phone. `already`: it was that way, and nothing changed. */
export function setMobileDataMeasure(ctx: PolicyContext, deviceId: string, on: boolean, who: Person): Changed<{ already: boolean }> {
  onlyPeople(who, "turns measuring mobile data on or off");
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    if ((mobileDataSettings(db, deviceId)?.measure ?? false) === on) return { already: true };
    db.prepare(
      `INSERT INTO mobile_data_settings (device_id, measure, measure_since, changed_at, changed_by) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET measure = excluded.measure, measure_since = COALESCE(excluded.measure_since, mobile_data_settings.measure_since),
         changed_at = excluded.changed_at, changed_by = excluded.changed_by`,
    ).run(deviceId, on ? 1 : 0, on ? now : null, now, who.kind === "parent" ? who.parentId : null);
    log(on ? "mobile_data.measure_on" : "mobile_data.measure_off");
    return { already: false };
  });
}

/** Whether the phone has ever reported this app (it's in its app list, now or before a removal). */
function reported(db: DB, deviceId: string, pkg: string): boolean {
  return !!db.prepare("SELECT 1 FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg);
}

/**
 * Why `pkg` can't be made Wi-Fi only on the phone by `who`, in the parent's words, or null: never
 * an app the phone never blocks, and for an AI app, never one the phone hasn't reported.
 */
export function wifiOnlyRefusal(db: DB, deviceId: string, pkg: string, who: Changer, never = neverBlockedOn(db, deviceId)): string | null {
  const why = never(pkg);
  if (why) return `${pkg} can't be Wi-Fi only. ${why}`;
  // The phone never restricts Android's own parts (system apps without an icon), like the ones it never blocks.
  const app = db.prepare<[string, string], { system: number; launchable: number }>("SELECT system, launchable FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg);
  if (app && app.system === 1 && app.launchable === 0) return `${pkg} can't be Wi-Fi only. It's one of Android's own parts, which calls and texts may need.`;
  if (who.kind === "ai" && !reported(db, deviceId, pkg)) {
    return `${pkg} isn't an app this phone has reported: an AI app makes only the phone's own apps Wi-Fi only. A parent can add any app, on the phone's Mobile data page.`;
  }
  return null;
}

/** The patch, each package once and sorted; one both added and taken off is refused. */
export function cleanPatch(patch: WifiOnlyPatch): WifiOnlyPatch {
  const add = [...new Set(patch.add)].sort();
  const remove = [...new Set(patch.remove)].sort();
  const both = add.filter((p) => remove.includes(p));
  if (both.length) throw new RuleRefused(`${both.join(", ")} can't be added and taken off Wi-Fi only at once.`);
  return { add, remove };
}

/**
 * Changes the phone's Wi-Fi-only apps. Anyone may add (an AI app only apps the phone reported);
 * only a person takes one off (an AI app proposes it). An app already on the list (or already off
 * it) changes nothing. `proposalId`: a parent approving an AI app's proposal.
 */
export function changeWifiOnly(
  ctx: PolicyContext,
  deviceId: string,
  patch: WifiOnlyPatch,
  who: Changer,
  opts: { proposalId?: string } = {},
): Changed<{ added: string[]; removed: string[] }> {
  const { add, remove } = cleanPatch(patch);
  if (who.kind === "ai" && remove.length) throw new Error("An AI app can't take an app off Wi-Fi only: that's a proposal for a parent");
  const never = neverBlockedOn(ctx.db, deviceId);
  for (const pkg of add) {
    const refused = wifiOnlyRefusal(ctx.db, deviceId, pkg, who, never);
    if (refused) throw new RuleRefused(refused);
  }
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    const before = wifiOnlyPackages(db, deviceId);
    const after = [...new Set([...before.filter((p) => !remove.includes(p)), ...add])].sort();
    if (after.length > LIMITS.maxWifiOnly && after.length > before.length) {
      throw new RuleRefused(`A phone can have at most ${LIMITS.maxWifiOnly} Wi-Fi-only apps.`);
    }
    const classification = classifyWifiOnlyChange(before, after);
    const added = classification.changes.find((c) => c.kind === "added")?.packages ?? [];
    const removed = classification.changes.find((c) => c.kind === "removed")?.packages ?? [];
    const insert = db.prepare("INSERT INTO wifi_only_apps (device_id, package, added_at, added_by, parent_id, client_name) VALUES (?, ?, ?, ?, ?, ?)");
    for (const pkg of added) {
      insert.run(deviceId, pkg, now, who.kind, who.kind === "server" ? null : who.parentId, who.kind === "ai" ? who.clientName : null);
    }
    const drop = db.prepare("DELETE FROM wifi_only_apps WHERE device_id = ? AND package = ?");
    for (const pkg of removed) drop.run(deviceId, pkg);
    const labels = (pkgs: string[]) =>
      pkgs.map((pkg) => db.prepare<[string, string], { label: string }>("SELECT label FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg)?.label ?? pkg);
    const proposal = opts.proposalId ? { proposal: opts.proposalId } : {};
    if (added.length) log("mobile_data.wifi_only_added", { packages: added, apps: labels(added), ...proposal });
    if (removed.length) log("mobile_data.wifi_only_removed", { packages: removed, apps: labels(removed), ...proposal });
    return { added, removed };
  });
}
