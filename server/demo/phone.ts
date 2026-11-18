/**
 * The demo's simulated phone (docs/demo.md): a client of the device API (docs/protocol.md) that
 * plays the phone's side the way Belay's agent does on a real one, with no Android behind it. It
 * enrolls with a code, checks in, sends its app list and its changes, holds the policy long-poll,
 * and applies each policy as the agent reports it: which apps it holds suspended or hidden (new
 * apps waiting, blocked apps, a pause, a schedule, a limit used up), the commands it ran, the
 * answers to the kid's requests, and the version it applied.
 *
 * What it can't simulate, it says in its own words, as a real phone would about what it couldn't
 * do: it has no GPS and no network log, and it can't install a new version of Belay.
 *
 * Everything it sends is checked against the server's own schemas (src/device/schemas.ts) by
 * test/demo-phone.test.ts and test/demo-family.test.ts. It never runs in the server's build
 * (docs/demo.md says why).
 */
import { randomUUID } from "node:crypto";
import type { CallRecord, Device, Enforcement, Event, Package, Policy, Request, UsageDay } from "../src/device/schemas.js";
import { addDays, at, clockMinutes, dateIn, dayAt, dayClock, endOf, startOf, weekdayOf } from "../src/family/screentime/days.js";
import { isValidTimeZone, zoned } from "../src/time.js";
import { BELAY_APP, type DemoApp, KEPT_OPEN, NEVER_BLOCKED, packageOf } from "./family.js";

/** How often a real phone checks in, sends its app list, and sends today's screen time. */
export const CHECKIN_MS = 2 * 3_600_000;
export const INVENTORY_MS = 24 * 3_600_000;
export const USAGE_MS = 15 * 60_000;
/** How often it looks again at what its rules hold, as the clock moves (a schedule, a pause's end, a limit). */
export const RECHECK_MS = 60_000;
/** The longest the server holds the policy long-poll (docs/protocol.md). */
export const LONG_POLL_SECONDS = 55;

/** The phone's own words for what it can't do, as Belay on a real phone reports a problem. */
export const SAYS = {
  noGps: "This is a simulated phone (Belay's demo): it has no GPS, so it can't share where it is.",
  noNetworkLog: "This is a simulated phone (Belay's demo): it can't note which websites its apps look up, so network logging sends nothing.",
  noUpdate: "This is a simulated phone (Belay's demo): it can't install a new version of Belay.",
  unknownCommand: "This version of Belay doesn't know that command.",
} as const;

export interface CommandResult {
  id: string;
  result: "done" | "failed" | "expired";
  at: number;
  problem: string | null;
}

/** A request the kid made on the phone, and the answer it has: what Belay shows the kid. */
export interface Asked {
  kind: Request["kind"];
  /** What it's about, in words: the app's name, or the limit's. */
  about: string;
  /** The app it's for, if any. */
  package: string | null;
  status: Policy["requests"][number]["status"];
  note: string | null;
}

/** Everything the phone keeps, as JSON: in the demo's directory between runs (docs/demo.md). */
export interface PhoneState {
  token: string | null;
  deviceId: string | null;
  name: string | null;
  bootCount: number;
  lastBootAt: number;
  apps: Package[];
  /** Waiting to be sent, in the order made (docs/protocol.md, "Order"). */
  outbox: { events: Event[]; requests: Request[]; usage: UsageDay[]; calls: CallRecord[] };
  /** The policy applied last, and when. */
  policy: Policy | null;
  appliedAt: number | null;
  /** The last 20 commands' results, newest first. */
  results: CommandResult[];
  asked: Record<string, Asked>;
  /** What the phone counted, by local day: today's and yesterday's. */
  usage: Record<string, UsageDay>;
  lastCheckinAt: number | null;
  lastInventoryAt: number | null;
}

export function newPhoneState(opts: { now: number; bootCount: number; lastBootAt: number; apps: Package[] }): PhoneState {
  return {
    token: null,
    deviceId: null,
    name: null,
    bootCount: opts.bootCount,
    lastBootAt: opts.lastBootAt,
    apps: opts.apps,
    outbox: { events: [], requests: [], usage: [], calls: [] },
    policy: null,
    appliedAt: null,
    results: [],
    asked: {},
    usage: {},
    lastCheckinAt: null,
    lastInventoryAt: null,
  };
}

