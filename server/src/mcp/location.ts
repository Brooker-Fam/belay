/**
 * Phase 4 over MCP (docs/design/phase4-location.md, "MCP"): get_location, locate_now and
 * get_place_events, all under the `location` scope, which is off for every family until a parent
 * turns it on. While it's off, an AI app sees that a phone has location on (get_policy says so),
 * never a fix or a place event. No tool changes the mode, the places, keep_on or lost mode: those
 * are a parent's, on the parent page. The places' names are the family's words: they're under
 * `untrusted`, and so is every sentence that holds one. Every call is in the activity log; a check
 * is a command the kid's phone shows a notice for, naming the AI app.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { type DeviceRow, findDeviceByName, listDevices } from "../family/devices.js";
import { locateNow } from "../family/location/changes.js";
import { describeFix, distanceWords } from "../family/location/describe.js";
import { checkAnswer, latestFix, listPlaceEvents } from "../family/location/fixes.js";
import { type FixView, type LocationSettings, listPlaces, locationSettings } from "../family/location/store.js";
import { type Changer, type PolicyContext, RuleRefused } from "../family/policy.js";
import { AI_PER_HOUR } from "../ratelimit.js";
import { AI_SCOPES, getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { durations, formatAgo, isoInZone, parseWhen } from "../time.js";
import { aiCounted, aiLimited } from "./limits.js";
import type { Caller } from "./server.js";

const READ = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

const result = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const refusal = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const deviceParam = z.string().min(1).max(100).describe("The phone's name, as list_devices shows it");

/** The most days get_place_events reads at once. */
const MAX_DAYS = 92;

const REASON_WORDS: Record<FixView["reason"], string> = {
  on_demand: "a check: a parent (or you) asked where the phone is",
  periodic: "shared on the schedule the parents set",
  place: "shared on the schedule, sooner because the phone was near the edge of a place",
  lost: "lost mode: the phone shares where it is every 5 minutes",
  help: "the kid shared it with \"I need help\"",
};

/** The mode in words, for any AI app: whether a phone has location on is never hidden. */
export function locationWords(s: LocationSettings | null): string {
  if (!s || s.mode === "off") return s?.lost ? "off, but the phone is in lost mode" : "off: Belay doesn't share where the phone is";
  const lost = s.lost ? "; the phone is in lost mode" : "";
  if (s.mode === "on_demand") return `on demand: Belay shares where the phone is only when a parent checks${lost}`;
  const hours = s.hours ? `, from ${s.hours.start} to ${s.hours.end} in the phone's time` : "";
  return `every ${s.everyMinutes} minutes${hours}, with arrivals and departures for the family's places${lost}`;
}

