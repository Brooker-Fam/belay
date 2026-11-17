import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { createWaiters, type Waiters } from "./device/waiters.js";
import { policyVersion } from "./family/policy.js";
import { createLimiters, type Limiters } from "./ratelimit.js";

/** What every part of the server is handed, so tests can swap the clock and the network. */
export interface Deps {
  config: Config;
  db: DB;
  now: () => number;
  limits: Limiters;
  /** Phones waiting for a new policy (the long-poll). */
  waiters: Waiters;
  /**
   * The server's outbound requests: reading the Client ID Metadata Document of an allowlisted
   * AI client (claude.ai's), which carries no family data, and sending Web Push notices to the
   * parents' own browsers, end-to-end encrypted, at the push services those browsers use.
   */
  fetch: typeof fetch;
  log: (message: string) => void;
}

export function makeDeps(config: Config, db: DB, overrides: Partial<Omit<Deps, "config" | "db">> = {}): Deps {
  const now = overrides.now ?? Date.now;
  return {
    config,
    db,
    now,
    limits: overrides.limits ?? createLimiters(now),
    waiters: overrides.waiters ?? createWaiters((deviceId) => policyVersion(db, deviceId)),
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    log:
      overrides.log ??
      ((message) => {
        console.log(message);
      }),
  };
}
