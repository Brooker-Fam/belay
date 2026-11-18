/**
 * In-memory sliding-window limits. One family per server, one process: nothing to share.
 * A restart forgets them, which is fine for slowing down guessing.
 */
export type Verdict = { ok: true } | { ok: false; retryAfterSeconds: number };

export class RateLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    readonly limit: number,
    readonly windowMs: number,
    private readonly now: () => number,
    private readonly maxKeys = 10_000,
  ) {}

  private recent(key: string): number[] {
    const since = this.now() - this.windowMs;
    const list = (this.hits.get(key) ?? []).filter((t) => t > since);
    if (list.length) this.hits.set(key, list);
    else this.hits.delete(key);
    return list;
  }

  /** How many more hits would be allowed now, without counting any. */
  remaining(key: string): number {
    return Math.max(0, this.limit - this.recent(key).length);
  }

  /** Whether `n` more hits would be allowed, without counting them. */
  check(key: string, n = 1): Verdict {
    const list = this.recent(key);
    if (list.length + n <= this.limit) return { ok: true };
    // More than the limit at once never fits: wait a whole window, then it still won't.
    if (n > this.limit) return { ok: false, retryAfterSeconds: Math.ceil(this.windowMs / 1000) };
    const oldest = list[list.length + n - this.limit - 1] ?? this.now();
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000)) };
  }

  /** Counts a hit (or `n` at once), and says whether they were within the limit. Refused hits aren't counted. */
  hit(key: string, n = 1): Verdict {
    const verdict = this.check(key, n);
    if (!verdict.ok) return verdict;
    const list = this.hits.get(key) ?? [];
    for (let i = 0; i < n; i++) list.push(this.now());
    this.hits.delete(key);
    this.hits.set(key, list);
    if (this.hits.size > this.maxKeys) {
      // Forget the least recently hit key.
      const first = this.hits.keys().next();
      if (!first.done) this.hits.delete(first.value);
    }
    return verdict;
  }

  reset(key: string): void {
    this.hits.delete(key);
  }
}

/**
 * How many times an hour one AI connection may check where a phone is, and pause or lock it
 * (pauses and locks counted together), per phone.
 */
export const AI_PER_HOUR = { checks: 6, locks: 6 } as const;

/** Phase 12: how many times an hour one caregiver may check where a phone is, and pause or lock it, per phone: as an AI app. */
export const CARE_PER_HOUR = AI_PER_HOUR;

/** The limits the server applies. */
export interface Limiters {
  /** Failed enrollment codes, per client address. */
  enrollPerClient: RateLimiter;
  /** Failed enrollment codes, from anywhere: guessing from many addresses still runs out. */
  enrollGlobal: RateLimiter;
  /** Failed sign-ins, per client address. */
  loginPerClient: RateLimiter;
  /** Failed sign-ins, per username. */
  loginPerUser: RateLimiter;
  /** Dynamic client registrations, per client address. */
  registerPerClient: RateLimiter;
  /** Token endpoint calls, per client address. */
  tokenPerClient: RateLimiter;
  /** MCP requests, per grant. */
  mcpPerGrant: RateLimiter;
  /** Device API calls, per phone. */
  devicePerPhone: RateLimiter;
  /**
   * Policy long-polls, per phone, counted apart so the loop can't use up the phone's other
   * calls. A phone asks again after each answer: about once a minute while nothing changes.
   */
  policyPerPhone: RateLimiter;
  /** Notices to the parents' browsers about one phone (its requests, AI apps' proposals for it). */
  noticesPerPhone: RateLimiter;
  /** Phase 6: downloads of the offered update, per phone, counted apart: each resumed range is one. */
  agentPerPhone: RateLimiter;
  /**
   * Phase 7: urgent notices of the kid's help requests, per phone, counted apart from the others
   * so a burst of app requests never holds one back; generous, but a flood still stops.
   */
  helpNoticesPerPhone: RateLimiter;
  /** Phase 4: arrival and departure notices, per phone, place and direction: at most one each 10 minutes. */
  placeNotices: RateLimiter;
  /**
   * New requests a phone makes, per phone, help aside (help has its own cap, and is never held
   * back by other requests): what a phone token can make the server keep, and the activity log
   * record, stays small. Past it, the phone is answered 429 and sends the rest later.
   */
  requestsPerPhone: RateLimiter;
  /**
   * Phase 4: new fixes and arrivals or departures a phone makes the server keep, per phone (any
   * reason: a lost-mode or help fix too). Generous for a phone sending a day it spent offline in
   * lost mode; past it, 429.
   */
  locationsPerPhone: RateLimiter;
  /**
   * Phase 5: call records, per phone, counted apart from its other calls, so a phone sending a
   * backlog of records never holds back its check-ins or requests.
   */
  callsPerPhone: RateLimiter;
  /**
   * Phase 3: network days, per phone, counted apart from its other calls, so a phone sending a
   * backlog of days (or Android's batches coming close together) never holds back its check-ins.
   */
  networkPerPhone: RateLimiter;
  /**
   * New app changes a phone makes the server keep, its own events and the changes found in its
   * app lists together (device/apps.ts). Past it they're accepted and not kept, never answered
   * 429: the phone sends its events in the same queue as the kid's requests, and its next app
   * list catches the apps up. A phone that's been offline sends at most 5,000 events.
   */
  appChangesPerPhone: RateLimiter;
  /**
   * What an AI app does that reaches the kid, per connection (grant) and phone (mcp/limits.ts):
   * its checks of where the phone is (`locate_now`: each posts a notice on the kid's phone), and
   * its pauses and locks (`pause_phone` and `lock_phone` together). A few an hour; a parent, on
   * the parent page or the CLI, isn't limited.
   */
  aiChecks: RateLimiter;
  aiLocks: RateLimiter;
  /** One "too many" line in the activity log per connection, phone and kind an hour, however often an AI app tries. */
  aiLimitedLog: RateLimiter;
  /** One "was refused" line in the activity log per connection, phone, tool and reason an hour (mcp/limits.ts's aiRefused). */
  aiRefusedLog: RateLimiter;
  /**
   * Phase 12: what a caregiver does that reaches the kid, per caregiver and phone, as an AI app's
   * (family/caregivers/changes.ts): checks of where the phone is, and pauses and locks together.
   */
  careChecks: RateLimiter;
  careLocks: RateLimiter;
  /** One "too many" line in the activity log per caregiver, phone and kind an hour. */
  careLimitedLog: RateLimiter;
  /**
   * Test notices, per person: a parent's (Settings, `parent:<id>`) and a caregiver's (their page,
   * `care:<id>`), TEST_NOTICES_PER_HOUR each, so a stolen session can't make the server push to
   * its browsers as often as it likes with the family's keys (the seventh review's J9).
   */
  testNotices: RateLimiter;
}

