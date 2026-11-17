/**
 * Telling the parents about the server, with Phase 2's Web Push (push.ts: end-to-end encrypted
 * to each parent's own browser):
 *
 * - An urgent problem (no backup for 2 days, the disk under 5% free): to every parent's
 *   browsers at once, then at most once a day while it lasts. A push service that fails is
 *   tried again an hour later.
 * - The daily summary, off by default: each parent turns it on for themselves in Settings, at
 *   the family's hour (7 PM by default). It says how many things need them and what kind, in
 *   plain words: counts only, never a phone's or an app's name or anything the kid wrote.
 *
 * A restore drill's scratch copy sends neither.
 */
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import { type DeviceView, type Problem, listDevices } from "../family/devices.js";
import { pendingProposalCount } from "../family/proposals.js";
import { pendingRequestCount, unseenHelp } from "../family/requests.js";
import { type Notice, sendNotice } from "../push.js";
import { getSettings } from "../settings.js";
import { dayKey, durations, formatDuration, zoned } from "../time.js";
import type { ServerProblem, ServerProblemCode } from "./health.js";
import { drillCopy } from "./verify.js";

const { HOUR, DAY } = durations;

function readJson(db: DB, key: string): unknown {
  const row = db.prepare<[string], { value: string }>("SELECT value FROM settings WHERE key = ?").get(key);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value) as unknown;
  } catch {
    return undefined;
  }
}

function writeJson(db: DB, key: string, value: unknown): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value").run(key, JSON.stringify(value));
}

// ── Urgent problems ─────────────────────────────────────────────────────

const ALERTS_KEY = "ops_alerts";

type AlertState = Partial<Record<ServerProblemCode, { sentAt?: number; failedAt?: number }>>;

export function urgentNotice(problem: ServerProblem): Notice {
  return { title: "Belay", body: `The server needs you: ${problem.short}.`, url: "/" };
}

/** Pushes each urgent problem to every parent's browsers, at most once a day per problem. Returns those sent. */
export async function sendUrgentNotices(deps: Deps, problems: ServerProblem[]): Promise<ServerProblemCode[]> {
  const { db } = deps;
  if (drillCopy(db)) return [];
  const urgent = problems.filter((p) => p.urgent);
  if (!urgent.length) return [];
  const raw = readJson(db, ALERTS_KEY);
  const state: AlertState = raw && typeof raw === "object" ? raw : {};
  const within = (at: number | undefined, span: number, now: number) => at !== undefined && now >= at && now - at < span;
  const sent: ServerProblemCode[] = [];
  for (const problem of urgent) {
    const now = deps.now();
    const s = state[problem.code] ?? {};
    if (within(s.sentAt, DAY, now) || within(s.failedAt, HOUR, now)) continue;
    const result = await sendNotice(deps, urgentNotice(problem));
    // Nobody to tell yet: ask again next time, so a browser turned on later still hears today.
    if (result.sent > 0) {
      state[problem.code] = { sentAt: now };
      sent.push(problem.code);
      deps.log(`Told the parents: ${problem.short}.`);
    } else if (result.failed > 0) {
      state[problem.code] = { ...s, failedAt: now };
    }
  }
  writeJson(db, ALERTS_KEY, state);
  return sent;
}

// ── The daily summary ───────────────────────────────────────────────────

const DIGEST_KEY = "digest";
const DIGEST_SENT_KEY = "digest_sent";

export interface DigestSettings {
  /** The family's hour, 0 to 23, in its timezone. */
  hour: number;
  /** The parents who get it. */
  parents: string[];
}

export const DEFAULT_DIGEST: DigestSettings = { hour: 19, parents: [] };

export function getDigest(db: DB): DigestSettings {
  const raw = readJson(db, DIGEST_KEY) as Partial<DigestSettings> | undefined;
  const hour = typeof raw?.hour === "number" && Number.isInteger(raw.hour) && raw.hour >= 0 && raw.hour <= 23 ? raw.hour : DEFAULT_DIGEST.hour;
  const wanted = new Set(Array.isArray(raw?.parents) ? raw.parents.filter((p): p is string => typeof p === "string") : []);
  // A parent who was removed gets nothing.
  const parents = db
    .prepare<[], { id: string }>("SELECT id FROM parents ORDER BY created_at")
    .all()
    .map((p) => p.id)
    .filter((id) => wanted.has(id));
  return { hour, parents };
}

