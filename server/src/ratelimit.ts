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

  /** Whether another hit would be allowed, without counting one. */
  check(key: string): Verdict {
    const list = this.recent(key);
    if (list.length < this.limit) return { ok: true };
    const oldest = list[list.length - this.limit] ?? this.now();
    return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((oldest + this.windowMs - this.now()) / 1000)) };
  }

  /** Counts a hit, and says whether it was within the limit. A refused hit isn't counted. */
  hit(key: string): Verdict {
    const verdict = this.check(key);
    if (!verdict.ok) return verdict;
    const list = this.hits.get(key) ?? [];
    list.push(this.now());
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
  };
}
