/**
 * Phase 3's network logging changes, through family/policy.ts's changePolicy: one transaction, the
 * activity log, and a new policy version for the phone. Each is a parent's decision: the parent
 * page, or the server's CLI acting as one. An AI app can't make one, in either direction, and
 * can't propose one either:
 * - the switch: more collection is a privacy choice, not a safety tightening;
 * - the private websites: they decide what's never collected, like a helpline's site the kid may
 *   use, and an AI app never sees which they are, or whether there are any.
 */
import { LIMITS } from "../../device/schemas.js";
import { type Changed, type Person, type PolicyContext, RuleRefused, changePolicy } from "../policy.js";
import { typedWebsite } from "./domains.js";
import { networkSettings, privateDomainsOf } from "./store.js";

/** The types already say so; these keep it true at run time too. */
function onlyPeople(who: Person, what: string): void {
  if ((who as { kind: string }).kind === "ai") throw new Error(`Only a parent ${what}: an AI app can't, and can't propose it`);
}

/** Turns the phone's network logging on or off. `already`: it was that way, and nothing changed. */
export function setNetworkLog(ctx: PolicyContext, deviceId: string, on: boolean, who: Person): Changed<{ already: boolean }> {
  onlyPeople(who, "turns network logging on or off");
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

/**
 * Makes a website private on the phone (`on`), or takes it off the private websites: Belay never
 * keeps a lookup of a private website or of a name under it, like 988's, on the phone or here, and
 * the phone's "What your parent can see" says some websites are never noted, never which. What the
 * parent typed (a name or a link) becomes the registrable domain the phone keeps (domains.ts), so
 * "www.example.org/help" makes all of example.org private; `domain` says which. Making one private
 * deletes what the server kept of it. At most 100 a phone. The activity log counts, and never names
 * one, as for private numbers. `already`: it was that way, and nothing changed.
 */
export function setPrivateWebsite(ctx: PolicyContext, deviceId: string, input: string, on: boolean, who: Person): Changed<{ domain: string; already: boolean }> {
  onlyPeople(who, "chooses the private websites");
  const typed = typedWebsite(input);
  // A name that can't be private never was: taking it off changes nothing.
  if ("problem" in typed && on) throw new RuleRefused(typed.problem);
  const domain = "domain" in typed ? typed.domain : null;
  return changePolicy(ctx, deviceId, who, (log) => {
    const { db, now } = ctx;
    if (domain === null) return { domain: input.trim(), already: true };
    const list = privateDomainsOf(db, deviceId);
    if (list.includes(domain) === on) return { domain, already: true };
    if (on) {
      if (list.length >= LIMITS.maxPrivateDomains) throw new RuleRefused(`A phone can have at most ${LIMITS.maxPrivateDomains} private websites.`);
      db.prepare("INSERT INTO network_private_domains (device_id, domain, added_at, added_by) VALUES (?, ?, ?, ?)").run(
        deviceId,
        domain,
        now,
        who.kind === "parent" ? who.parentId : null,
      );
      // Never kept, from before either: what the server kept of it, and of the names under it, goes.
      db.prepare("DELETE FROM network_lookups WHERE device_id = ? AND (domain = ? OR substr(domain, ?) = ?)").run(deviceId, domain, -(domain.length + 1), `.${domain}`);
    } else {
      db.prepare("DELETE FROM network_private_domains WHERE device_id = ? AND domain = ?").run(deviceId, domain);
    }
    log(on ? "network.private_added" : "network.private_removed", { count: 1 });
    return { domain, already: false };
  });
}