/** Turns the summary on or off for one parent, and sets the family's hour. */
export function setDigest(db: DB, parentId: string, on: boolean, hour: number): DigestSettings {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Not an hour: ${hour}`);
  const current = getDigest(db);
  const parents = on ? [...new Set([...current.parents, parentId])] : current.parents.filter((p) => p !== parentId);
  writeJson(db, DIGEST_KEY, { hour, parents });
  return getDigest(db);
}

const a = (n: number) => (n === 1 ? "a phone" : `${n} phones`);
const has = (n: number) => (n === 1 ? "has" : "have");
const its = (n: number) => (n === 1 ? "its" : "their");

/** What each kind of phone problem is in the summary, for `n` phones. A kind not listed here still counts, in general words. */
const PHONE_WORDS: Partial<Record<Problem["code"], (n: number, longestSilence: number) => string>> = {
  tampering: (n) => `someone may be getting around Belay on ${a(n)}`,
  not_device_owner: (n) => `Belay is no longer the device owner on ${a(n)}`,
  uninstall_allowed: (n) => `Belay can be uninstalled on ${a(n)}`,
  silent: (n, longest) => `${a(n)} ${has(n)} been silent ${n === 1 ? "" : "up to "}${formatDuration(longest)}`,
  service_stopped: (n) => `Belay's background service stopped on ${a(n)}`,
  usage_access_off: (n) => `usage access for Belay is off on ${a(n)}`,
  screen_time_unmeasured: (n) => `Belay can't count screen time on ${a(n)}: usage access is off`,
  battery_optimized: (n) => `battery optimization is on for Belay on ${a(n)}`,
  notifications_off: (n) => `Belay's notifications are off on ${a(n)}`,
  background_restricted: (n) => `background use is restricted for Belay on ${a(n)}`,
  permission_missing: (n) => `Belay is missing a permission on ${a(n)}`,
  clock_off: (n) => (n === 1 ? "a phone's clock is off" : `${n} phones' clocks are off`),
  no_app_list: (n) => `${a(n)} ${n === 1 ? "hasn't" : "haven't"} sent ${its(n)} app list`,
  rules_not_applied: (n) => `${a(n)} ${n === 1 ? "hasn't" : "haven't"} applied ${its(n)} rules`,
  phone_reported: (n) => `Belay on ${a(n)} reported a problem`,
  signing_changed: (n) => `Belay on ${a(n)} is signed with a different key`,
  update_failed: (n) => `Belay couldn't update on ${a(n)}`,
  update_silent: (n) => `${a(n)} went quiet after updating Belay`,
  recovery_used: (n) => `the recovery key was used on ${a(n)}: make a new one`,
  other_users: (n) => `another user or profile is on ${a(n)}`,
  location_permission: (n) => `Belay is missing location permission on ${a(n)}`,
  location_off: (n) => `location is turned off on ${a(n)}`,
  calls_not_dialer: (n) => `calls are going through the phone's own app on ${a(n)}`,
};

const PHONE_ORDER: Problem["code"][] = [
  "other_users",
  "signing_changed",
  "recovery_used",
  "not_device_owner",
  "uninstall_allowed",
  "update_silent",
  "silent",
  "update_failed",
  "rules_not_applied",
  "service_stopped",
  "permission_missing",
  "location_permission",
  "location_off",
  "calls_not_dialer",
  "screen_time_unmeasured",
  "usage_access_off",
  "notifications_off",
  "battery_optimized",
  "background_restricted",
  "no_app_list",
  "clock_off",
  "phone_reported",
];

/**
 * What needs the parents, as short phrases: phones' problems by kind, requests and proposals
 * waiting, and the server's problems. Counts and kinds only.
 */
