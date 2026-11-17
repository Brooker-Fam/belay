/**
 * The server's own periodic work, every 5 minutes: the daily backup when it's due. Each step
 * is safe to run at any time and never throws, and a slow tick (a large backup being
 * encrypted) is never overlapped by the next one.
 */
import type { Deps } from "../deps.js";
import { backupPassphrase, runDailyBackup, type DiskSpace } from "./backups.js";
import type { ScryptParams } from "./crypt.js";

export const TICK_MS = 5 * 60_000;

export interface OpsOptions {
  /** Where the backup passphrase comes from (docs/server.md): process.env by default. */
  env?: NodeJS.ProcessEnv;
  /** For tests. */
  scrypt?: ScryptParams;
  disk?: (path: string) => DiskSpace;
}

/** One round of the periodic work. */
export async function opsTick(deps: Deps, opts: OpsOptions = {}): Promise<void> {
  const env = opts.env ?? process.env;
  await runDailyBackup({
    db: deps.db,
    dataDir: deps.config.dataDir,
    now: deps.now,
    passphrase: () => backupPassphrase(env),
    log: deps.log,
    scrypt: opts.scrypt,
    disk: opts.disk,
  });
}

/** Starts the periodic work, soon after the server starts and then every 5 minutes. Returns what stops it. */
export function startOps(deps: Deps, opts: OpsOptions = {}): () => void {
  let busy = false;
  const tick = () => {
    if (busy) return;
    busy = true;
    opsTick(deps, opts)
      .catch((error: unknown) => {
        deps.log(`The server's periodic checks failed: ${error instanceof Error ? error.message : "error"}`);
      })
      .finally(() => {
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
