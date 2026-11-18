/**
 * Phase 13's mobile data over MCP (docs/design/phase13-mobile-data.md, "MCP"): get_mobile_data,
 * how much mobile data each app on a phone used, day by day, with the day's Wi-Fi total, under the
 * `mobile_data` scope (on by default, like screen time); and change_wifi_only, which makes apps
 * Wi-Fi only at once (it only tightens) and turns anything that lets an app use mobile data again
 * into a proposal for a parent. Package names and app names are their developers' words: they sit
 * under `untrusted`, and the apps' names need the Apps scope too, as in get_screen_time. No tool
 * turns measuring on or off, and none proposes it: collecting is a parent's choice alone. Every
 * read and change is in the activity log.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { packageName } from "../device/schemas.js";
import { type DeviceRow, deviceFacts, findDeviceByName, listDevices } from "../family/devices.js";
import { changeWifiOnly, cleanPatch, wifiOnlyRefusal } from "../family/mobiledata/changes.js";
import { bytesInWords, mobileDataDays, mobileDataSettings, wifiOnlyApps } from "../family/mobiledata/store.js";
import { wifiOnlyWords } from "../family/mobiledata/words.js";
import { type Changer, type PolicyContext, RuleRefused, neverBlockedOn } from "../family/policy.js";
import { MAX_PENDING_PROPOSALS, changeWords, createProposal, listProposals, nothingToLoosen } from "../family/proposals.js";
import { addDays, at, dateIn, validDay, weekdayOf } from "../family/screentime/days.js";
import { phoneLabels } from "../family/screentime/rules.js";
import { notifyParents, proposalNotice } from "../push.js";
import { AI_SCOPES, getSettings } from "../settings.js";
import { isValidTimeZone, isoInZone } from "../time.js";
import type { Caller } from "./server.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
const TIGHTEN = { readOnlyHint: false, destructiveHint: true, openWorldHint: false } as const;

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const deviceParam = z.string().min(1).max(100).describe("The phone's name, as list_devices shows it");
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "a day like 2026-11-16");
const DAY_NAMES = { mon: "Monday", tue: "Tuesday", wed: "Wednesday", thu: "Thursday", fri: "Friday", sat: "Saturday", sun: "Sunday" } as const;

/** The most days one call reads, and apps a day it lists. */
const MAX_DAYS = 31;
const MAX_APPS = 10;

export const MOBILE_DATA_REMINDER =
  "Mobile data use is a number, not a verdict about the kid: apps use data by themselves too, for updates, ads and syncing. Report it plainly and don't guess why. The phone app, texting and Android's own parts are counted together, never one by one, so read nothing into a call or a text. Making an app Wi-Fi only is a suggestion for the parent; Maps and the browser help a kid who's lost or needs 988's chat, so think twice before suggesting them.";

/** "350 MB" with its bytes, for a line of a day. */
const amount = (bytes: number) => ({ bytes, words: bytesInWords(bytes) });