export function registerLocationTools(server: McpServer, deps: Deps, caller: Caller): void {
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
  const iso = (ms: number | null | undefined) => (ms == null ? null : isoInZone(ms, tz()));
  const scopeOff = (): CallToolResult | null =>
    getSettings(db).aiScopes.location
      ? null
      : refusal(
          `A parent turned off AI access to location in Belay's settings (it starts off), so this isn't available. You can still see whether a phone has location on, with get_policy. To change it, a parent ticks "${AI_SCOPES.location.split(":")[0] ?? "Location"}" in Settings.`,
        );
  const logRead = (what: string, deviceId: string) => {
    audit(db, deps.now(), ai, "ai.read", { deviceId, detail: { what } });
  };
  const phone = (name: string): DeviceRow | CallToolResult => {
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), deps.now()).map((d) => d.name);
    return refusal(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };
  const isRefusal = (v: DeviceRow | CallToolResult): v is CallToolResult => "content" in v;

  /** One fix: when, how old, how accurate, where relative to the family's places (their names untrusted), and the coordinates. */
  const fixEntry = (deviceId: string, fix: FixView) => {
    const now = deps.now();
    const places = listPlaces(db, deviceId);
    const { where, words } = describeFix(fix, places);
    return {
      at: iso(fix.at),
      age: formatAgo(fix.at, now),
      why: REASON_WORDS[fix.reason],
      accuracy_m: fix.accuracyM,
      coordinates: { lat: fix.lat, lng: fix.lng },
      provider: fix.provider === "gps" ? "the phone's GPS" : "Android's combined provider (Google's on a Pixel)",
      ...(fix.mock ? { mock: "Android says an app made this location up: it may not be where the phone is." } : {}),
      ...(where.relation === "none"
        ? { places: "The family hasn't named any places for this phone, so there's nothing to describe it by." }
        : {
            place: where.relation === "at" ? "inside" : "outside every place; nearest",
            ...(where.relation === "from" ? { distance_from_its_center: distanceWords(where.distanceM) } : {}),
            untrusted: { place: where.place.name, ...(words ? { description: words } : {}) },
          }),
    };
  };

  server.registerTool(
    "get_location",
    {
      title: "Where the phone is",
      description:
        "The latest fix a phone sent: when and how long ago, how accurate, where it is relative to the family's places (inside one, or how far from the nearest), and its coordinates. Needs the Location category, which is off until a parent turns it on. It doesn't ask the phone for a new fix: locate_now does.",
      inputSchema: { device: deviceParam },
      annotations: READ,
    },
    ({ device }) => {
      const off = scopeOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      const s = locationSettings(db, row.id);
      const fix = latestFix(db, row.id);
      logRead("where the phone is", row.id);
      return result({
        phone: row.name,
        location: locationWords(s),
        latest: fix ? fixEntry(row.id, fix) : null,
        ...(fix ? {} : { note: s && s.mode !== "off" ? "The phone hasn't sent a fix that Belay keeps yet." : "Belay has no fix for this phone." }),
        ...(s?.lost ? { lost_mode: { since: iso(s.lost.since), untrusted: { lock_screen_message: s.lost.message, ...(s.lost.number ? { number: s.lost.number } : {}) } } } : {}),
        reminder: "Only a parent changes whether and how the phone shares where it is, its places and lost mode, on the parent page. Where a kid is is private: share it only with the parent who asked.",
      });
    },
  );

  server.registerTool(
    "locate_now",
    {
      title: "Check where the phone is now",
      description:
        `Asks a phone for a fresh fix and waits up to a minute for it. Only while the phone shares where it is when a parent checks (on demand) or periodically, and only with the Location category on. The kid's phone shows a notice for every check, naming you ("Your parent checked where this phone is, using …"), and the activity log has it. Use it only when the parent asks. At most ${AI_PER_HOUR.checks} checks an hour per phone through this connection: past that it says when to try again (get_location still shows the latest fix).`,
      inputSchema: { device: deviceParam },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    async ({ device }, extra) => {
      const off = scopeOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      if (row.revoked_at !== null) return refusal(`${row.name} is disconnected, so it can't answer.`);
      const s = locationSettings(db, row.id);
      if (!s || s.mode === "off") {
        return refusal(`Location is off for ${row.name}, so it doesn't answer a check. Only a parent turns it on, on the phone's Location page; you can't, and can't propose it.`);
      }
      const limited = aiLimited(deps, caller, "locate_now", row);
      if (limited) return limited;
      let command: string;
      try {
        command = locateNow(ctx(), row.id, ai).result.command;
      } catch (error) {
        if (error instanceof RuleRefused) return refusal(error.message);
        throw error;
      }
      // Counted as soon as the check is sent, before waiting for its fix: the kid's phone shows it either way.
      aiCounted(deps, caller, "locate_now", row.id);
      const answered = await deps.fixWaiters.wait(row.id, () => checkAnswer(db, row.id, command) !== null, deps.locateWaitMs, extra.signal);
      const fix = answered ? checkAnswer(db, row.id, command) : null;
      const via = oneLine(caller.clientName, 60) || "an AI app";
      const notice = `The kid's phone shows: "Your parent checked where this phone is, using ${via}."`;
      if (!fix) {
        return result({
          phone: row.name,
          asked: iso(deps.now()),
          answer: `No fix yet: the phone hasn't answered within ${Math.round(deps.locateWaitMs / 1000)} seconds. It may be offline, or GPS needs longer indoors. The check stays open for 2 minutes; get_location shows the fix if it comes.`,
          kid_notice: notice,
        });
      }
      logRead("where the phone is (a check)", row.id);
      return result({ phone: row.name, answer: "The phone answered.", fix: fixEntry(row.id, fix), kid_notice: notice });
    },
  );

  server.registerTool(
    "get_place_events",
    {
      title: "Arrivals and departures",
      description:
        "When a phone arrived at or left the family's places, newest first (only while it shares where it is periodically). Times may be a date (2026-11-10, midnight in the family's timezone) or a date and time; the last 7 days by default, at most 92. Needs the Location category.",
      inputSchema: {
        device: deviceParam,
        from: z.string().max(40).optional().describe("Start, like 2026-11-10 or 2026-11-10T15:00. Default: 7 days ago."),
        to: z.string().max(40).optional().describe("End (exclusive). Default: now."),
      },
      annotations: READ,
    },
    ({ device, from, to }) => {
      const off = scopeOff();
      if (off) return off;
      const row = phone(device);
      if (isRefusal(row)) return row;
      const zone = tz();
      const now = deps.now();
      const start = from ? parseWhen(from, zone) : now - 7 * durations.DAY;
      const end = to ? parseWhen(to, zone) : now;
      if (start === null) return refusal("from must be a date like 2026-11-10 or a date and time like 2026-11-10T15:00.");
      if (end === null) return refusal("to must be a date like 2026-11-10 or a date and time like 2026-11-10T15:00.");
      if (end <= start) return refusal("to must be after from.");
      if (end - start > MAX_DAYS * durations.DAY) return refusal(`Ask for at most ${MAX_DAYS} days at a time.`);
      const events = listPlaceEvents(db, row.id, { from: start, to: end, limit: 500 });
      logRead(`arrivals and departures from ${iso(start) ?? ""} to ${iso(end) ?? ""}`, row.id);
      const s = locationSettings(db, row.id);
      return result({
        phone: row.name,
        from: iso(start),
        to: iso(end),
        location: locationWords(s),
        events: events.map((e) => ({ when: iso(e.at), event: e.kind === "arrived" ? "arrived" : "left", untrusted: { place: e.placeName } })),
        ...(events.length === 0 ? { note: s?.mode === "periodic" ? "No arrivals or departures in that time." : "Arrivals and departures need the phone to share where it is periodically." } : {}),
      });
    },
  );
}
