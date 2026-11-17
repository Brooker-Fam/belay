/**
 * Options for the server's ops work (backups, health, notices), per server: where the backup
 * passphrase comes from, and for tests the scrypt cost and the disk's space. Production sets
 * none, so everything reads process.env and the real disk.
 */
import type { Deps } from "../deps.js";
import type { DiskSpace } from "./backups.js";
import type { ScryptParams } from "./crypt.js";

export interface OpsOptions {
  /** Where BELAY_BACKUP_PASSPHRASE comes from: process.env by default. */
  env?: NodeJS.ProcessEnv;
  scrypt?: ScryptParams;
  /** The data dir's disk: statfs by default. */
  disk?: (path: string) => DiskSpace;
}

const configured = new WeakMap<Deps, OpsOptions>();

export function setOpsOptions(deps: Deps, opts: OpsOptions): void {
  configured.set(deps, opts);
}

export function opsOptions(deps: Deps): OpsOptions {
  return configured.get(deps) ?? {};
}
