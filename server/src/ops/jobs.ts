/**
 * The server's own periodic work, every 5 minutes: the database's size once an hour (to tell
 * when it grows fast), and the daily backup when it's due. Each step is safe to run at any
 * time and never throws, and a slow tick (a large backup being encrypted) is never overlapped
 * by the next one.
 */
import type { Deps } from "../deps.js";
import { backupPassphrase, runDailyBackup } from "./backups.js";
import { sampleDatabaseSize } from "./health.js";
import { opsOptions, setOpsOptions, type OpsOptions } from "./options.js";

export const TICK_MS = 5 * 60_000;

async function step(deps: Deps, what: string, run: () => unknown): Promise<void> {
  try {
    await run();
  } catch (error) {
    deps.log(`The server's ${what} failed: ${error instanceof Error ? error.message : "error"}`);
  }
}

/** One round of the periodic work. */
export async function opsTick(deps: Deps): Promise<void> {
  const opts = opsOptions(deps);
  const env = opts.env ?? process.env;
  await step(deps, "database size sample", () => {
    sampleDatabaseSize(deps.db, deps.now());
  });
  await step(deps, "daily backup", () =>
    runDailyBackup({
      db: deps.db,
      dataDir: deps.config.dataDir,
      now: deps.now,
      passphrase: () => backupPassphrase(env),
      log: deps.log,
      scrypt: opts.scrypt,
      disk: opts.disk,
    }),
  );
}

/** Starts the periodic work, soon after the server starts and then every 5 minutes. Returns what stops it. */
export function startOps(deps: Deps, opts?: OpsOptions): () => void {
  if (opts) setOpsOptions(deps, opts);
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    void opsTick(deps).finally(() => {
      busy = false;
    });
  };
  const first = setTimeout(tick, 20_000);
  const timer = setInterval(tick, TICK_MS);
  first.unref();
  timer.unref();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}
