/**
 * Phase 3's network logging over MCP (docs/design/phase3-screen-time.md, "MCP"): get_network_activity,
 * which websites and online services each app on a phone looked up, by name, per day, under the
 * `network` scope, which is off for every family until a parent turns it on. Domains and app names
 * are their developers' words: they sit under `untrusted`. No tool turns network logging on or
 * off, and none proposes it: collecting is a parent's choice alone. Every read is in the activity
 * log.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { type DeviceRow, deviceFacts, findDeviceByName, listDevices } from "../family/devices.js";
import { networkDays, networkSettings } from "../family/network/store.js";
import type { Changer } from "../family/policy.js";
import { addDays, dateIn, validDay, weekdayOf } from "../family/screentime/days.js";
import { phoneLabels } from "../family/screentime/rules.js";
import { AI_SCOPES, getSettings } from "../settings.js";
import { isValidTimeZone, isoInZone } from "../time.js";
import type { Caller } from "./server.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const deviceParam = z.string().min(1).max(100).describe("The phone's name, as list_devices shows it");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day like 2026-11-16");
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;

/** The most days one call reads, apps a day it lists, and domains an app. */
const MAX_DAYS = 31;
const MAX_APPS = 30;
const MAX_DOMAINS = 25;

export const NETWORK_REMINDER =
  "A lookup is a fact about an app, not a verdict about the kid: apps look names up by themselves, for ads, updates and their own services, and a name looked up isn't a page visited. Report it plainly, don't guess why, and never speculate about the kid's private life from it.";

export function registerNetworkTools(server: McpServer, deps: Deps, caller: Caller): void {
  const { db } = deps;
  const ai: Changer = { kind: "ai", parentId: caller.parentId, clientName: caller.clientName };
  const tz = () => getSettings(db).timezone;
  const iso = (ms: number) => isoInZone(ms, tz());
  const scopeOff = (): CallToolResult | null =>
    getSettings(db).aiScopes.network
      ? null
      : refusal(
          `A parent turned off AI access to network activity in Belay's settings (it starts off), so this isn't available. To change it, a parent ticks "${AI_SCOPES.network.split(":")[0] ?? "Network"}" in Settings.`,
        );
  const phone = (name: string): DeviceRow | CallToolResult => {
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), deps.now()).map((d) => d.name);
    return refusal(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };
  const isRefusal = (v: DeviceRow | CallToolResult): v is CallToolResult => "content" in v;

  server.registerTool(
    "get_network_activity",
    {
      title: "Network activity",
      description:
        "Which websites and online services each app on one phone looked up, by name (like example.com), and how many times, day by day in the phone's own days: never the pages, messages, searches or anything typed, never what the phone app, texting app and the other apps that always work looked up, and never 988's websites. Only while a parent has network logging on for the phone. The last 7 days by default, at most 31. Needs the Network category, which is off until a parent turns it on.",
      inputSchema: {
        device: deviceParam,
        from: day.optional().describe("The first day, like 2026-11-10. Default: 6 days before `to`."),
        to: day.optional().describe("The last day, included. Default: today on the phone."),
      },
      annotations: READ,
    },
    ({ device, from, to }) => {
      const off = scopeOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      const now = deps.now();
      const facts = deviceFacts(db, row.id);
      const zone = facts?.timezone && isValidTimeZone(facts.timezone) ? facts.timezone : tz();
      const last = to ?? dateIn(now, zone);
      const first = from ?? addDays(last, -6);
      if (!validDay(first) || !validDay(last)) return refusal("from and to must be days that exist, like 2026-11-10.");
      if (first > last) return refusal("from must be on or before to.");
      if (first < addDays(last, -(MAX_DAYS - 1))) return refusal(`Ask for at most ${MAX_DAYS} days at a time.`);
      audit(db, now, ai, "ai.read", { deviceId: row.id, detail: { what: `network activity from ${first} to ${last}` } });
      const s = networkSettings(db, row.id);
      const report = facts?.enforcement?.network_log ?? null;
      const label = phoneLabels(db, row.id);
      const sent = new Map(networkDays(db, row.id, { from: first, to: last }).map((d) => [d.day, d]));
      const days: unknown[] = [];
      for (let d = last; d >= first; d = addDays(d, -1)) {
        const n = sent.get(d);
        if (!n) {
          days.push({ day: d, weekday: DAY_NAMES[weekdayOf(d)], not_sent: "Belay sent nothing for this day: unknown, not none" });
          continue;
        }
        const byApp = new Map<string, { package: string; lookups: number; domains: { domain: string; lookups: number }[] }>();
        for (const e of n.entries) {
          const app = byApp.get(e.package) ?? { package: e.package, lookups: 0, domains: [] };
          app.lookups += e.lookups;
          app.domains.push({ domain: e.domain, lookups: e.lookups });
          byApp.set(e.package, app);
        }
        const apps = [...byApp.values()].sort((a, b) => b.lookups - a.lookups || (a.package < b.package ? -1 : 1));
        const restApps = apps.slice(MAX_APPS);
        days.push({
          day: n.day,
          weekday: DAY_NAMES[weekdayOf(n.day)],
          ...(n.zone !== zone ? (isValidTimeZone(n.zone) ? { counted_in: n.zone } : { untrusted: { counted_in: n.zone } }) : {}),
          counted_until: iso(n.asOf),
          apps: apps.slice(0, MAX_APPS).map((a) => {
            const restDomains = a.domains.slice(MAX_DOMAINS);
            return {
              lookups: a.lookups,
              untrusted: { label: label(a.package), package: a.package },
              domains: a.domains.slice(0, MAX_DOMAINS).map((x) => ({ lookups: x.lookups, untrusted: { domain: x.domain } })),
              ...(restDomains.length ? { other_domains: { count: restDomains.length, lookups: restDomains.reduce((sum, x) => sum + x.lookups, 0) } } : {}),
            };
          }),
          ...(restApps.length ? { other_apps: { count: restApps.length, lookups: restApps.reduce((sum, a) => sum + a.lookups, 0) } } : {}),
          ...(n.dropped > 0 ? { left_out_by_the_phone: `${n.dropped} more app and domain pairs, each looked up less than these` } : {}),
        });
      }
      return result({
        phone: row.name,
        from: first,
        to: last,
        days_follow: `the phone's own time zone (${zone})`,
        network_logging: !s?.enabled
          ? "off: the phone notes nothing now, so newer days aren't here. Only a parent turns it on."
          : report?.paused
            ? "on, but Android paused it: another user or profile is on the phone, so the phone notes nothing until it's gone."
            : "on",
        kept_for: `${getSettings(db).networkDays} days`,
        days,
        reminder: NETWORK_REMINDER,
      });
    },
  );
}
