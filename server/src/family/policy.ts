/**
 * The rules each phone enforces (docs/protocol.md, "Policy"), as parents, AI apps and the
 * CLI change them. The phone enforces; the server decides what to send.
 *
 * Every change goes through `mutate`, in one transaction: it applies the change, writes the
 * activity log, and bumps the phone's version when what the phone would see changed, then
 * wakes the phone's long-poll. Who may change what is checked here as well as in the
 * callers: an AI app may block an app or pause the phone (never shorter), and nothing else;
 * hardening (factory reset, debugging, reset protection) is only changed by setHardening,
 * which only the parent page calls, after the parent types the phone's name.
 */
import { type Actor, audit } from "../audit.js";
import { newId } from "../crypto.js";
import type { DB } from "../db.js";
import { Policy } from "../device/schemas.js";
import { deviceFacts } from "./devices.js";
import { agreementFor } from "./screentime/agreement.js";
import { insertExtra, phoneDay, phoneRules, screenTimeFor, stageFor } from "./screentime/rules.js";

// ── Names ────────────────────────────────────────────────────────────────

export const RESTRICTIONS = [
  "safe_boot",
  "add_user",
  "unknown_sources",
  "config_vpn",
  "config_private_dns",
  "config_date_time",
  "config_default_apps",
  "modify_accounts",
  "sim",
  "factory_reset",
  "debugging",
] as const;
export type Restriction = (typeof RESTRICTIONS)[number];

/** Turned on with protection: none of them can lock anyone out. */
export const SAFE_RESTRICTIONS = [
  "safe_boot",
  "add_user",
  "unknown_sources",
  "config_vpn",
  "config_private_dns",
  "config_date_time",
  "config_default_apps",
] as const satisfies readonly Restriction[];

/** Each needs something done first: the parent-owned Google account added, the phone's line activated. */
export const LOCK_RESTRICTIONS = ["modify_accounts", "sim"] as const satisfies readonly Restriction[];

/** Can lock a phone for good: only a parent on the parent page turns them on. */
export const HARDENING = ["factory_reset", "debugging"] as const satisfies readonly Restriction[];
export type Hardening = (typeof HARDENING)[number];
export type OrdinaryRestriction = Exclude<Restriction, Hardening>;

export const RESTRICTION_NAMES: Record<Restriction, string> = {
  safe_boot: "Safe mode",
  add_user: "Adding users and guests",
  unknown_sources: "Installing apps from outside the Play Store",
  config_vpn: "VPN settings",
  config_private_dns: "Private DNS settings",
  config_date_time: "Date and time",
  config_default_apps: "Changing default apps",
  modify_accounts: "Adding or removing accounts",
  // DISALLOW_SIM_GLOBALLY stops adding or downloading eSIMs; it doesn't stop a physical SIM swap.
  sim: "Adding or downloading eSIMs",
  factory_reset: "Factory reset",
  debugging: "Developer options and USB debugging",
};

export const DNS_FILTERS = {
  cleanbrowsing: { name: "CleanBrowsing Family", host: "family-filter-dns.cleanbrowsing.org" },
  adguard: { name: "AdGuard Family", host: "family.adguard-dns.com" },
} as const;
export type DnsFilter = keyof typeof DNS_FILTERS;

/** "CleanBrowsing Family" for its host, the host itself for a custom one, null for none. */
export function dnsFilterName(host: string | null): string | null {
  if (!host) return null;
  return Object.values(DNS_FILTERS).find((f) => f.host === host)?.name ?? host;
}

/** A DNS host name (RFC 1123), lower case, with at least one dot. */
export function validHostname(host: string): boolean {
  return (
    host.length <= 253 &&
    host.includes(".") &&
    host.split(".").every((label) => /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) &&
    !/^[0-9.]+$/.test(host)
  );
}

export const ChromeSettings = Policy.shape.web.shape.chrome.unwrap();
export type ChromeSettings = NonNullable<Policy["web"]["chrome"]>;

/** Chrome's safe defaults, the same as the agent's (Protocol.kt). */
export const SAFE_CHROME: ChromeSettings = {
  incognito: false,
  safe_search: true,
  youtube_restrict: "strict",
  safe_sites: true,
  allow_downloads: false,
  url_allowlist: null,
  url_blocklist: [],
};

/** Why the phone never blocks an app. */
type NeverBlockedRole = "belay" | "android" | "calls" | "dialer" | "texting" | "keyboard" | "home" | "emergency" | "system_ui" | "settings";

/**
 * Never blocked, whatever the policy says, so 911 and 988 always work (docs/protocol.md,
 * "Enforcement rules"). The phone works out its own list (the default dialer and texting app,
 * the keyboard, the home screen…) and reports it in `enforcement.never_blocked`; the server
 * refuses to block those, and these well-known ones on any phone, before its first report too.
 */
export const NEVER_BLOCKED: ReadonlyMap<string, NeverBlockedRole> = new Map<string, NeverBlockedRole>([
  ["family.brooker.belay", "belay"],
  ["android", "android"],
  ["com.android.phone", "calls"],
  ["com.android.server.telecom", "calls"],
  ["com.android.providers.telephony", "calls"],
  ["com.google.android.ims", "calls"],
  ["com.shannon.imsservice", "calls"],
  ["com.google.android.dialer", "dialer"],
  ["com.android.dialer", "dialer"],
  ["com.samsung.android.dialer", "dialer"],
  ["com.android.incallui", "dialer"],
  ["com.samsung.android.incallui", "dialer"],
  ["com.google.android.apps.messaging", "texting"],
  ["com.android.messaging", "texting"],
  ["com.android.mms", "texting"],
  ["com.samsung.android.messaging", "texting"],
  ["com.google.android.inputmethod.latin", "keyboard"],
  ["com.android.inputmethod.latin", "keyboard"],
  ["com.samsung.android.honeyboard", "keyboard"],
  ["com.google.android.apps.nexuslauncher", "home"],
  ["com.android.launcher3", "home"],
  ["com.sec.android.app.launcher", "home"],
  ["com.android.emergency", "emergency"],
  ["com.google.android.apps.safetyhub", "emergency"],
  ["com.android.cellbroadcastreceiver", "emergency"],
  ["com.android.cellbroadcastreceiver.module", "emergency"],
  ["com.google.android.cellbroadcastreceiver", "emergency"],
  ["com.android.systemui", "system_ui"],
  ["com.android.settings", "settings"],
]);

const NEVER_BLOCKED_WHY: Record<NeverBlockedRole | "reported", string> = {
  belay: "Belay never blocks itself.",
  android: "The phone never blocks Android itself.",
  calls: "The phone never blocks what places calls and texts: 911 and 988 must always work.",
  dialer: "The phone never blocks its dialer: 911 and 988 must always work.",
  texting: "The phone never blocks its texting app: texting 988 must always work.",
  keyboard: "The phone never blocks its keyboard: texting 988 needs one.",
  home: "The phone never blocks its home screen: it's the way to calls and texts.",
  emergency: "The phone never blocks its emergency and safety apps: 911 and 988 must always work.",
  system_ui: "The phone never blocks System UI: it shows calls and the lock screen.",
  settings: "The phone never blocks Settings.",
  reported: "The phone says it never blocks this app: it's one the phone needs, like its dialer, texting app or keyboard, so 911 and 988 always work.",
};

