/** For the ops tests: a server whose data dir is a real (temporary) folder, for backups. Made-up data only. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import type { DailyContext, DiskSpace } from "../src/ops/backups.js";
import { setOpsOptions, type OpsOptions } from "../src/ops/options.js";
import { updateSettings } from "../src/settings.js";
import { testServer, type TestServer } from "./helpers.js";

/** Fast scrypt settings for tests; the header records them, so decrypting needs nothing else. */
export const FAST_SCRYPT = { logN: 10, r: 8, p: 1 };
export const PASSPHRASE = "correct horse battery staple, backed up";
/** A disk with plenty of room: the machine running the tests may have little. */
export const ROOMY_DISK: DiskSpace = { freeBytes: 400e9, totalBytes: 500e9 };

const folders: string[] = [];

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder, deleted after the test. */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belay-ops-test-"));
  folders.push(dir);
  return dir;
}

export interface OpsServer extends TestServer {
  dataDir: string;
}

/**
 * A test server in New York time whose data dir is a scratch folder (its database is still in
 * memory), with a roomy disk, fast scrypt and no backup passphrase unless `ops` says otherwise.
 */
export function opsServer(opts: { fetch?: typeof fetch; ops?: OpsOptions } = {}): OpsServer {
  const dataDir = scratchDir();
  const t = testServer({ config: { dataDir }, fetch: opts.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => ROOMY_DISK, ...opts.ops });
  return Object.assign(t, { dataDir });
}

export function dailyContext(t: OpsServer, extra: Partial<DailyContext> = {}): DailyContext {
  return {
    db: t.deps.db,
    dataDir: t.dataDir,
    now: () => t.now(),
    passphrase: () => null,
    log: (m) => t.logs.push(m),
    scrypt: FAST_SCRYPT,
    disk: () => ROOMY_DISK,
    ...extra,
  };
}