/** Test notices a parent, or a caregiver, may send their own browsers an hour. */
export const TEST_NOTICES_PER_HOUR = 5;

/** Counts a test notice for `key` (Limiters.testNotices): null when it may go, else why not, and when to try again. */
export function testNoticeLimited(limits: Pick<Limiters, "testNotices">, key: string): string | null {
  const verdict = limits.testNotices.hit(key);
  if (verdict.ok) return null;
  const minutes = Math.max(1, Math.ceil(verdict.retryAfterSeconds / 60));
  return `You can send at most ${TEST_NOTICES_PER_HOUR} test notices an hour. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`;
}

export function createLimiters(now: () => number): Limiters {
  const MIN = 60_000;
  return {
    enrollPerClient: new RateLimiter(10, 15 * MIN, now),
    enrollGlobal: new RateLimiter(100, 15 * MIN, now),
    loginPerClient: new RateLimiter(10, 15 * MIN, now),
    loginPerUser: new RateLimiter(10, 15 * MIN, now),
    registerPerClient: new RateLimiter(10, 60 * MIN, now),
    tokenPerClient: new RateLimiter(60, MIN, now),
    mcpPerGrant: new RateLimiter(300, MIN, now),
    devicePerPhone: new RateLimiter(120, MIN, now),
    policyPerPhone: new RateLimiter(30, MIN, now),
    noticesPerPhone: new RateLimiter(6, 60 * MIN, now),
    agentPerPhone: new RateLimiter(30, 60 * MIN, now),
    helpNoticesPerPhone: new RateLimiter(20, 60 * MIN, now),
    placeNotices: new RateLimiter(1, 10 * MIN, now),
    requestsPerPhone: new RateLimiter(300, 60 * MIN, now),
    locationsPerPhone: new RateLimiter(600, 60 * MIN, now),
    callsPerPhone: new RateLimiter(30, MIN, now),
    networkPerPhone: new RateLimiter(30, MIN, now),
    appChangesPerPhone: new RateLimiter(5_000, 60 * MIN, now),
    aiChecks: new RateLimiter(AI_PER_HOUR.checks, 60 * MIN, now),
    aiLocks: new RateLimiter(AI_PER_HOUR.locks, 60 * MIN, now),
    aiLimitedLog: new RateLimiter(1, 60 * MIN, now),
    aiRefusedLog: new RateLimiter(1, 60 * MIN, now),
    careChecks: new RateLimiter(CARE_PER_HOUR.checks, 60 * MIN, now),
    careLocks: new RateLimiter(CARE_PER_HOUR.locks, 60 * MIN, now),
    careLimitedLog: new RateLimiter(1, 60 * MIN, now),
    testNotices: new RateLimiter(TEST_NOTICES_PER_HOUR, 60 * MIN, now),
  };
}