export const LIMITS = {
  pauseNote: 500,
  supportMessage: 200,
  answerNote: 1000,
  decisionNote: 2000,
  maxPauseMinutes: 7 * 24 * 60,
  maxFrpAccounts: 5,
  maxUrlPatterns: 200,
  urlPattern: 500,
  /**
   * The largest policy the server makes. The phone takes up to 1 MiB; a policy it refused
   * would cut off every later change, a parent's too.
   */
  maxPolicyBytes: 256 * 1024,
  /** Apps blocked or allowed before the phone ever reported them, per phone. */
  maxPreDecisions: 500,
  /** Of those, the most AI apps may have blocked. */
  maxPreBlocksByAi: 50,
} as const;

/**
 * A change the server won't make, with the reason in plain words for the parent page, MCP and
 * the CLI. Thrown inside the change's transaction, so nothing of it is kept.
 */
export class RuleRefused extends Error {
  override name = "RuleRefused";
}

export const TOO_LARGE = `That change would make this phone's rules too large to send (over ${LIMITS.maxPolicyBytes / 1024} KB). Clear some apps under "Blocked before install" on the phone's page, or shorten Chrome's lists of sites, then try again.`;

// ── Stored rules ─────────────────────────────────────────────────────────

export interface Pause {
  /** Null: until a parent resumes it. */
  until: number | null;
  note: string | null;
  /** When this pause was set or last changed (null: before the server kept it), so a proposal to resume knows which pause it meant. */
  setAt: number | null;
}

export interface Rules {
  version: number;
  changedAt: number | null;
  protectedAt: number | null;
  newApps: "allow" | "ask";
  /** As stored: a pause whose time has passed is over (see activePause). */
  pause: Pause | null;
  restrictions: Record<Restriction, boolean>;
  privateDns: string | null;
  chrome: ChromeSettings | null;
  hideBrowsers: boolean;
  /** As stored: see activeMaintenance. */
  maintenanceUntil: number | null;
  frpAccounts: string[];
  supportMessage: string | null;
  /** When new apps first waited for a parent (null: never). Only then is every app already on the phone allowed. */
  askFirstAt: number | null;
  /** When `newApps` last changed: since then, under "allow", apps installed ran without asking. */
  newAppsAt: number | null;
}

interface PolicyRow {
  device_id: string;
  version: number;
  changed_at: number;
  protected_at: number | null;
  new_apps: "allow" | "ask";
  paused: number;
  pause_until: number | null;
  pause_note: string | null;
  pause_set_at: number | null;
  restrictions: string;
  private_dns: string | null;
  chrome: string | null;
  hide_browsers: number;
  maintenance_until: number | null;
  frp_accounts: string;
  support_message: string | null;
  ask_first_at: number | null;
  new_apps_at: number | null;
}

function parseJson(text: string | null): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function noRestrictions(): Record<Restriction, boolean> {
  return Object.fromEntries(RESTRICTIONS.map((r) => [r, false])) as Record<Restriction, boolean>;
}

/** What a phone without a policy row gets: version 0, enforcing nothing (Phase 1). */
export function defaultRules(): Rules {
  return {
    version: 0,
    changedAt: null,
    protectedAt: null,
    newApps: "allow",
    pause: null,
    restrictions: noRestrictions(),
    privateDns: null,
    chrome: null,
    hideBrowsers: false,
    maintenanceUntil: null,
    frpAccounts: [],
    supportMessage: null,
    askFirstAt: null,
    newAppsAt: null,
  };
}

export function getRules(db: DB, deviceId: string): Rules {
  const row = db.prepare<[string], PolicyRow>("SELECT * FROM policies WHERE device_id = ?").get(deviceId);
  if (!row) return defaultRules();
  const stored = parseJson(row.restrictions);
  const restrictions = noRestrictions();
  if (stored && typeof stored === "object") {
    for (const r of RESTRICTIONS) restrictions[r] = (stored as Record<string, unknown>)[r] === true;
  }
  const chrome = ChromeSettings.safeParse(parseJson(row.chrome));
  const frp = parseJson(row.frp_accounts);
  return {
    version: row.version,
    changedAt: row.changed_at,
    protectedAt: row.protected_at,
    newApps: row.new_apps,
    pause: row.paused === 1 ? { until: row.pause_until, note: row.pause_note, setAt: row.pause_set_at } : null,
    restrictions,
    privateDns: row.private_dns,
    chrome: row.chrome !== null && chrome.success ? chrome.data : null,
    hideBrowsers: row.hide_browsers === 1,
    maintenanceUntil: row.maintenance_until,
    frpAccounts: Array.isArray(frp) ? frp.filter((a): a is string => typeof a === "string") : [],
    supportMessage: row.support_message,
    askFirstAt: row.ask_first_at,
    newAppsAt: row.new_apps_at,
  };
}

function saveRules(db: DB, deviceId: string, rules: Rules, now: number): void {
  db.prepare(
    `INSERT INTO policies (device_id, version, changed_at, protected_at, new_apps, paused, pause_until, pause_note, pause_set_at, restrictions,
       private_dns, chrome, hide_browsers, maintenance_until, frp_accounts, support_message, ask_first_at, new_apps_at)
     VALUES (@device_id, 0, @now, @protected_at, @new_apps, @paused, @pause_until, @pause_note, @pause_set_at, @restrictions,
       @private_dns, @chrome, @hide_browsers, @maintenance_until, @frp_accounts, @support_message, @ask_first_at, @new_apps_at)
     ON CONFLICT (device_id) DO UPDATE SET protected_at = excluded.protected_at, new_apps = excluded.new_apps, paused = excluded.paused,
       pause_until = excluded.pause_until, pause_note = excluded.pause_note, pause_set_at = excluded.pause_set_at, restrictions = excluded.restrictions,
       private_dns = excluded.private_dns, chrome = excluded.chrome, hide_browsers = excluded.hide_browsers,
       maintenance_until = excluded.maintenance_until, frp_accounts = excluded.frp_accounts, support_message = excluded.support_message,
       ask_first_at = excluded.ask_first_at, new_apps_at = excluded.new_apps_at`,
  ).run({
    device_id: deviceId,
    now,
    protected_at: rules.protectedAt,
    new_apps: rules.newApps,
    paused: rules.pause ? 1 : 0,
    pause_until: rules.pause?.until ?? null,
    pause_note: rules.pause?.note ?? null,
    pause_set_at: rules.pause?.setAt ?? null,
    restrictions: JSON.stringify(Object.fromEntries(RESTRICTIONS.filter((r) => rules.restrictions[r]).map((r) => [r, true]))),
    private_dns: rules.privateDns,
    chrome: rules.chrome ? JSON.stringify(rules.chrome) : null,
    hide_browsers: rules.hideBrowsers ? 1 : 0,
    maintenance_until: rules.maintenanceUntil,
    frp_accounts: JSON.stringify(rules.frpAccounts),
    support_message: rules.supportMessage,
    ask_first_at: rules.askFirstAt,
    new_apps_at: rules.newAppsAt,
  });
}