/** A device API call that failed: the server's status and error code, or 0 when it wasn't reached. */
export class PhoneError extends Error {
  override name = "PhoneError";
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

// ── What the policy makes the phone do (core's rules, simplified) ───────

export type Why = "waiting" | "blocked" | "paused" | "schedule" | "limit";

export interface LimitNow {
  id: string;
  name: string;
  /** Today's minutes, with extra time. */
  allowed: number;
  used: number;
  left: number;
  state: "open" | "used_up" | "extra";
}

export interface Enforced {
  /** The phone's day, in the rules' zone. */
  day: string;
  /** Each app held suspended (or hidden, when blocked), and why. */
  suspended: Map<string, Why>;
  schedule: { id: string; name: string; until: number } | null;
  limits: LimitNow[];
}

const screenZone = (policy: Policy | null, phoneZone: string): string => {
  const zone = policy?.screen_time?.zone ?? "phone";
  return zone !== "phone" && isValidTimeZone(zone) ? zone : phoneZone;
};

/** The schedule on now, if any: one that started today, or yesterday and runs past midnight. */
function scheduleNow(policy: Policy, now: number, zone: string): Enforced["schedule"] {
  const today = dateIn(now, zone);
  for (const s of policy.screen_time?.schedules ?? []) {
    const start = clockMinutes(s.start) ?? 0;
    const end = clockMinutes(s.end) ?? 0;
    for (const day of [today, addDays(today, -1)]) {
      if (!s.days.includes(weekdayOf(day)) || s.skip.includes(day)) continue;
      const from = at(day, start, zone);
      const until = end > start ? at(day, end, zone) : at(addDays(day, 1), end, zone);
      if (from <= now && now < until) return { id: s.id, name: s.name, until };
    }
  }
  return null;
}

/**
 * What the policy makes the phone do now: the apps it holds suspended, the schedule on, and where
 * each limit stands, from the minutes the phone counted today. The never-blocked apps are never
 * held, whatever the policy says; a pause and a schedule leave the clock and the keyboard alone.
 */
export function enforce(policy: Policy | null, apps: readonly Package[], now: number, phoneZone: string, usage: (day: string) => UsageDay | undefined): Enforced {
  const zone = screenZone(policy, phoneZone);
  const st = policy?.screen_time ?? null;
  const day = dayAt(now, dayClock(zone, st?.day_starts ?? "00:00"));
  const suspended = new Map<string, Why>();
  if (!policy) return { day, suspended, schedule: null, limits: [] };
  const never = new Set(NEVER_BLOCKED);
  const kept = new Set(KEPT_OPEN);
  const exempt = new Set(st?.exempt ?? []);
  const decisions = new Map(policy.apps.decisions.map((d) => [d.package, d.state]));
  const counted = usage(day);
  const minutesOf = (pkg: string) => counted?.apps.find((a) => a.package === pkg)?.minutes ?? 0;
  const limits: LimitNow[] = (st?.limits ?? []).map((l) => {
    const base = l.by_day?.[weekdayOf(day)] ?? l.minutes;
    const extra = (st?.extra ?? []).filter((x) => x.day === day && (x.limit_id === l.id || x.limit_id === "*")).reduce((n, x) => n + x.minutes, 0);
    const every = l.packages.includes("*");
    const used = every ? (counted?.apps ?? []).filter((a) => !exempt.has(a.package)).reduce((n, a) => n + a.minutes, 0) : l.packages.reduce((n, p) => n + minutesOf(p), 0);
    const allowed = base + extra;
    const left = Math.max(0, allowed - used);
    return { id: l.id, name: l.name, allowed, used, left, state: left === 0 ? "used_up" : used >= base && extra > 0 ? "extra" : "open" };
  });
  const usedUp = new Set(limits.filter((l) => l.state === "used_up").map((l) => l.id));
  const limited = (pkg: string) => (st?.limits ?? []).some((l) => usedUp.has(l.id) && (l.packages.includes(pkg) || (l.packages.includes("*") && !exempt.has(pkg))));
  const paused = policy.pause !== null && (policy.pause.until === null || policy.pause.until > now);
  const schedule = st ? scheduleNow(policy, now, zone) : null;
  const allowedBySchedule = new Set(st?.schedules.find((s) => s.id === schedule?.id)?.allow ?? []);
  for (const app of apps) {
    const pkg = app.package;
    if (never.has(pkg)) continue;
    const decision = decisions.get(pkg);
    if (decision === "blocked") suspended.set(pkg, "blocked");
    else if (!app.system && decision !== "allowed" && policy.apps.new_apps === "ask") suspended.set(pkg, "waiting");
    else if (!app.launchable || kept.has(pkg)) continue;
    else if (paused) suspended.set(pkg, "paused");
    else if (schedule && !exempt.has(pkg) && !allowedBySchedule.has(pkg)) suspended.set(pkg, "schedule");
    else if (limited(pkg)) suspended.set(pkg, "limit");
  }
  return { day, suspended, schedule, limits };
}

// ── The phone ───────────────────────────────────────────────────────────

export interface SimPhoneOptions {
  /** The server's address, like http://127.0.0.1:8080. */
  server: string;
  /** The phone's timezone (IANA). */
  zone: string;
  state: PhoneState;
  fetch?: typeof fetch;
  now?: () => number;
  /** Keeps the phone's state (the demo's directory); called after each change. */
  save?: (state: PhoneState) => void;
  /** What the phone did, a line at a time, for the demo's terminal. */
  log?: (line: string) => void;
}

/** Apps held for one reason, for the demo's terminal: "Lantern Chat is off during Bedtime", "12 apps are paused". */
function heldWords(labels: string[], why: Why, e: Enforced): string {
  const one = labels.length === 1;
  const who = labels.length <= 3 ? labels.join(", ") : `${String(labels.length)} apps`;
  const is = one ? "is" : "are";
  switch (why) {
    case "waiting":
      return `${who} ${one ? "waits" : "wait"} for a parent`;
    case "blocked":
      return `${who} ${is} blocked (hidden)`;
    case "paused":
      return `${who} ${is} paused`;
    case "schedule":
      return `${who} ${is} off during ${e.schedule?.name ?? "a schedule"}`;
    case "limit":
      return `${who} ${is} off: ${one ? "its" : "their"} time is up today`;
  }
}

export class SimPhone {
  readonly state: PhoneState;
  readonly zone: string;
  private readonly server: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly save: (state: PhoneState) => void;
  private readonly log: (line: string) => void;
  private queue: Promise<unknown> = Promise.resolve();
  private running = false;
  private abort: AbortController | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private loop: Promise<void> | null = null;
  private quietUntil = 0;
  /** What the phone held, and the schedule on, when it last said so: the minute's recheck compares with it. */
  private held: { suspended: Map<string, Why>; schedule: string | null } | null = null;

