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
  };
}