export function digestItems(input: { phones: DeviceView[]; requests: number; proposals: number; server: ServerProblem[]; now: number; help?: number }): string[] {
  const kinds = new Map<Problem["code"], { n: number; silence: number }>();
  for (const phone of input.phones) {
    if (phone.revokedAt !== null) continue;
    for (const code of new Set(phone.problems.map((p) => p.code))) {
      const entry = kinds.get(code) ?? { n: 0, silence: 0 };
      entry.n++;
      if (code === "silent") entry.silence = Math.max(entry.silence, input.now - (phone.lastSeenAt ?? phone.enrolledAt));
      kinds.set(code, entry);
    }
  }
  kinds.delete("disconnected");
  const phone = (code: Problem["code"]) => {
    const entry = kinds.get(code);
    if (!entry) return [];
    const words = PHONE_WORDS[code];
    return [words ? words(entry.n, entry.silence) : `${a(entry.n)} ${entry.n === 1 ? "needs" : "need"} attention`];
  };
  const rest = [...kinds.keys()].filter((code) => code !== "tampering" && !PHONE_ORDER.includes(code));
  const help = input.help ?? 0;
  // Help requests are counted in `requests` too: said first, and not twice.
  const otherRequests = input.requests - help;
  return [
    ...(help ? [help === 1 ? "a help request hasn't been seen" : `${help} help requests haven't been seen`] : []),
    ...phone("tampering"),
    ...input.server.filter((p) => p.urgent).map((p) => p.short),
    ...[...PHONE_ORDER, ...rest].flatMap(phone),
    ...(otherRequests > 0 ? [otherRequests === 1 ? "a request is waiting" : `${otherRequests} requests are waiting`] : []),
    ...(input.proposals ? [input.proposals === 1 ? "an AI app's proposal is waiting" : `${input.proposals} AI apps' proposals are waiting`] : []),
    ...input.server.filter((p) => !p.urgent).map((p) => p.short),
  ];
}

const MAX_BODY = 300;

export function digestNotice(items: string[], phones: number): Notice {
  if (!items.length) {
    const ok = phones === 0 ? "" : phones === 1 ? " The phone is OK." : ` All ${phones} phones are OK.`;
    return { title: "Belay: today", body: `Nothing needs you today.${ok}`, url: "/" };
  }
  const head = `${items.length === 1 ? "1 thing needs" : `${items.length} things need`} you: `;
  let shown = items.length;
  const body = (n: number) => `${head}${items.slice(0, n).join(", ")}${n < items.length ? `, and ${items.length - n} more` : ""}.`;
  while (shown > 1 && body(shown).length > MAX_BODY) shown--;
  return { title: "Belay: today", body: body(shown), url: "/" };
}

/**
 * Sends the daily summary to the parents who turned it on, during the family's hour, once a
 * day. A server that's down for that hour skips the day rather than sending it late.
 * Returns how many parents' browsers it reached.
 */
export async function sendDigestIfDue(deps: Deps, server: ServerProblem[]): Promise<number> {
  const { db } = deps;
  if (drillCopy(db)) return 0;
  const digest = getDigest(db);
  if (!digest.parents.length) return 0;
  const now = deps.now();
  const settings = getSettings(db);
  if (zoned(now, settings.timezone).hour !== digest.hour) return 0;
  const today = dayKey(now, settings.timezone);
  if (readJson(db, DIGEST_SENT_KEY) === today) return 0;
  // Marked first: a crash halfway never sends it twice.
  writeJson(db, DIGEST_SENT_KEY, today);
  const phones = listDevices(db, settings, now).filter((p) => p.revokedAt === null);
  const notice = digestNotice(digestItems({ phones, requests: pendingRequestCount(db), help: unseenHelp(db).length, proposals: pendingProposalCount(db), server, now }), phones.length);
  let reached = 0;
  for (const parentId of digest.parents) {
    if ((await sendNotice(deps, notice, { parentId })).sent > 0) reached++;
  }
  return reached;
}