  constructor(opts: SimPhoneOptions) {
    this.server = opts.server;
    this.zone = opts.zone;
    this.state = opts.state;
    this.fetchFn = opts.fetch ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.save = opts.save ?? (() => undefined);
    this.log = opts.log ?? (() => undefined);
  }

  get name(): string {
    return this.state.name ?? "The phone";
  }

  // ── The device API ────────────────────────────────────────────────────

  /** One device API call; the answer's JSON (null for 204), or PhoneError. Answers may gain fields the phone ignores. */
  private async call(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<{ status: number; body: unknown }> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.state.token) headers.authorization = `Bearer ${this.state.token}`;
    let res: Response;
    try {
      res = await this.fetchFn(new URL(path, this.server), { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal });
    } catch (error) {
      if (signal?.aborted) throw new PhoneError(0, "aborted", "stopped");
      throw new PhoneError(0, "unreachable", `couldn't reach the server (${error instanceof Error ? error.message : "error"})`);
    }
    if (res.status === 204) return { status: 204, body: null };
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? (JSON.parse(text) as unknown) : null;
    } catch {
      json = null;
    }
    if (!res.ok) {
      const err = (json ?? {}) as { error?: string; error_description?: string };
      const retry = Number(res.headers.get("retry-after"));
      throw new PhoneError(res.status, err.error ?? "error", `${method} ${path}: ${String(res.status)} ${err.error_description ?? ""}`.trim(), Number.isFinite(retry) && retry > 0 ? retry : null);
    }
    return { status: res.status, body: json };
  }

  /** Enrolls with a code from the Add a phone page (or the CLI's create-code). */
  async enroll(code: string): Promise<void> {
    const body = (await this.call("POST", "/api/v1/enroll", { code, device: this.facts() })).body as { device_id: string; device_name: string; token: string } | null;
    if (!body) throw new PhoneError(0, "invalid", "enroll: no answer");
    this.state.token = body.token;
    this.state.deviceId = body.device_id;
    this.state.name = body.device_name;
    this.save(this.state);
  }

  /** Checks in with the phone's facts and what it enforces; the answer's policy is applied if it's new. */
  async checkin(): Promise<void> {
    for (let round = 0; round < 3; round++) {
      const body = (await this.call("POST", "/api/v1/checkin", { status: this.facts() })).body as { policy: Policy } | null;
      this.state.lastCheckinAt = this.now();
      this.save(this.state);
      // A new version (the results it reported leave the policy, say): applied, then reported.
      if (!body || body.policy.version === this.state.policy?.version) return;
      this.apply(body.policy);
    }
  }

  /** The phone's whole app list. Its changes are sent first: the server diffs the list against what it knows. */
  async sendInventory(): Promise<void> {
    await this.sendEvents();
    const now = this.now();
    await this.call("POST", "/api/v1/inventory", { snapshot_id: randomUUID(), taken_at: now, boot_count: this.state.bootCount, device: this.facts(), packages: this.state.apps });
    this.state.lastInventoryAt = now;
    this.save(this.state);
  }

  private async sendEvents(): Promise<void> {
    while (this.state.outbox.events.length) {
      const batch = this.state.outbox.events.slice(0, 1000);
      await this.call("POST", "/api/v1/events", { events: batch });
      this.state.outbox.events.splice(0, batch.length);
      this.save(this.state);
    }
  }

  /** Sends what waits in the outbox: app changes, the kid's requests, screen time and calls. */
  async flush(): Promise<void> {
    await this.sendEvents();
    const { outbox } = this.state;
    if (outbox.requests.length) {
      const batch = outbox.requests.slice(0, 100);
      await this.call("POST", "/api/v1/requests", { requests: batch });
      outbox.requests.splice(0, batch.length);
      this.save(this.state);
    }
    // Screen time only while a parent has measuring on, and calls only while they're recorded.
    if (!this.state.policy?.screen_time?.measure) outbox.usage = [];
    if (outbox.usage.length) {
      const batch = outbox.usage.slice(0, 31);
      await this.call("POST", "/api/v1/usage", { days: batch });
      outbox.usage.splice(0, batch.length);
      this.save(this.state);
    }
    if (!this.state.policy?.calls?.log) outbox.calls = [];
    if (outbox.calls.length) {
      const batch = outbox.calls.slice(0, 500);
      await this.call("POST", "/api/v1/calls", { calls: batch });
      outbox.calls.splice(0, batch.length);
      this.save(this.state);
    }
  }

  /** Asks for the policy (holding the request up to `wait` seconds for a change): the new one, or null. */
  async fetchPolicy(wait = 0, signal?: AbortSignal): Promise<Policy | null> {
    const have = this.state.policy?.version ?? -1;
    const body = (await this.call("GET", `/api/v1/policy?have=${String(have)}&wait=${String(wait)}`, undefined, signal)).body as { policy: Policy } | null;
    return body?.policy ?? null;
  }

  /** A new policy applied, then reported in a check-in, as the agent does within seconds. */
  async take(policy: Policy | null): Promise<boolean> {
    if (!policy || policy.version === this.state.policy?.version) return false;
    this.apply(policy);
    await this.checkin();
    return true;
  }

  /** The long-poll once, without waiting: whether a new policy came (and was applied and reported). */
  async sync(): Promise<boolean> {
    return this.take(await this.fetchPolicy(0));
  }

  // ── Applying the policy ───────────────────────────────────────────────

  private enforced(at = this.now()): Enforced {
    return enforce(this.state.policy, this.state.apps, at, this.zone, (day) => this.state.usage[day]);
  }

  private label(pkg: string): string {
    return this.state.apps.find((a) => a.package === pkg)?.label ?? pkg;
  }

  /** Applies a policy: the apps it holds, the commands it runs once, the answers the kid sees. */
  apply(policy: Policy): void {
    const now = this.now();
    const before = this.held?.suspended ?? (this.state.policy ? this.enforced(now).suspended : new Map<string, Why>());
    const first = this.state.policy === null;
    const was = this.state.policy;
    this.state.policy = policy;
    this.state.appliedAt = now;
    const ran = this.runCommands(policy, now);
    const answered: string[] = [];
    for (const answer of policy.requests) {
      const mine = this.state.asked[answer.id];
      if (!mine || mine.status === answer.status) continue;
      mine.status = answer.status;
      mine.note = answer.note;
      if (answer.status !== "pending") answered.push(`${mine.about}: ${answer.status === "talk" ? "let's talk" : answer.status}${answer.note ? ` ("${answer.note}")` : ""}`);
    }
    // Days not sent yet are dropped when measuring goes off, and calls not sent when recording does.
    if (!policy.screen_time?.measure) this.state.outbox.usage = [];
    if (!policy.calls?.log) this.state.outbox.calls = [];
    this.save(this.state);
    const e = this.enforced(now);
    const news = [...this.changes(before, e, first), ...this.cannot(was, policy), ...ran];
    this.held = { suspended: e.suspended, schedule: e.schedule?.id ?? null };
    if (answered.length) news.push(`${this.kid()} sees your answer: ${answered.join("; ")}`);
    // A new version can change nothing the phone shows: a lock's result, reported, leaves the rules, say.
    const applied = `applied the rules (version ${String(policy.version)})`;
    this.log(`${this.name}: ${news.length ? [applied, ...news.map(sentence)].join(". ") : `${applied}: nothing new on the phone`}.`);
  }

  /** What a parent just turned on that this phone can't do, in words: it reports each as a problem too. */
  private cannot(was: Policy | null, policy: Policy): string[] {
    const located = (p: Policy | null) => p?.location != null && (p.location.mode !== "off" || p.location.lost !== null);
    const words: string[] = [];
    if (located(policy) && !located(was)) words.push("location is on, but it has no GPS: it can't share where it is");
    if (policy.network_log.enabled && !was?.network_log.enabled) words.push("network logging is on, but it can't note which websites its apps look up");
    const update = policy.agent_update;
    if (update && update.sha256 !== was?.agent_update?.sha256) words.push(`couldn't install Belay ${update.version_name ?? `version ${String(update.version_code)}`}: it can't install a new version`);
    return words;
  }

  /** What changed on the phone, in words: the apps held now, and why, and the ones that run again. */
  private changes(before: Map<string, Why>, e: Enforced, first: boolean): string[] {
    const changes: string[] = [];
    const byWhy = new Map<Why, string[]>();
    for (const [pkg, why] of e.suspended) {
      const was = before.get(pkg);
      if (was === why || (first && why === "waiting")) continue;
      // Allowed now, but held for another reason (a bedtime, say): both, so it doesn't read as refused.
      if ((was === "waiting" || was === "blocked") && why !== "waiting" && why !== "blocked") changes.push(`${this.label(pkg)} is allowed now; ${heldWords(["it"], why, e)}`);
      else byWhy.set(why, [...(byWhy.get(why) ?? []), this.label(pkg)]);
    }
    for (const [why, labels] of byWhy) changes.push(heldWords(labels, why, e));
    const freed = [...before.keys()].filter((pkg) => !e.suspended.has(pkg) && this.state.apps.some((a) => a.package === pkg)).map((pkg) => this.label(pkg));
    if (freed.length) changes.push(`${freed.length <= 3 ? freed.join(", ") : `${String(freed.length)} apps`} ${freed.length === 1 ? "runs" : "run"} now`);
    return changes;
  }

  /**
   * What the agent does as the clock moves, with no new rules: a schedule starts or ends, a pause
   * runs out, a limit is used up. Each minute the phone looks again; when what it holds changed, it
   * says so and checks in early, so the parent page shows it within a minute. A schedule that locks
   * locks the screen as it starts.
   */
  async recheck(): Promise<void> {
    const e = this.enforced();
    const before = this.held;
    this.held = { suspended: e.suspended, schedule: e.schedule?.id ?? null };
    if (!before || !this.state.policy) return;
    const news = this.changes(before.suspended, e, false);
    const started = e.schedule && e.schedule.id !== before.schedule ? this.state.policy.screen_time?.schedules.find((s) => s.id === e.schedule?.id) : undefined;
    if (started?.lock) news.push(`locked the screen: ${started.name} started`);
    if (!news.length) return;
    this.log(`${this.name}: ${news.map(sentence).join(". ")}.`);
    await this.checkin();
  }

  private kid(): string {
    const name = this.state.name ?? "";
    return name.endsWith("'s phone") ? name.slice(0, -"'s phone".length) : "The kid";
  }

  /** Each command once per id; its result goes in the next check-in. */
  private runCommands(policy: Policy, now: number): string[] {
    const ran: string[] = [];
    for (const command of policy.commands) {
      if (this.state.results.some((r) => r.id === command.id)) continue;
      // A newer server may send a kind this phone doesn't know: it's reported failed, not run.
      const kind: string = command.kind;
      let result: CommandResult;
      if (command.expires_at !== null && command.expires_at < now) result = { id: command.id, result: "expired", at: now, problem: null };
      else if (kind === "lock_now") {
        result = { id: command.id, result: "done", at: now, problem: null };
        ran.push("locked the screen (lock now)");
      } else if (kind === "remove_other_users") {
        result = { id: command.id, result: "done", at: now, problem: null };
        ran.push("removed other users (it has none)");
      } else if (kind === "locate_now") {
        result = { id: command.id, result: "failed", at: now, problem: SAYS.noGps };
        ran.push("couldn't check where it is: it has no GPS");
      } else result = { id: command.id, result: "failed", at: now, problem: SAYS.unknownCommand };
      this.state.results = [result, ...this.state.results].slice(0, 20);
    }
    return ran;
  }

  // ── What the phone reports ────────────────────────────────────────────

  /** The phone's facts and health, and what it enforces (docs/protocol.md, "Device"). */
  facts(): Device {
    const now = this.now();
    const battery = batteryAt(now, this.zone);
    return {
      // A made-up maker, like the apps' org.example: Belay makes no phones.
      manufacturer: "Example",
      model: "Demo phone (simulated)",
      android_release: "17",
      sdk: 37,
      sdk_full: "37.0",
      security_patch: patchFor(now),
      agent_version_name: BELAY_APP.versionName,
      agent_version_code: BELAY_APP.versionCode,
      boot_count: this.state.bootCount,
      last_boot_at: this.state.lastBootAt,
      timezone: this.zone,
      device_time: now,
      battery_percent: battery.percent,
      charging: battery.charging,
      storage_free_bytes: 71_400_000_000 - this.state.apps.length * 150_000_000,
      storage_total_bytes: 128_000_000_000,
      health: {
        device_owner: true,
        uninstall_blocked: true,
        battery_exempt: true,
        usage_access: true,
        notifications_shown: true,
        permissions: [{ name: "POST_NOTIFICATIONS", granted: true, fixed_by_policy: true }],
        standby_bucket: 5,
        background_restricted: false,
        service_running: true,
        test_only: false,
        other_users: 0,
        foreign_restrictions: [],
      },
      enforcement: this.enforcement(now),
    };
  }

  private enforcement(now: number): Enforcement | null {
    const policy = this.state.policy;
    if (!policy) return null;
    const e = this.enforced(now);
    const st = policy.screen_time;
    const measure = st?.measure === true;
    const today = this.state.usage[e.day];
    const location = policy.location !== null && (policy.location.mode !== "off" || policy.location.lost !== null);
    return {
      policy_version: policy.version,
      applied_at: this.state.appliedAt,
      suspended_count: e.suspended.size,
      problems: policy.network_log.enabled ? [SAYS.noNetworkLog] : [],
      agent_update: policy.agent_update ? { version_code: policy.agent_update.version_code, state: "failed", problem: SAYS.noUpdate, at: this.state.appliedAt ?? now } : null,
      recovery: null,
      commands: this.state.results.map((r) => ({ id: r.id, result: r.result, at: r.at, problem: r.problem })),
      never_blocked: [...NEVER_BLOCKED],
      screen_time: st
        ? {
            day: e.day,
            measured: true,
            used_minutes: measure ? Math.min(1500, today?.screen_minutes ?? 0) : null,
            limits: e.limits.map((l) => ({ id: l.id, used: measure ? Math.min(1500, l.used) : null, left: measure ? Math.min(1500, l.left) : null, state: l.state })),
            schedule: e.schedule ? { id: e.schedule.id, until: e.schedule.until } : null,
            self_serve: [],
          }
        : null,
      network_log: policy.network_log.enabled ? { enabled: false, paused: false } : null,
      location: location ? { permission: true, location_on: true, last_fix_at: null, problem: SAYS.noGps } : null,
      calls: policy.calls ? { dialer: true, problem: null } : null,
    };
  }

  /** The apps held suspended or hidden now, and why. */
  suspended(): Map<string, Why> {
    return this.enforced().suspended;
  }

  // ── What happens on the phone ─────────────────────────────────────────

  private newEvent(kind: Event["kind"], app: Package, extra: Partial<Event>): Event {
    return { id: randomUUID(), kind, package: app.package, label: app.label, detected_at: this.now(), detection: "broadcast", ...extra };
  }

  /** The kid installs an app. A new one that waits for a parent asks for them at once, without a reason: its request's id. */
  install(app: DemoApp): string | null {
    const now = this.now();
    const pkg = packageOf(app, now);
    this.state.apps = [...this.state.apps.filter((a) => a.package !== pkg.package), pkg];
    this.state.outbox.events.push(this.newEvent("installed", pkg, { to: { name: pkg.version_name, code: pkg.version_code }, happened_at: now, app: pkg }));
    this.rehold(pkg.package);
    let id: string | null = null;
    if (this.suspended().get(pkg.package) === "waiting") {
      id = randomUUID();
      this.state.outbox.requests.push({ id, kind: "app", package: pkg.package, label: pkg.label, reason: null, asked_at: now });
      this.state.asked[id] = { kind: "app", about: pkg.label, package: pkg.package, status: "pending", note: null };
    }
    this.save(this.state);
    return id;
  }

  /** An app installed or removed: what the phone holds of it changes at once, as on a real phone. */
  private rehold(pkg: string): void {
    if (!this.held) return;
    const why = this.enforced().suspended.get(pkg);
    if (why) this.held.suspended.set(pkg, why);
    else this.held.suspended.delete(pkg);
  }

  /** An app updates itself. */
  update(pkgName: string, versionName: string, versionCode: number): void {
    const now = this.now();
    const old = this.state.apps.find((a) => a.package === pkgName);
    if (!old) return;
    const pkg: Package = { ...old, version_name: versionName, version_code: versionCode, last_update_time: now };
    this.state.apps = this.state.apps.map((a) => (a.package === pkgName ? pkg : a));
    this.state.outbox.events.push(this.newEvent("updated", pkg, { from: { name: old.version_name, code: old.version_code }, to: { name: versionName, code: versionCode }, happened_at: now, app: pkg }));
    this.save(this.state);
  }

  /** The kid removes an app. */
  remove(pkgName: string): void {
    const old = this.state.apps.find((a) => a.package === pkgName);
    if (!old) return;
    this.state.apps = this.state.apps.filter((a) => a.package !== pkgName);
    this.rehold(pkgName);
    this.state.outbox.events.push(this.newEvent("removed", old, { from: { name: old.version_name, code: old.version_code }, happened_at: null }));
    this.save(this.state);
  }

  /** The kid writes why, in "Why I want it": the same request, sent again with the reason. */
  explain(requestId: string, reason: string): void {
    const sent = this.state.outbox.requests.find((r) => r.id === requestId);
    const mine = this.state.asked[requestId];
    if (!mine || mine.kind !== "app" || mine.status !== "pending") return;
    if (sent) sent.reason = reason;
    else if (mine.package) this.state.outbox.requests.push({ id: requestId, kind: "app", package: mine.package, label: mine.about, reason, asked_at: this.now() });
    this.save(this.state);
  }

  /** "Ask for more time", from a limit's "Time's up": its request's id. */
  askMoreTime(limitId: string, minutes: number, reason: string, pkg: string | null = null): string {
    const id = randomUUID();
    const name = this.state.policy?.screen_time?.limits.find((l) => l.id === limitId)?.name ?? "a limit";
    this.state.outbox.requests.push({ id, kind: "more_time", limit_id: limitId, minutes, package: pkg, reason, asked_at: this.now() });
    this.state.asked[id] = { kind: "more_time", about: `${String(minutes)} more minutes of ${name}`, package: pkg, status: "pending", note: null };
    this.save(this.state);
    return id;
  }

  /** The kid's answer to the family agreement. */
  answerAgreement(version: number, answer: "agree" | "talk", reason: string | null = null): string {
    const id = randomUUID();
    this.state.outbox.requests.push({ id, kind: "agreement", version, answer, reason, asked_at: this.now() });
    this.state.asked[id] = { kind: "agreement", about: "the family agreement", package: null, status: answer === "agree" ? "approved" : "pending", note: null };
    this.save(this.state);
    return id;
  }

  /** A call, recorded only while the policy records calls: the contact, or the number of someone who isn't one. */
  recordCall(call: { at: number; direction: "in" | "out"; number: string | null; seconds: number; outcome: CallRecord["outcome"]; reason?: CallRecord["reason"] }): void {
    const policy = this.state.policy;
    if (!policy?.calls?.log) return;
    const contact = call.number === null ? undefined : policy.contacts.find((c) => c.numbers.includes(call.number ?? ""));
    this.state.outbox.calls.push({
      id: randomUUID(),
      at: call.at,
      direction: call.direction,
      contact_id: contact?.id ?? null,
      number: contact ? null : call.number,
      duration_s: call.seconds,
      outcome: call.outcome,
      reason: call.reason ?? null,
    });
    this.save(this.state);
  }

  /** What the phone counted for a day (the demo's history hands it a whole day): kept, and sent while measuring is on. */
  recordUsage(day: UsageDay): void {
    this.state.usage[day.day] = day;
    // A newer report of a day takes the place of one not sent yet.
    this.state.outbox.usage = [...this.state.outbox.usage.filter((d) => d.day !== day.day), day];
    const keep = new Set([day.day, addDays(day.day, -1)]);
    for (const d of Object.keys(this.state.usage)) if (!keep.has(d) && d < day.day) Reflect.deleteProperty(this.state.usage, d);
    this.save(this.state);
  }

  /** The phone restarted: a new boot count, and its app list goes again after it. */
  reboot(): void {
    this.state.bootCount += 1;
    this.state.lastBootAt = this.now();
    this.save(this.state);
  }

  // ── Running on its own, as the agent does ────────────────────────────

  /** One step at a time, like the agent's single thread: a failure is logged, and tried again later. */
  private task(what: string, run: () => Promise<unknown>): Promise<void> {
    const next = this.queue.then(run).then(
      () => undefined,
      (error: unknown) => {
        this.trouble(what, error);
      },
    );
    this.queue = next;
    return next;
  }

  private trouble(what: string, error: unknown): void {
    if (!this.running) return;
    if (error instanceof PhoneError && error.status === 401) {
      this.log(`${this.name}: the server says this phone isn't connected any more (a parent disconnected it). It stops syncing, as a real phone does.`);
      void this.stop();
      return;
    }
    // One line a minute at most, while the server can't be reached.
    if (this.now() < this.quietUntil) return;
    this.quietUntil = this.now() + 60_000;
    this.log(`${this.name}: couldn't ${what} (${error instanceof Error ? error.message : "error"}); it tries again.`);
  }

  /**
   * Starts the phone on its own: it sends what waits, checks in, sends its app list after a
   * restart or a day, then holds the long-poll, checks in every 2 hours, sends its app list every
   * day and today's screen time every 15 minutes, and looks at its rules again every minute.
   */
  start(opts: { rebooted: boolean }): void {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    const stale = this.state.lastInventoryAt === null || this.now() - this.state.lastInventoryAt > INVENTORY_MS - 3_600_000;
    void this.task("start", async () => {
      this.countUsage();
      await this.flush();
      await this.checkin();
      if (opts.rebooted || stale) await this.sendInventory();
      await this.recheck();
    });
    this.timers.push(
      setInterval(() => void this.task("check in", () => this.checkin()), CHECKIN_MS),
      setInterval(() => void this.task("send its app list", () => this.sendInventory()), INVENTORY_MS),
      setInterval(
        () =>
          void this.task("send screen time", async () => {
            this.countUsage();
            await this.flush();
          }),
        USAGE_MS,
      ),
      setInterval(() => void this.task("look at its rules again", () => this.recheck()), RECHECK_MS),
    );
    this.loop = this.pollLoop(this.abort.signal);
  }

  /** The long-poll, again and again: a parent's change reaches the phone within a second or two. */
  private async pollLoop(signal: AbortSignal): Promise<void> {
    let backoff = 1000;
    while (this.running) {
      try {
        const policy = await this.fetchPolicy(LONG_POLL_SECONDS, signal);
        if (policy) await this.task("apply the rules", () => this.take(policy));
        backoff = 1000;
      } catch (error) {
        if (signal.aborted) return;
        this.trouble("ask for its rules", error);
        const wait = error instanceof PhoneError && error.retryAfterSeconds !== null ? error.retryAfterSeconds * 1000 : backoff;
        await sleep(wait, signal);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  /** Stops the long-poll and the timers, and waits for the step under way. */
  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    await this.loop;
    await this.queue;
    this.save(this.state);
  }

  /**
   * Today's screen time, counted as the phone runs: a few minutes in an app that's open now,
   * between 7 in the morning and 9 at night, never past a limit. Yesterday's day is completed.
   */
  countUsage(random: () => number = Math.random): void {
    const now = this.now();
    const policy = this.state.policy;
    if (!policy?.screen_time) return;
    const zone = screenZone(policy, this.zone);
    const clock = dayClock(zone, policy.screen_time.day_starts);
    const e = this.enforced(now);
    const day = e.day;
    const yesterday = this.state.usage[addDays(day, -1)];
    if (yesterday && !yesterday.complete) this.recordUsage({ ...yesterday, complete: true, as_of: endOf(yesterday.day, clock) });
    const today: UsageDay = structuredClone(this.state.usage[day] ?? emptyDay(day, zone, startOf(day, clock)));
    const local = zoned(now, zone);
    const open = this.state.apps.filter((a) => !a.system && a.launchable && a.package !== BELAY_APP.package && !e.suspended.has(a.package));
    const hour = local.hour;
    if (hour >= 7 && hour < 21 && open.length && random() < 0.7) {
      const app = open[Math.floor(random() * open.length)];
      if (app) {
        const limit = e.limits.find((l) => policy.screen_time?.limits.find((x) => x.id === l.id)?.packages.some((p) => p === app.package || p === "*"));
        const minutes = Math.min(2 + Math.floor(random() * 5), limit ? limit.left : 60, 60 - (today.by_hour[hour] ?? 0));
        if (minutes > 0) {
          const entry = today.apps.find((a) => a.package === app.package);
          if (entry) {
            entry.minutes += minutes;
            entry.opens += 1;
          } else today.apps.push({ package: app.package, minutes, opens: 1 });
          today.apps.sort((a, b) => b.minutes - a.minutes);
          today.screen_minutes = Math.min(1500, today.screen_minutes + minutes);
          today.by_hour[hour] = (today.by_hour[hour] ?? 0) + minutes;
          today.unlocks += 1;
        }
      }
    }
    today.as_of = Math.max(today.as_of, now);
    this.recordUsage(today);
  }
}

/** "13 apps are paused" stays, "locked the screen" becomes "Locked the screen": each part is a sentence. */
const sentence = (words: string): string => words.charAt(0).toUpperCase() + words.slice(1);

/** An empty day of usage, counted from its start. */
export function emptyDay(day: string, zone: string, from: number): UsageDay {
  return { day, zone, as_of: from, complete: false, screen_minutes: 0, unlocks: 0, by_hour: Array.from({ length: 24 }, () => 0), apps: [], gaps: [] };
}

/** On the charger in the kitchen from 9:30 at night until 6:30 in the morning, as the agreement says. */
export function batteryAt(now: number, zone: string): { percent: number; charging: boolean } {
  const local = zoned(now, zone);
  const minute = local.hour * 60 + local.minute;
  const night = minute >= 21 * 60 + 30 || minute < 6 * 60 + 30;
  if (night) {
    const charged = (minute >= 21 * 60 + 30 ? minute - (21 * 60 + 30) : minute + 150) * 0.5;
    return { percent: Math.min(100, Math.round(40 + charged)), charging: true };
  }
  return { percent: Math.max(15, Math.round(100 - ((minute - (6 * 60 + 30)) * 60) / 900)), charging: false };
}

/** A recent security patch, the 5th of a month, as Pixels get them. */
function patchFor(now: number): string {
  const month = new Date(now - 10 * 86_400_000);
  return `${String(month.getUTCFullYear())}-${String(month.getUTCMonth() + 1).padStart(2, "0")}-05`;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