export function policyVersion(db: DB, deviceId: string): number {
  return db.prepare<[string], { version: number }>("SELECT version FROM policies WHERE device_id = ?").get(deviceId)?.version ?? 0;
}

/** The pause in force now, if any. */
export function activePause(rules: Pick<Rules, "pause">, now: number): Pause | null {
  return rules.pause && (rules.pause.until === null || rules.pause.until > now) ? rules.pause : null;
}

/** When maintenance mode ends, if it's on now. */
export function activeMaintenance(rules: Pick<Rules, "maintenanceUntil">, now: number): number | null {
  return rules.maintenanceUntil !== null && rules.maintenanceUntil > now ? rules.maintenanceUntil : null;
}

// ── App decisions ────────────────────────────────────────────────────────

export type DecidedBy = "parent" | "ai" | "grandfathered" | "server";
export type AppState = "allowed" | "blocked";

export interface Decision {
  package: string;
  state: AppState | "undecided";
  decidedBy: DecidedBy;
  parentName: string | null;
  clientName: string | null;
  proposalId: string | null;
  decidedAt: number;
  note: string | null;
}

interface DecisionRow {
  package: string;
  state: Decision["state"];
  decided_by: DecidedBy;
  parent_name: string | null;
  client_name: string | null;
  proposal_id: string | null;
  decided_at: number;
  note: string | null;
}

const DECISION_SELECT = `SELECT d.package, d.state, d.decided_by, p.name AS parent_name, d.client_name, d.proposal_id, d.decided_at, d.note
  FROM app_decisions d LEFT JOIN parents p ON p.id = d.parent_id`;

function toDecision(r: DecisionRow): Decision {
  return {
    package: r.package,
    state: r.state,
    decidedBy: r.decided_by,
    parentName: r.parent_name,
    clientName: r.client_name,
    proposalId: r.proposal_id,
    decidedAt: r.decided_at,
    note: r.note,
  };
}

/** Each app's decision, by package name, sorted. Apps whose latest decision cleared it aren't listed. */
export function currentDecisions(db: DB, deviceId: string): Map<string, Decision & { state: AppState }> {
  const rows = db
    .prepare<[string, string], DecisionRow>(
      `${DECISION_SELECT} WHERE d.device_id = ? AND d.id IN (SELECT MAX(id) FROM app_decisions WHERE device_id = ? GROUP BY package)
       ORDER BY d.package`,
    )
    .all(deviceId, deviceId);
  const map = new Map<string, Decision & { state: AppState }>();
  for (const r of rows) if (r.state !== "undecided") map.set(r.package, { ...toDecision(r), state: r.state });
  return map;
}

export function currentDecision(db: DB, deviceId: string, pkg: string): (Decision & { state: AppState }) | null {
  const row = db
    .prepare<[string, string], DecisionRow>(`${DECISION_SELECT} WHERE d.device_id = ? AND d.package = ? ORDER BY d.id DESC LIMIT 1`)
    .get(deviceId, pkg);
  return row && row.state !== "undecided" ? { ...toDecision(row), state: row.state } : null;
}

/** Every decision about one app, newest first. */
export function decisionHistory(db: DB, deviceId: string, pkg: string): Decision[] {
  return db
    .prepare<[string, string], DecisionRow>(`${DECISION_SELECT} WHERE d.device_id = ? AND d.package = ? ORDER BY d.id DESC`)
    .all(deviceId, pkg)
    .map(toDecision);
}

/** The packages this phone said, in its latest report, that it never blocks. */
function reportedNeverBlocked(db: DB, deviceId: string): ReadonlySet<string> {
  return new Set(deviceFacts(db, deviceId)?.enforcement?.never_blocked ?? []);
}

/**
 * For each app, why this phone never blocks it (so the server won't either), in words, or null
 * when it can be blocked. Reads the phone's report once, for a list of apps.
 */
export function neverBlockedOn(db: DB, deviceId: string): (pkg: string) => string | null {
  const reported = reportedNeverBlocked(db, deviceId);
  return (pkg) => {
    const role = NEVER_BLOCKED.get(pkg);
    if (role) return NEVER_BLOCKED_WHY[role];
    return reported.has(pkg) ? NEVER_BLOCKED_WHY.reported : null;
  };
}

/** Why this phone never blocks the app, in words, or null when it can be blocked. */
export function neverBlockedReason(db: DB, deviceId: string, pkg: string): string | null {
  return neverBlockedOn(db, deviceId)(pkg);
}