export function registerMobileDataTools(server: McpServer, deps: Deps, caller: Caller): void {
  const { db } = deps;
  const ai: Changer = { kind: "ai", parentId: caller.parentId, clientName: caller.clientName };
  const ctx = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });
  const tz = () => getSettings(db).timezone;
  const iso = (ms: number) => isoInZone(ms, tz());
  const scopeOff = (): CallToolResult | null =>
    getSettings(db).aiScopes.mobile_data
      ? null
      : refusal(`A parent turned off AI access to mobile data use in Belay's settings, so this isn't available. To change it, a parent ticks "${AI_SCOPES.mobile_data.split(":")[0] ?? "Mobile data"}" in Settings.`);
  /** The Apps category, as block_app asks for it (mcp/server.ts's scopeOff("apps")), in its words. */
  const appsOff = (): CallToolResult | null =>
    getSettings(db).aiScopes.apps ? null : refusal(`A parent turned off AI access to ${AI_SCOPES.apps.split(":")[0]?.toLowerCase() ?? "apps"} in Belay's settings, so this isn't available.`);
  const phone = (name: string): DeviceRow | CallToolResult => {
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), deps.now()).map((d) => d.name);
    return refusal(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };
  const isRefusal = (v: DeviceRow | CallToolResult): v is CallToolResult => "content" in v;
  const parentsPage = (path: string) => `${deps.config.publicUrl}${path}`;

  // ── get_mobile_data ───────────────────────────────────────────────

  server.registerTool(
    "get_mobile_data",
    {
      title: "Mobile data use",
      description:
        "How much mobile data each app on one phone used, day by day in the phone's days, as Android counts it: each day's mobile data and Wi-Fi totals, the top apps, and Android, calls and texting together (never one by one); never which websites or networks. Only while a parent measures it. With the Wi-Fi-only apps. The last 7 days by default, at most 31. Needs the Mobile data category; app names need Apps too.",
      inputSchema: {
        device: deviceParam,
        from: day.optional().describe("The first day. Default: 6 days before `to`."),
        to: day.optional().describe("The last day. Default: today on the phone."),
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
      audit(db, now, ai, "ai.read", { deviceId: row.id, detail: { what: `mobile data use from ${first} to ${last}` } });
      const settings = getSettings(db);
      const s = mobileDataSettings(db, row.id);
      // The apps' names come from the phone's app list: with the Apps category off, only the package names the phone sent.
      const named = settings.aiScopes.apps;
      const label = phoneLabels(db, row.id);
      const app = (pkg: string) => ({ ...(named ? { label: label(pkg) } : {}), package: pkg });
      const sent = mobileDataDays(db, row.id, { from: first, to: last });
      const byDay = new Map(sent.map((d) => [d.day, d]));
      const days: unknown[] = [];
      const totals = { mobile: 0, wifi: 0, android: 0, removed: 0, hotspot: 0 };
      const perApp = new Map<string, number>();
      for (let d = last; d >= first; d = addDays(d, -1)) {
        const n = byDay.get(d);
        if (!n) {
          days.push({ day: d, weekday: DAY_NAMES[weekdayOf(d)], not_sent: "Belay sent nothing for this day: unknown, not none" });
          continue;
        }
        totals.mobile += n.mobileBytes;
        totals.wifi += n.wifiBytes;
        totals.android += n.androidBytes;
        totals.removed += n.removedBytes;
        totals.hotspot += n.hotspotBytes;
        for (const a of n.apps) perApp.set(a.package, (perApp.get(a.package) ?? 0) + a.bytes);
        const rest = n.apps.slice(MAX_APPS);
        days.push({
          day: n.day,
          weekday: DAY_NAMES[weekdayOf(n.day)],
          ...(n.zone !== zone ? (isValidTimeZone(n.zone) ? { counted_in: n.zone } : { untrusted: { counted_in: n.zone } }) : {}),
          counted: n.complete ? "the whole day" : `until ${iso(n.asOf)}, so far`,
          // Measuring turned on during the day: nothing from before then is counted.
          ...(n.from > at(n.day, 0, isValidTimeZone(n.zone) ? n.zone : zone) + 60_000 ? { counted_from: iso(n.from) } : {}),
          mobile_data: amount(n.mobileBytes),
          wifi: amount(n.wifiBytes),
          apps: n.apps.slice(0, MAX_APPS).map((a) => ({ mobile_data: amount(a.bytes), untrusted: app(a.package) })),
          ...(rest.length ? { other_apps: { count: rest.length, mobile_data: amount(rest.reduce((sum, a) => sum + a.bytes, 0)) } } : {}),
          android_calls_and_texting: amount(n.androidBytes),
          ...(n.removedBytes ? { apps_removed_since: amount(n.removedBytes) } : {}),
          ...(n.hotspotBytes ? { through_this_phones_hotspot: amount(n.hotspotBytes) } : {}),
        });
      }
      const top = [...perApp.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, MAX_APPS);
      const wifiOnly = wifiOnlyApps(db, row.id).map((w) => {
        // Days that started after it was added, from the days read: a download the download manager made, or a phone that didn't apply it yet.
        const after = sent.filter((d) => d.from >= w.addedAt).reduce((sum, d) => sum + (d.apps.find((a) => a.package === w.package)?.bytes ?? 0), 0);
        return {
          added: iso(w.addedAt),
          by: w.addedBy === "ai" ? `${w.clientName ?? "an AI app"} (${w.parentName ?? "a parent"}'s connection)` : w.addedBy === "server" ? "the server's admin command" : (w.parentName ?? "a former parent account"),
          ...(after > 0 ? { used_mobile_data_after: amount(after) } : {}),
          untrusted: app(w.package),
        };
      });
      return result({
        phone: row.name,
        from: first,
        to: last,
        days_follow: `the phone's own time zone (${zone})`,
        measuring: s?.measure
          ? "on: the phone sends each day's use about hourly, and each day once more when it's over"
          : "off: the phone sends nothing now, so newer days aren't here. Only a parent turns it on.",
        kept_for: `${settings.mobileDataDays} days`,
        ...(named ? {} : { app_names: "Hidden: a parent turned off AI access to apps, so each app is the package name the phone sent." }),
        period: {
          days_sent: sent.length,
          mobile_data: amount(totals.mobile),
          wifi: amount(totals.wifi),
          top_apps: top.map(([pkg, bytes]) => ({ mobile_data: amount(bytes), untrusted: app(pkg) })),
          android_calls_and_texting: amount(totals.android),
          ...(totals.removed ? { apps_removed_since: amount(totals.removed) } : {}),
          ...(totals.hotspot ? { through_this_phones_hotspot: amount(totals.hotspot) } : {}),
        },
        days,
        wifi_only: wifiOnly.length
          ? {
              apps: wifiOnly,
              means:
                "Android keeps them off mobile data and any other metered network, like another phone's hotspot. A download an app hands to Android's download manager, and app updates through Play, aren't the app's own traffic: they may still use mobile data.",
            }
          : "none",
        reminder: MOBILE_DATA_REMINDER,
      });
    },
  );

  // ── change_wifi_only ───────────────────────────────────────────────

  server.registerTool(
    "change_wifi_only",
    {
      title: "Change which apps are Wi-Fi only",
      description:
        "Makes apps on one phone Wi-Fi only (add): they can't use mobile data or another metered network, like a phone's hotspot. Adding applies at once: use it only when the parent asks. Removing one is a proposal for a parent. Refused: apps the phone never blocks (calls, texting, the keyboard, the home screen, Android's parts) or never reported. Needs the Apps category.",
      inputSchema: {
        device: deviceParam,
        change: z
          .strictObject({
            add: z.array(packageName).max(100).optional(),
            remove: z.array(packageName).max(100).optional().describe("Let use mobile data again: a proposal"),
          })
          .describe("Package names"),
        reason: z.string().min(1).max(1000).describe("Why, for the parent"),
      },
      annotations: { ...TIGHTEN, idempotentHint: false },
    },
    ({ device, change, reason }) => {
      // First, as block_app: its refusals tell which apps the phone has or had (one it never reported is
      // named) and which are its texting app or dialer, and that's the Apps category's (the seventh review's M1).
      const off = appsOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      if (row.revoked_at !== null) return refusal(`${row.name} is disconnected, so Belay can't change anything on it.`);
      let patch;
      try {
        patch = cleanPatch({ add: change.add ?? [], remove: change.remove ?? [] });
      } catch (error) {
        if (error instanceof RuleRefused) return refusal(error.message);
        throw error;
      }
      if (!patch.add.length && !patch.remove.length) return refusal("Name apps to add or to remove.");
      const now = deps.now();
      // The Apps category is on (above), so what this AI app reads back names the apps.
      const said = phoneLabels(db, row.id);
      const never = neverBlockedOn(db, row.id);
      for (const pkg of patch.add) {
        const refused = wifiOnlyRefusal(db, row.id, pkg, ai, never);
        if (refused) return refusal(refused);
      }
      const current = new Set(wifiOnlyApps(db, row.id).map((w) => w.package));
      const notOn = patch.remove.filter((p) => !current.has(p));
      if (notOn.length) return refusal(`${notOn.join(", ")} ${notOn.length === 1 ? "isn't" : "aren't"} Wi-Fi only on ${row.name}: there's nothing to remove.`);

      if (!patch.remove.length) {
        try {
          const done = changeWifiOnly(ctx(), row.id, patch, ai);
          return result({
            phone: row.name,
            status: done.result.added.length ? "done: it only tightens, so it applies at once" : "nothing changed: those apps were Wi-Fi only already",
            changes: wifiOnlyWords({ add: done.result.added, remove: [] }, said).map((c) => ({ effect: c.effect, untrusted: { change: c.words } })),
            version: done.version,
            what_happens:
              "The phone gets it within seconds if it's online, or as soon as it's back online: Android then keeps the apps off mobile data, and the kid's phone lists them under This phone's rules. An app that isn't installed is kept off once it is.",
            reminder: "Only a parent can let an app use mobile data again, on the parent page. To suggest that, use change_wifi_only with remove: it becomes a proposal.",
          });
        } catch (error) {
          if (error instanceof RuleRefused) return refusal(error.message);
          throw error;
        }
      }
      if (listProposals(db, { deviceId: row.id, status: "pending", limit: MAX_PENDING_PROPOSALS }).length >= MAX_PENDING_PROPOSALS) {
        return refusal(`${MAX_PENDING_PROPOSALS} proposals for ${row.name} are already waiting. Ask the parent to look at them on the Proposals page first.`);
      }
      const proposed = { kind: "mobile_data" as const, patch };
      const nothing = nothingToLoosen(db, row.id, proposed, now);
      if (nothing) return refusal(`Nothing to propose: ${nothing}`);
      const made = createProposal(db, now, row.id, proposed, reason, { parentId: caller.parentId, clientName: caller.clientName });
      const words = changeWords(made.proposal.change, null, phoneLabels(db, row.id));
      if (!made.duplicate && deps.limits.noticesPerPhone.hit(row.id).ok) notifyParents(deps, proposalNotice(row.name, caller.clientName, words.gerund));
      return result({
        phone: row.name,
        status: "proposed: waiting for a parent to approve or reject it",
        why: "Letting an app use mobile data again loosens the phone's rules, so a parent decides.",
        changes: wifiOnlyWords(patch, said).map((c) => ({ effect: c.effect, untrusted: { change: c.words } })),
        ...(made.duplicate ? { note: "The same change was already proposed, and is still waiting." } : {}),
        where: parentsPage("/proposals"),
        reminder: "Nothing has changed yet. Tell the parent it's waiting for them on the Proposals page; don't say it's done.",
      });
    },
  );
}
