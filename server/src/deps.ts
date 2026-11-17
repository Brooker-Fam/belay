import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { createLimiters, type Limiters } from "./ratelimit.js";

/** What every part of the server is handed, so tests can swap the clock and the network. */
export interface Deps {
  config: Config;
  db: DB;
  now: () => number;
  limits: Limiters;
  /**
   * Used only to read the Client ID Metadata Document of an allowlisted AI client
   * (claude.ai's): the server's one outbound request, carrying no family data.
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
    fetch: overrides.fetch ?? ((input, init) => fetch(input, init)),
    log:
      overrides.log ??
      ((message) => {
        console.log(message);
      }),
  };
}