/** Whether the phone has ever reported this app (it's in its app list, now or before a removal). */
function reported(db: DB, deviceId: string, pkg: string): boolean {
  return !!db.prepare("SELECT 1 FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg);
}

/**
 * Decisions about apps the phone has never reported: blocked (or allowed) before they were
 * installed, newest first. Each one is in every policy the phone gets, so there's a limit on
 * them (LIMITS.maxPreDecisions), and the parent page lists them under "Blocked before install".
 */
export function preDecisions(db: DB, deviceId: string): (Decision & { state: AppState })[] {
  return db
    .prepare<[string, string], DecisionRow>(
      `${DECISION_SELECT} WHERE d.device_id = ? AND d.id IN (SELECT MAX(id) FROM app_decisions WHERE device_id = ? GROUP BY package)
         AND d.state != 'undecided' AND NOT EXISTS (SELECT 1 FROM apps a WHERE a.device_id = d.device_id AND a.package = d.package)
       ORDER BY d.decided_at DESC, d.id DESC`,
    )
    .all(deviceId, deviceId)
    .flatMap((r) => (r.state === "undecided" ? [] : [{ ...toDecision(r), state: r.state }]));
}

/** Refuses a new decision about an app the phone never reported, past the limits. */
function checkPreDecisionLimits(db: DB, deviceId: string, pkg: string, who: Changer): void {
  if (reported(db, deviceId, pkg) || currentDecision(db, deviceId, pkg)) return;
  const pre = preDecisions(db, deviceId);
  if (who.kind === "ai" && pre.filter((d) => d.decidedBy === "ai").length >= LIMITS.maxPreBlocksByAi) {
    throw new RuleRefused(
      `AI apps have already blocked ${LIMITS.maxPreBlocksByAi} apps that aren't on this phone, the most Belay keeps. A parent can clear them on the phone's page, under "Blocked before install". Apps on the phone can still be blocked.`,
    );
  }
  if (pre.length >= LIMITS.maxPreDecisions) {
    throw new RuleRefused(
      `This phone already has ${LIMITS.maxPreDecisions} apps blocked or allowed before they were installed, the most Belay keeps. Clear some on the phone's page, under "Blocked before install". Apps on the phone can still be blocked.`,
    );
  }
}

// ── The policy the phone gets ────────────────────────────────────────────

export const REQUEST_WINDOW_MS = 30 * 86_400_000;
const MAX_POLICY_REQUESTS = 100;

/**
 * The kid's requests of the last 30 days with their answers, newest first: those received or
 * answered in that time, and any still waiting.
 */
function requestAnswers(db: DB, deviceId: string, now: number): Policy["requests"] {
  const since = now - REQUEST_WINDOW_MS;
  return db
    .prepare<
      [string, number, number, number],
      {
        id: string;
        status: Policy["requests"][number]["status"];
        note: string | null;
        answered_at: number | null;
        answered_by: string | null;
        given_minutes: number | null;
      }
    >(
      `SELECT r.id, r.status, r.note, r.answered_at, p.name AS answered_by, r.given_minutes FROM requests r LEFT JOIN parents p ON p.id = r.answered_by
       WHERE r.device_id = ? AND r.status != 'superseded' AND (r.status = 'pending' OR r.received_at >= ? OR r.answered_at >= ?)
       ORDER BY r.received_at DESC, r.rowid DESC LIMIT ?`,
    )
    .all(deviceId, since, since, MAX_POLICY_REQUESTS)
    .map((r) => ({
      id: r.id,
      status: r.status,
      note: r.note?.slice(0, LIMITS.answerNote) ?? null,
      answered_at: r.answered_at,
      answered_by: r.answered_by?.slice(0, 60) ?? null,
      // Phase 3: the minutes a parent gave, for an approved more_time request.
      minutes: r.status === "approved" ? r.given_minutes : null,
    }));
}

/**
 * Phase 6: the version of Belay a parent offered this phone (family/agent.ts), while the phone
 * runs an older one; Android refuses to install an older version over a newer one anyway.
 */
function agentUpdate(db: DB, deviceId: string): Policy["agent_update"] {
  const offer = db
    .prepare<[string], { sha256: string; size: number; version_code: number; version_name: string | null }>(
      "SELECT f.sha256, f.size, f.version_code, f.version_name FROM agent_offers o JOIN agent_files f ON f.sha256 = o.sha256 WHERE o.device_id = ?",
    )
    .get(deviceId);
  if (!offer) return null;
  const running = deviceFacts(db, deviceId)?.agent_version_code;
  if (running !== undefined && running >= offer.version_code) return null;
  return { version_code: offer.version_code, version_name: offer.version_name, sha256: offer.sha256, size: offer.size };
}

/**
 * Phase 6: the check for the phone's recovery key (family/recovery.ts), never the key: the newest
 * one, until the phone reports it used.
 */
function recoveryCheck(db: DB, deviceId: string): Policy["recovery"] {
  const key = db
    .prepare<[string], { version: number; salt: string; hash: string; used_at: number | null }>(
      "SELECT version, salt, hash, used_at FROM recovery_keys WHERE device_id = ? ORDER BY version DESC LIMIT 1",
    )
    .get(deviceId);
  return key && key.used_at === null ? { version: key.version, salt: key.salt, hash: key.hash } : null;
}

/**
 * Phase 10: the one-shot commands a parent sent (family/commands.ts) that the phone hasn't
 * reported yet. One past its expiry stays, so the phone can report it expired.
 */
function commandsFor(db: DB, deviceId: string): Policy["commands"] {
  return db
    .prepare<[string], Policy["commands"][number]>(
      "SELECT id, kind, issued_at, expires_at FROM commands WHERE device_id = ? AND result IS NULL AND replaced_at IS NULL ORDER BY issued_at, rowid",
    )
    .all(deviceId);
}

/** The policy for one phone, as the device API sends it. */
export function buildPolicy(db: DB, deviceId: string, now: number): Policy {
  const rules = getRules(db, deviceId);
  const pause = activePause(rules, now);
  const screen = phoneRules(db, deviceId);
  return {
    version: rules.version,
    issued_at: rules.changedAt ?? now,
    apps: {
      new_apps: rules.newApps,
      decisions: [...currentDecisions(db, deviceId).values()].map((d) => ({ package: d.package, state: d.state })),
    },
    pause: pause ? { until: pause.until, note: pause.note } : null,
    restrictions: { ...rules.restrictions },
    web: { private_dns: rules.privateDns, chrome: rules.chrome ? { ...rules.chrome } : null, hide_browsers: rules.hideBrowsers },
    maintenance_until: activeMaintenance(rules, now),
    frp_accounts: [...rules.frpAccounts],
    support_message: rules.supportMessage,
    requests: requestAnswers(db, deviceId, now),
    agent_update: agentUpdate(db, deviceId),
    recovery: recoveryCheck(db, deviceId),
    commands: commandsFor(db, deviceId),
    // Phase 3 (family/screentime): the stage's rules with the phone's own on top, and today's extra time.
    screen_time: screenTimeFor(db, deviceId, now, screen),
    stage: stageFor(db, deviceId, screen),
    agreement: agreementFor(db, deviceId),
    // Network logging is a later part of Phase 3: off until a parent can turn it on.
    network_log: { enabled: false },
  };
}

/** Everything in the policy but its version and time: what the phone would see. */
function content(db: DB, deviceId: string, now: number): string {
  const { version: _version, issued_at: _issued, ...rest } = buildPolicy(db, deviceId, now);
  return JSON.stringify(rest);
}

/** The size of the policy's JSON, as sent, with this content, version and time. */
function policyBytes(contentJson: string, version: number, issuedAt: number): number {
  return Buffer.byteLength(contentJson) - 1 + `{"version":${version},"issued_at":${issuedAt},`.length;
}

// ── Changing it ──────────────────────────────────────────────────────────

/** Who changes a rule: a parent, an AI app a parent connected, or the server's CLI. */
export type Changer = Exclude<Actor, { kind: "phone" }>;
/** Who may loosen a rule: a person. AI apps only propose (family/proposals.ts). */
export type Person = Exclude<Changer, { kind: "ai" }>;

export interface PolicyContext {
  db: DB;
  now: number;
  /** Called after a change the phone would see, to wake its long-poll. */
  changed?: (deviceId: string) => void;
}

export interface Changed<T> {
  result: T;
  /** The phone's version after the change. */
  version: number;
  /** Whether what the phone would see changed (and so the version increased). */
  changed: boolean;
}

export type Log = (action: string, detail?: Record<string, unknown>) => void;

/**
 * A change to what one phone gets from the other parts of the family's rules (Phase 6's update
 * and recovery key, Phase 10's commands, what the phone itself reports), the way the rules here
 * change: in one transaction, in the activity log, with the version bumped when what the phone
 * would see changed. A phone's own report is never refused.
 */
export function changePolicy<T>(ctx: PolicyContext, deviceId: string, actor: Actor, change: (log: Log) => T): Changed<T> {
  return mutate(ctx, deviceId, actor, (_rules, log) => change(log));
}

/**
 * A change to what several phones get at once (a stage's rules: every phone on it gets them), in
 * one transaction: each phone whose policy changed gets a new version, within the size limit,
 * and its long-poll wakes. The activity log's entries name no phone; their detail says how many
 * changed.
 */
export function changePolicies<T>(ctx: PolicyContext, deviceIds: string[], actor: Changer, change: (log: Log) => T): { result: T; changed: string[] } {
  const { db, now } = ctx;
  const outcome = db.transaction(() => {
    const before = new Map(deviceIds.map((id) => [id, content(db, id, now)]));
    const entries: [string, Record<string, unknown> | undefined][] = [];
    const result = change((action, detail) => entries.push([action, detail]));
    const changed: string[] = [];
    for (const id of deviceIds) {
      const after = content(db, id, now);
      const was = before.get(id) ?? "";
      if (after === was) continue;
      const stored = getRules(db, id);
      // A phone without rules yet still needs the row, for the version.
      saveRules(db, id, stored, now);
      const version = stored.version + 1;
      if (policyBytes(after, version, now) > LIMITS.maxPolicyBytes && Buffer.byteLength(after) > Buffer.byteLength(was)) throw new RuleRefused(TOO_LARGE);
      db.prepare("UPDATE policies SET version = ?, changed_at = ? WHERE device_id = ?").run(version, now, id);
      changed.push(id);
    }
    for (const [action, detail] of entries) audit(db, now, actor, action, { detail: { ...detail, phones_changed: changed.length } });
    return { result, changed };
  })();
  for (const id of outcome.changed) ctx.changed?.(id);
  return outcome;
}

function mutate<T>(ctx: PolicyContext, deviceId: string, actor: Actor, change: (rules: Rules, log: Log) => T): Changed<T> {
  const { db, now } = ctx;
  const outcome = db.transaction((): Changed<T> => {
    const before = content(db, deviceId, now);
    const stored = getRules(db, deviceId);
    const rules = structuredClone(stored);
    const entries: [string, Record<string, unknown> | undefined][] = [];
    const result = change(rules, (action, detail) => entries.push([action, detail]));
    const rulesChanged = JSON.stringify(rules) !== JSON.stringify(stored);
    if (rulesChanged) saveRules(db, deviceId, rules, now);
    const after = content(db, deviceId, now);
    const changed = after !== before;
    // A decision or an answer alone still needs the row, for the version.
    if (changed && !rulesChanged) saveRules(db, deviceId, rules, now);
    let version = stored.version;
    if (changed) {
      version += 1;
      // Never more than the phone can take. A change that makes it smaller always goes through.
      if (actor.kind !== "phone" && policyBytes(after, version, now) > LIMITS.maxPolicyBytes && Buffer.byteLength(after) > Buffer.byteLength(before)) {
        throw new RuleRefused(TOO_LARGE);
      }
      db.prepare("UPDATE policies SET version = ?, changed_at = ? WHERE device_id = ?").run(version, now, deviceId);
    }
    for (const [action, detail] of entries) audit(db, now, actor, action, { deviceId, detail: { ...detail, ...(changed ? { version } : {}) } });
    return { result, version, changed };
  })();
  if (outcome.changed) ctx.changed?.(deviceId);
  return outcome;
}

const decidedBy = (who: Changer): DecidedBy => (who.kind === "server" ? "server" : who.kind);
const parentOf = (who: Changer): string | null => (who.kind === "server" ? null : who.parentId);

/** The types already say so; this keeps it true at run time too. */
function onlyPeople(who: Changer): void {
  if (who.kind === "ai") throw new Error("An AI app can't loosen a rule: that's a proposal for a parent");
}
function onlyParents(who: Changer): void {
  if (who.kind !== "parent") throw new Error("Only a parent, on the parent page, changes hardening or maintenance mode");
}

function insertDecision(
  db: DB,
  now: number,
  d: { deviceId: string; pkg: string; state: Decision["state"]; by: DecidedBy; parentId: string | null; clientName?: string | null; proposalId?: string | null; note?: string | null },
): void {
  db.prepare(
    `INSERT INTO app_decisions (device_id, package, state, decided_by, parent_id, client_name, proposal_id, decided_at, note)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(d.deviceId, d.pkg, d.state, d.by, d.parentId, d.clientName ?? null, d.proposalId ?? null, now, d.note ?? null);
}

function appLabel(db: DB, deviceId: string, pkg: string): string | null {
  return (
    db.prepare<[string, string], { label: string }>("SELECT label FROM apps WHERE device_id = ? AND package = ?").get(deviceId, pkg)?.label ??
    db
      .prepare<[string, string], { label: string }>("SELECT label FROM requests WHERE device_id = ? AND package = ? AND kind = 'app' ORDER BY received_at DESC")
      .get(deviceId, pkg)?.label ??
    null
  );
}

/** User apps on the phone without a decision: what "ask" holds back. */
function undecidedUserApps(db: DB, deviceId: string): { package: string; label: string; install_seen_at: number }[] {
  const decided = currentDecisions(db, deviceId);
  return db
    .prepare<[string], { package: string; label: string; install_seen_at: number }>(
      "SELECT package, label, install_seen_at FROM apps WHERE device_id = ? AND present = 1 AND system = 0 ORDER BY label COLLATE NOCASE, package",
    )
    .all(deviceId)
    .filter((a) => !decided.has(a.package));
}

export interface AppRef {
  package: string;
  /** From the app's developer: untrusted. */
  label: string;
}

/**
 * What turning "ask" on again leaves for a parent to choose: the apps without a decision that
 * were installed while new apps were allowed (they've been running), and those from before (they
 * were waiting for a parent). Null when new apps already ask, or never asked before: the first
 * time, every app already on the phone is allowed.
 */
export interface AskAgain {
  /** When new apps were allowed. */
  since: number | null;
  installedMeanwhile: AppRef[];
  waitingBefore: AppRef[];
}

function askAgainOf(db: DB, deviceId: string, rules: Pick<Rules, "newApps" | "askFirstAt" | "newAppsAt">): AskAgain | null {
  if (rules.newApps === "ask" || rules.askFirstAt === null) return null;
  const since = rules.newAppsAt;
  const apps = undecidedUserApps(db, deviceId);
  const ref = (a: { package: string; label: string }): AppRef => ({ package: a.package, label: a.label });
  return {
    since,
    // One recorded at the very moment of the switch counts as from before: by default it waits.
    installedMeanwhile: apps.filter((a) => since === null || a.install_seen_at > since).map(ref),
    waitingBefore: apps.filter((a) => since !== null && a.install_seen_at <= since).map(ref),
  };
}

export function askAgainSummary(db: DB, deviceId: string): AskAgain | null {
  return askAgainOf(db, deviceId, getRules(db, deviceId));
}

export interface AskTurnedOn {
  /** The first time new apps ask: every user app already on the phone was allowed. */
  firstTime: boolean;
  /** Apps allowed as "ask" turned on: all of them the first time; later, the ones chosen. */
  grandfathered: number;
  /** Later times: the apps that wait for a parent now (not chosen, or waiting before). */
  stillWaiting: number;
}

/**
 * Turns "ask" on (the caller sets `rules.newApps`). The first time, every user app already on
 * the phone is recorded as allowed ("grandfathered"), so nothing the kid has stops working by
 * surprise. Later, only the apps in `allow` are (by default, those installed while new apps
 * were allowed); the apps that were waiting before stay waiting unless they're chosen too.
 */
function turnAskOn(ctx: PolicyContext, deviceId: string, rules: Rules, who: Person, allow?: readonly string[]): AskTurnedOn {
  const { db, now } = ctx;
  const again = askAgainOf(db, deviceId, rules);
  if (!again) {
    rules.askFirstAt ??= now;
    const apps = undecidedUserApps(db, deviceId);
    for (const a of apps) insertDecision(db, now, { deviceId, pkg: a.package, state: "allowed", by: "grandfathered", parentId: parentOf(who) });
    return { firstTime: true, grandfathered: apps.length, stillWaiting: 0 };
  }
  const chosen = new Set(allow ?? again.installedMeanwhile.map((a) => a.package));
  let grandfathered = 0;
  for (const a of again.installedMeanwhile.filter((x) => chosen.has(x.package))) {
    insertDecision(db, now, { deviceId, pkg: a.package, state: "allowed", by: "grandfathered", parentId: parentOf(who) });
    grandfathered++;
  }
  // A waiting app a parent chooses now is approved like any other, and so is the kid's request for it.
  for (const a of again.waitingBefore.filter((x) => chosen.has(x.package))) {
    insertDecision(db, now, { deviceId, pkg: a.package, state: "allowed", by: decidedBy(who), parentId: parentOf(who) });
    approveOpenRequests(db, now, deviceId, a.package, who, null);
    grandfathered++;
  }
  return { firstTime: false, grandfathered, stillWaiting: again.installedMeanwhile.length + again.waitingBefore.length - grandfathered };
}

/** Marks the kid's open requests for this app approved: the app runs now, so the answer says so. */
function approveOpenRequests(db: DB, now: number, deviceId: string, pkg: string, who: Person, note: string | null): number {
  return db
    .prepare(
      `UPDATE requests SET status = 'approved', note = ?, answered_by = ?, answered_at = ?
       WHERE device_id = ? AND package = ? AND kind = 'app' AND status IN ('pending', 'talk')`,
    )
    .run(note, parentOf(who), now, deviceId, pkg).changes;
}

const clean = (text: string | null | undefined, max: number): string | null => text?.trim().slice(0, max) || null;

/**
 * Whether new apps wait for a parent. Turning "ask" on again later allows only the apps in
 * `allow`, which defaults to the ones installed while new apps were allowed (see turnAskOn).
 */
export function setNewApps(ctx: PolicyContext, deviceId: string, mode: "allow" | "ask", who: Person, opts: { allow?: readonly string[] } = {}): Changed<AskTurnedOn> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    if (rules.newApps === mode) return { firstTime: false, grandfathered: 0, stillWaiting: 0 };
    const outcome = mode === "ask" ? turnAskOn(ctx, deviceId, rules, who, opts.allow) : { firstTime: false, grandfathered: 0, stillWaiting: 0 };
    rules.newApps = mode;
    rules.newAppsAt = ctx.now;
    log("policy.new_apps", mode === "ask" ? { mode, grandfathered: outcome.grandfathered, first_time: outcome.firstTime, still_waiting: outcome.stillWaiting } : { mode });
    return outcome;
  });
}

/**
 * Turns protection on in one step: new apps ask (the first time, every user app already on the
 * phone is allowed; later, the ones installed while new apps were allowed), the safe
 * restrictions, the CleanBrowsing Family filter and Chrome's safe defaults. A filter or Chrome
 * settings the parent already chose are kept. Accounts, the SIM and hardening are separate.
 */
export function protect(ctx: PolicyContext, deviceId: string, who: Person): Changed<AskTurnedOn & { alreadyOn: boolean }> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const alreadyOn = rules.protectedAt !== null;
    rules.protectedAt ??= ctx.now;
    let outcome: AskTurnedOn = { firstTime: false, grandfathered: 0, stillWaiting: 0 };
    if (rules.newApps !== "ask") {
      outcome = turnAskOn(ctx, deviceId, rules, who);
      rules.newApps = "ask";
      rules.newAppsAt = ctx.now;
    }
    for (const r of SAFE_RESTRICTIONS) rules.restrictions[r] = true;
    rules.privateDns ??= DNS_FILTERS.cleanbrowsing.host;
    rules.chrome ??= { ...SAFE_CHROME };
    log("policy.protected", { grandfathered: outcome.grandfathered, ...(outcome.stillWaiting ? { still_waiting: outcome.stillWaiting } : {}) });
    return { ...outcome, alreadyOn };
  });
}

/** Back to monitoring only: nothing locked, filtered or paused. App decisions are kept, so blocked apps stay blocked. */
export function unprotect(ctx: PolicyContext, deviceId: string, who: Person): Changed<null> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const blank = defaultRules();
    // New apps run without asking from now; that new apps asked before is remembered.
    const newAppsAt = rules.newApps === blank.newApps ? rules.newAppsAt : ctx.now;
    Object.assign(rules, { ...blank, version: rules.version, changedAt: rules.changedAt, supportMessage: rules.supportMessage, askFirstAt: rules.askFirstAt, newAppsAt });
    log("policy.unprotected");
    return null;
  });
}

export type DecideResult = Changed<{ before: Decision | null; label: string | null; requestsApproved: number }>;

/**
 * Allows or blocks one app, or clears its decision. An AI app may only block. Allowing an
 * app also approves the kid's open requests for it. Blocking an app the phone never blocks
 * is refused (RuleRefused), for parents too, with the reason.
 */
export function decideApp(
  ctx: PolicyContext,
  deviceId: string,
  pkg: string,
  state: AppState | "undecided",
  who: Changer,
  opts: { note?: string | null; proposalId?: string | null } = {},
): DecideResult {
  if (who.kind === "ai" && state !== "blocked") throw new Error("An AI app can only block apps; anything else is a proposal");
  const never = state === "blocked" ? neverBlockedReason(ctx.db, deviceId, pkg) : null;
  if (never) throw new RuleRefused(never);
  return mutate(ctx, deviceId, who, (_rules, log) => {
    const { db, now } = ctx;
    if (state !== "undecided") checkPreDecisionLimits(db, deviceId, pkg, who);
    const before = currentDecision(db, deviceId, pkg);
    const note = clean(opts.note, LIMITS.decisionNote);
    insertDecision(db, now, {
      deviceId,
      pkg,
      state,
      by: decidedBy(who),
      parentId: parentOf(who),
      clientName: who.kind === "ai" ? who.clientName : null,
      proposalId: opts.proposalId ?? null,
      note,
    });
    const requestsApproved = state === "allowed" && who.kind !== "ai" ? approveOpenRequests(db, now, deviceId, pkg, who, clean(opts.note, LIMITS.answerNote)) : 0;
    const label = appLabel(db, deviceId, pkg);
    log(state === "allowed" ? "app.allowed" : state === "blocked" ? "app.blocked" : "app.undecided", {
      package: pkg,
      label: label ?? undefined,
      note: note ?? undefined,
      ...(opts.proposalId ? { proposal: opts.proposalId } : {}),
    });
    return { before, label, requestsApproved };
  });
}

/**
 * Clears decisions about apps the phone has never reported ("Blocked before install"): one app,
 * or every one whose decision an AI app made. They leave the policy, instead of staying in it
 * as allowed the way Unblock would. A person's action: AI apps only add blocks.
 */
export function clearPreDecisions(ctx: PolicyContext, deviceId: string, which: { package: string } | { byAi: true }, who: Person): Changed<{ cleared: string[] }> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (_rules, log) => {
    const { db, now } = ctx;
    const clearing = preDecisions(db, deviceId).filter((d) => ("package" in which ? d.package === which.package : d.decidedBy === "ai"));
    for (const d of clearing) insertDecision(db, now, { deviceId, pkg: d.package, state: "undecided", by: decidedBy(who), parentId: parentOf(who) });
    if ("package" in which && clearing.length) log("app.undecided", { package: which.package, before_install: true });
    else if (clearing.length) log("apps.pre_blocks_cleared", { count: clearing.length });
    return { cleared: clearing.map((d) => d.package) };
  });
}

/**
 * Pauses the phone: every app but the never-blocked ones is suspended until then (null: until
 * a parent resumes it). An AI app can only make a pause longer, never shorter, and its note,
 * which the kid sees, only goes with a pause it sets or lengthens: against a pause at least as
 * long, nothing changes (`kept`).
 */
export function pausePhone(
  ctx: PolicyContext,
  deviceId: string,
  input: { minutes: number | null; note?: string | null },
  who: Changer,
): Changed<{ until: number | null; kept: boolean }> {
  return mutate(ctx, deviceId, who, (rules, log) => applyPause(ctx.now, rules, input, who, log));
}

/** pausePhone's change, on rules being changed. */
function applyPause(now: number, rules: Rules, input: { minutes: number | null; note?: string | null }, who: Changer, log: Log): { until: number | null; kept: boolean } {
  const current = activePause(rules, now);
  const minutes = input.minutes === null ? null : Math.min(Math.max(1, Math.round(input.minutes)), LIMITS.maxPauseMinutes);
  let until = minutes === null ? null : now + minutes * 60_000;
  const kept = who.kind === "ai" && current !== null && (current.until === null || (until !== null && current.until >= until));
  const given = input.note !== undefined && input.note !== null ? clean(input.note, LIMITS.pauseNote) : undefined;
  let note: string | null;
  let setAt: number | null = now;
  if (kept) {
    until = current.until;
    note = current.note;
    setAt = current.setAt;
  } else {
    // Without a note of its own, an AI app's longer pause keeps the note there is.
    note = given !== undefined ? given : who.kind === "ai" ? (current?.note ?? null) : null;
  }
  rules.pause = { until, note, setAt };
  log("phone.paused", { until, minutes, note: note ?? undefined, ...(kept ? { kept: true } : {}) });
  return { until, kept };
}

/** Phase 3's lock_now: the phone locks its screen once, if it gets the command within this long. */
export const LOCK_NOW_MS = 10 * 60_000;
/** How long lock_phone may pause the phone, in minutes. */
export const LOCK_MINUTES = { min: 5, max: 240 } as const;

export type CommandKind = "remove_other_users" | "lock_now";

/** A one-shot command's row (family/commands.ts): the phone runs each id once. */
export function insertCommandRow(db: DB, deviceId: string, kind: CommandKind, now: number, expiresAt: number | null, who: Changer): string {
  const id = newId();
  db.prepare("INSERT INTO commands (id, device_id, kind, issued_at, expires_at, issued_by, client_name) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
    id,
    deviceId,
    kind,
    now,
    expiresAt,
    parentOf(who),
    who.kind === "ai" ? who.clientName : null,
  );
  return id;
}

/**
 * Locks the phone now (MCP's lock_phone): a pause of 5 to 240 minutes (an AI app's only ever
 * lengthens one running, as pausePhone says) and a lock_now command, which the phone runs once if
 * it gets it within 10 minutes; one still waiting is replaced. Calls, texts, 911, 988 and Belay
 * keep working, as in any pause. Tightening, so an AI app may.
 */
export function lockPhone(ctx: PolicyContext, deviceId: string, input: { minutes: number; note?: string | null }, who: Changer): Changed<{ until: number | null; kept: boolean; command: string }> {
  const minutes = Math.min(Math.max(LOCK_MINUTES.min, Math.round(input.minutes)), LOCK_MINUTES.max);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const { db, now } = ctx;
    const pause = applyPause(now, rules, { minutes, note: input.note }, who, log);
    db.prepare("UPDATE commands SET replaced_at = ? WHERE device_id = ? AND kind = 'lock_now' AND result IS NULL AND replaced_at IS NULL").run(now, deviceId);
    const command = insertCommandRow(db, deviceId, "lock_now", now, now + LOCK_NOW_MS, who);
    log("command.issued", { kind: "lock_now", command, expires_at: now + LOCK_NOW_MS });
    return { ...pause, command };
  });
}

export function resumePhone(ctx: PolicyContext, deviceId: string, who: Person): Changed<{ wasPaused: boolean }> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const wasPaused = activePause(rules, ctx.now) !== null;
    rules.pause = null;
    if (wasPaused) log("phone.resumed");
    return { wasPaused };
  });
}

/** Locks or unlocks settings other than hardening. */
export function setRestrictions(
  ctx: PolicyContext,
  deviceId: string,
  changes: Partial<Record<OrdinaryRestriction, boolean>>,
  who: Person,
): Changed<{ on: Restriction[]; off: Restriction[] }> {
  onlyPeople(who);
  for (const key of Object.keys(changes)) {
    if ((HARDENING as readonly string[]).includes(key) || !(RESTRICTIONS as readonly string[]).includes(key)) throw new Error(`Not an ordinary restriction: ${key}`);
  }
  return mutate(ctx, deviceId, who, (rules, log) => {
    const on: Restriction[] = [];
    const off: Restriction[] = [];
    for (const [key, value] of Object.entries(changes) as [OrdinaryRestriction, boolean | undefined][]) {
      if (value === undefined || rules.restrictions[key] === value) continue;
      rules.restrictions[key] = value;
      (value ? on : off).push(key);
    }
    if (on.length || off.length) log("policy.restrictions", { on, off });
    return { on, off };
  });
}

/**
 * Factory reset, debugging and reset protection: they can lock a phone for good. Only the
 * parent page calls this, after the parent typed the phone's name; AI apps and the CLI can't.
 */
export function setHardening(
  ctx: PolicyContext,
  deviceId: string,
  input: { factoryReset: boolean; debugging: boolean; frpAccounts: string[] },
  who: { kind: "parent"; parentId: string },
): Changed<{ on: string[]; off: string[] }> {
  onlyParents(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const on: string[] = [];
    const off: string[] = [];
    const flip = (key: Hardening, value: boolean) => {
      if (rules.restrictions[key] === value) return;
      rules.restrictions[key] = value;
      (value ? on : off).push(key);
    };
    flip("factory_reset", input.factoryReset);
    flip("debugging", input.debugging);
    const accounts = [...new Set(input.frpAccounts)].slice(0, LIMITS.maxFrpAccounts);
    if (JSON.stringify(accounts) !== JSON.stringify(rules.frpAccounts)) {
      (accounts.length ? on : off).push("frp_accounts");
      rules.frpAccounts = accounts;
    }
    if (on.length || off.length) log("policy.hardening", { on, off, frp_accounts: accounts.length });
    return { on, off };
  });
}

/** Maintenance mode lifts the debugging lock until then, so adb works for repairs. Null ends it. */
export function setMaintenance(ctx: PolicyContext, deviceId: string, until: number | null, who: { kind: "parent"; parentId: string }): Changed<null> {
  onlyParents(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const wasOn = activeMaintenance(rules, ctx.now) !== null;
    rules.maintenanceUntil = until;
    if (until !== null || wasOn) log(until === null ? "policy.maintenance_ended" : "policy.maintenance", until === null ? {} : { until });
    return null;
  });
}

export interface WebChange {
  privateDns?: string | null;
  chrome?: ChromeSettings | null;
  hideBrowsers?: boolean;
}

export function setWeb(ctx: PolicyContext, deviceId: string, change: WebChange, who: Person): Changed<null> {
  onlyPeople(who);
  if (change.privateDns != null && !validHostname(change.privateDns)) throw new Error("Not a host name");
  return mutate(ctx, deviceId, who, (rules, log) => {
    const before = JSON.stringify([rules.privateDns, rules.chrome, rules.hideBrowsers]);
    if (change.privateDns !== undefined) rules.privateDns = change.privateDns;
    if (change.chrome !== undefined) rules.chrome = change.chrome ? ChromeSettings.parse(change.chrome) : null;
    if (change.hideBrowsers !== undefined) rules.hideBrowsers = change.hideBrowsers;
    if (JSON.stringify([rules.privateDns, rules.chrome, rules.hideBrowsers]) !== before) {
      log("policy.web", { private_dns: rules.privateDns, chrome: rules.chrome !== null, hide_browsers: rules.hideBrowsers });
    }
    return null;
  });
}

export function setSupportMessage(ctx: PolicyContext, deviceId: string, message: string | null, who: Person): Changed<null> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (rules, log) => {
    const next = clean(message, LIMITS.supportMessage);
    if (next === rules.supportMessage) return null;
    rules.supportMessage = next;
    log("policy.support_message");
    return null;
  });
}

export type Answer = "approved" | "declined" | "talk";

/** The extra minutes a parent may give for a "more time" request, on the parent page. */
export const MORE_TIME_CHOICES = [15, 30, 60] as const;

export interface Answered {
  kind: "app" | "more_time" | "agreement";
  /** app: the app; more_time: the app the kid was in, if any. */
  package: string | null;
  label: string | null;
  /** The status before this answer. */
  status: string;
  /** more_time, approved: the minutes given, for the phone's day `day`. */
  minutes: number | null;
  day: string | null;
}

/**
 * A parent's answer to one of the kid's requests, shown to the kid with the note. Approving
 * an app request also allows the app. Approving a "more time" request gives `minutes` (1 to
 * 240) of extra time for its limit, for the phone's day now (its zone and day_starts); answering
 * it again takes back what the earlier answer gave. Declining or "let's talk" leave the app or
 * the limit as they are. The kid's answer to the agreement only needs a parent's word: "let's
 * talk", or that they saw it.
 */
export function answerRequest(
  ctx: PolicyContext,
  deviceId: string,
  requestId: string,
  answer: Answer,
  who: Person,
  noteText: string | null,
  opts: { minutes?: number } = {},
): Changed<Answered | null> {
  onlyPeople(who);
  return mutate(ctx, deviceId, who, (_rules, log) => {
    const { db, now } = ctx;
    const find = db.prepare<
      [string, string],
      { id: string; kind: Answered["kind"]; package: string | null; label: string | null; status: string; superseded_by: string | null; limit_id: string | null; extra_id: string | null; agreement_version: number | null }
    >("SELECT id, kind, package, label, status, superseded_by, limit_id, extra_id, agreement_version FROM requests WHERE device_id = ? AND id = ?");
    let row = find.get(deviceId, requestId);
    // Asked again since (a page from before): the answer goes to the request that took its place.
    for (let hops = 0; row?.status === "superseded" && row.superseded_by !== null && hops < 50; hops++) row = find.get(deviceId, row.superseded_by);
    if (!row || row.status === "superseded") return null;
    requestId = row.id;
    const note = clean(noteText, LIMITS.answerNote);
    let minutes: number | null = null;
    let day: string | null = null;
    let extraId: string | null = null;
    if (row.kind === "more_time") {
      // Answering again: the earlier answer's extra time goes; this one decides.
      if (row.extra_id) db.prepare("DELETE FROM extra_time WHERE device_id = ? AND id = ?").run(deviceId, row.extra_id);
      if (answer === "approved") {
        const given = opts.minutes;
        if (given === undefined || !Number.isInteger(given) || given < 1 || given > 240) throw new RuleRefused("Choose how many minutes to give: 1 to 240.");
        minutes = given;
        day = phoneDay(db, deviceId, now);
        extraId = insertExtra(db, deviceId, { limitId: row.limit_id ?? "*", minutes, package: null, requestId, day }, now, parentOf(who));
      }
    }
    db.prepare("UPDATE requests SET status = ?, note = ?, answered_by = ?, answered_at = ?, given_minutes = ?, extra_id = ? WHERE device_id = ? AND id = ?").run(
      answer,
      note,
      parentOf(who),
      now,
      minutes,
      extraId,
      deviceId,
      requestId,
    );
    if (row.kind === "app" && answer === "approved" && row.package) {
      insertDecision(db, now, { deviceId, pkg: row.package, state: "allowed", by: decidedBy(who), parentId: parentOf(who), note });
      approveOpenRequests(db, now, deviceId, row.package, who, note);
    }
    const limit = row.kind === "more_time" ? (row.limit_id === "*" ? "every limit" : (phoneRules(db, deviceId).rules.limits.find((l) => l.id === row.limit_id)?.name ?? "a limit")) : undefined;
    log("request.answered", {
      answer,
      ...(row.kind === "app" ? { package: row.package ?? undefined, label: row.label ?? undefined } : { kind: row.kind }),
      ...(limit !== undefined ? { limit } : {}),
      ...(minutes !== null ? { minutes, day } : {}),
      ...(row.kind === "agreement" ? { agreement_version: row.agreement_version ?? undefined } : {}),
      note: note ?? undefined,
    });
    return { kind: row.kind, package: row.package, label: row.label, status: row.status, minutes, day };
  });
}

// ── In words ─────────────────────────────────────────────────────────────

export function chromeInWords(chrome: ChromeSettings): string[] {
  const words = [
    chrome.incognito ? "incognito tabs allowed" : "no incognito tabs",
    chrome.safe_search ? "SafeSearch on" : "SafeSearch not forced",
    chrome.youtube_restrict === "off" ? "YouTube unrestricted" : `YouTube Restricted Mode (${chrome.youtube_restrict})`,
    chrome.safe_sites ? "adult sites filtered" : "adult sites not filtered",
    chrome.allow_downloads ? "downloads allowed" : "no downloads",
  ];
  if (chrome.url_allowlist) words.push(`only ${chrome.url_allowlist.length} listed site${chrome.url_allowlist.length === 1 ? "" : "s"} open`);
  if (chrome.url_blocklist.length) words.push(`${chrome.url_blocklist.length} site${chrome.url_blocklist.length === 1 ? "" : "s"} blocked`);
  return words;
}

/** The locked settings, in words, in the order RESTRICTIONS lists them. */
export function lockedInWords(rules: Pick<Rules, "restrictions">): string[] {
  return RESTRICTIONS.filter((r) => rules.restrictions[r]).map((r) => RESTRICTION_NAMES[r]);
}
