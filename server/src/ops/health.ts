/**
 * The server's own health, in plain words. One tested function, serverProblems, turns facts
 * (the disk, the database's size over time, the backups and their checks, the phones' clocks,
 * a database that couldn't be opened) into the problems a parent should hear about:
 *
 * - The disk holding the data dir has less than 10% free (urgent under 5%).
 * - The database is growing fast: by at least 50 MB and half its size within about a day, or,
 *   at its growth over the last days, the disk would fill within 30 days.
 * - No backup worked for 2 days (urgent), or the last daily backup failed.
 * - The last verify-backup run failed.
 * - The server's clock is off: two or more phones that checked in within a day all report a
 *   clock more than 5 minutes off in the same direction (one phone could be wrong itself).
 * - The database couldn't be opened or upgraded (urgent; see ./degraded.ts).
 *
 * Urgent problems reach the parents by push at once (./notify.ts) and make
 * /healthz?strict=1 answer 503. Nothing here names a phone, an app or anything the kid wrote.
 */
import type { Context } from "hono";
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import type { Device } from "../device/schemas.js";
import { getSettings } from "../settings.js";
import { durations, formatDuration } from "../time.js";
import { type BackupRecord, type CheckRecord, type DiskSpace, databaseBytes, diskSpace, formatBytes, latestBackup, latestCheck } from "./backups.js";
import { opsOptions } from "./options.js";
import { drillCopy } from "./verify.js";
import { dayAndTime, plural } from "./words.js";

const { MINUTE, HOUR, DAY } = durations;

export const LIMITS = {
  diskWarn: 0.1,
  diskUrgent: 0.05,
  backupMaxAgeMs: 2 * DAY,
  /** Growing fast: at least this much, and by half, within about a day. */
  growthBytes: 50 * 1000 * 1000,
  growthShare: 0.5,
  /** ...or the disk would fill within this long at the recent growth. */
  fillWithinMs: 30 * DAY,
  clockToleranceMs: 5 * MINUTE,
  /** A restore drill every 3 months. */
  drillEveryMs: 91 * DAY,
  /** The database's size is sampled once an hour and kept this long. */
  sampleEveryMs: HOUR,
  samplesKeptMs: 8 * DAY,
} as const;

export type ServerProblemCode = "database" | "disk_low" | "backup_old" | "backup_failed" | "backup_check_failed" | "db_growing" | "clock_off";

export interface ServerProblem {
  code: ServerProblemCode;
  /** Urgent: the parents get a push at once (at most once a day), and /healthz?strict=1 answers 503. */
  urgent: boolean;
  /** A sentence for the parent page and MCP. */
  text: string;
  /** A few words for /healthz and the daily summary. */
  short: string;
}

export interface HealthFacts {
  now: number;
  tz: string;
  /** The data dir's filesystem; null when it's unknown (an in-memory database). */
  disk: DiskSpace | null;
  /** The database's size now, and samples of it, oldest first. */
  db: { bytes: number; samples: { at: number; bytes: number }[] } | null;
  backups: {
    /** The newest backup that worked, the daily job's or the backup command's. */
    lastOk: BackupRecord | null;
    /** The daily job's newest try. */
    lastDaily: BackupRecord | null;
    /** Since when there's been data to back up (the first parent's account), or null. */
    since: number | null;
    lastVerify: CheckRecord | null;
  } | null;
  /** Each connected phone's clock minus the server's, for phones heard from within a day. */
  phoneSkews: number[];
  /** Why the database couldn't be opened or upgraded, in a sentence; null when it's fine. */
  database: string | null;
}

/** The server's clock against the phones': its offset (server minus phones) when 2 or more phones agree it's off. */
export function clockOffset(skews: number[]): { phones: number; offMs: number | null } {
  const phones = skews.length;
  if (phones < 2) return { phones, offMs: null };
  const allAhead = skews.every((s) => s > LIMITS.clockToleranceMs);
  const allBehind = skews.every((s) => s < -LIMITS.clockToleranceMs);
  if (!allAhead && !allBehind) return { phones, offMs: 0 };
  const sorted = [...skews].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  return { phones, offMs: -median };
}

function percent(share: number): string {
  return share < 0.01 ? "less than 1%" : `${Math.floor(share * 100)}%`;
}

function growthProblem(db: NonNullable<HealthFacts["db"]>, disk: DiskSpace | null, now: number): ServerProblem | null {
  // Fast: the newest sample from 20 to 48 hours ago.
  const dayAgo = [...db.samples].reverse().find((s) => now - s.at >= 20 * HOUR && now - s.at <= 48 * HOUR);
  if (dayAgo) {
    const grew = db.bytes - dayAgo.bytes;
    if (grew >= LIMITS.growthBytes && grew >= dayAgo.bytes * LIMITS.growthShare) {
      return {
        code: "db_growing",
        urgent: false,
        text: `The database is growing fast: it grew ${formatBytes(grew)} in ${formatDuration(now - dayAgo.at)}, to ${formatBytes(db.bytes)}.`,
        short: "the database is growing fast",
      };
    }
  }
  // Steady, but the disk fills: over the oldest sample at least 2 days old.
  const oldest = db.samples.find((s) => now - s.at >= 2 * DAY);
  if (oldest && disk) {
    const perDay = ((db.bytes - oldest.bytes) / (now - oldest.at)) * DAY;
    if (perDay > 0 && (disk.freeBytes / perDay) * DAY < LIMITS.fillWithinMs) {
      const days = Math.max(1, Math.floor(disk.freeBytes / perDay));
      return {
        code: "db_growing",
        urgent: false,
        text: `The database is growing fast: at its rate over the last ${formatDuration(now - oldest.at)} (${formatBytes(perDay)} a day), the server's disk fills in about ${plural(days, "day")}.`,
        short: "the database is growing fast",
      };
    }
  }
  return null;
}

/** The problems, urgent ones first. */
export function serverProblems(f: HealthFacts): ServerProblem[] {
  const problems: ServerProblem[] = [];
  if (f.database) {
    problems.push({
      code: "database",
      urgent: true,
      text: `${f.database} Belay isn't working until that's fixed: the server's log has the details.`,
      short: "the database couldn't be opened or upgraded",
    });
  }
  if (f.disk && f.disk.totalBytes > 0) {
    const share = f.disk.freeBytes / f.disk.totalBytes;
    const amounts = `${percent(share)} free (${formatBytes(f.disk.freeBytes)} of ${formatBytes(f.disk.totalBytes)})`;
    if (share < LIMITS.diskUrgent) {
      problems.push({
        code: "disk_low",
        urgent: true,
        text: `The server's disk is almost full: ${amounts}. Free some space now: once it's full, Belay can't save anything.`,
        short: `the disk is almost full (${percent(share)} free)`,
      });
    } else if (share < LIMITS.diskWarn) {
      problems.push({ code: "disk_low", urgent: false, text: `The server's disk is getting full: ${amounts}.`, short: `the disk is getting full (${percent(share)} free)` });
    }
  }
  const b = f.backups;
  if (b) {
    const lastTry = b.lastDaily && !b.lastDaily.ok ? b.lastDaily : null;
    const failedBecause = lastTry ? ` The last try (${dayAndTime(lastTry.startedAt, f.now, f.tz)}) failed: ${lastTry.error ?? "no reason recorded"}` : "";
    const reference = b.lastOk?.startedAt ?? b.since;
    if (reference !== null && f.now - reference > LIMITS.backupMaxAgeMs) {
      const age = formatDuration(f.now - reference);
      problems.push({
        code: "backup_old",
        urgent: true,
        text: b.lastOk
          ? `No backup has worked for ${age}: the last one was ${dayAndTime(b.lastOk.startedAt, f.now, f.tz)}.${failedBecause}`
          : `No backup has worked yet, ${age} after the family's data started.${failedBecause}`,
        short: b.lastOk ? `no backup for ${age}` : "no backup yet",
      });
    } else if (lastTry) {
      problems.push({
        code: "backup_failed",
        urgent: false,
        text: `The last daily backup (${dayAndTime(lastTry.startedAt, f.now, f.tz)}) failed: ${lastTry.error ?? "no reason recorded"}`,
        short: "the last backup failed",
      });
    }
    if (b.lastVerify && !b.lastVerify.ok) {
      const why = typeof b.lastVerify.detail?.problem === "string" ? ` ${b.lastVerify.detail.problem}` : "";
      problems.push({
        code: "backup_check_failed",
        urgent: false,
        text: `The last backup check (verify-backup ${b.lastVerify.file ?? ""}, ${dayAndTime(b.lastVerify.at, f.now, f.tz)}) found that it doesn't restore.${why}`,
        short: "the last backup check failed",
      });
    }
  }
  if (f.db) {
    const growing = growthProblem(f.db, f.disk, f.now);
    if (growing) problems.push(growing);
  }
  const clock = clockOffset(f.phoneSkews);
  if (clock.offMs) {
    const off = clock.offMs;
    problems.push({
      code: "clock_off",
      urgent: false,
      text: `The server's clock seems to be about ${formatDuration(Math.abs(off))} ${off > 0 ? "ahead" : "behind"}: all ${clock.phones} phones that checked in today say so. Check the server's time sync (NTP).`,
      short: "the server's clock is off",
    });
  }
  return [...problems.filter((p) => p.urgent), ...problems.filter((p) => !p.urgent)];
}

// ── Gathering the facts ─────────────────────────────────────────────────

/** Records the database's size, at most once an hour, keeping 8 days. */
export function sampleDatabaseSize(db: DB, now: number): void {
  const last = db.prepare<[], { at: number }>("SELECT at FROM db_sizes ORDER BY at DESC LIMIT 1").get();
  if (last && now - last.at < LIMITS.sampleEveryMs - 5 * MINUTE && now >= last.at) return;
  db.prepare("INSERT INTO db_sizes (at, bytes) VALUES (?, ?) ON CONFLICT (at) DO UPDATE SET bytes = excluded.bytes").run(now, databaseBytes(db));
  db.prepare("DELETE FROM db_sizes WHERE at < ?").run(now - LIMITS.samplesKeptMs);
}

function phoneSkews(db: DB, now: number): number[] {
  return db
    .prepare<[number], { facts: string; facts_at: number }>("SELECT facts, facts_at FROM devices WHERE revoked_at IS NULL AND facts IS NOT NULL AND facts_at >= ?")
    .all(now - DAY)
    .flatMap((row) => {
      try {
        const deviceTime = (JSON.parse(row.facts) as Partial<Device>).device_time;
        return typeof deviceTime === "number" ? [deviceTime - row.facts_at] : [];
      } catch {
        return [];
      }
    });
}

export function dataDirDisk(deps: Deps): DiskSpace | null {
  if (deps.config.dataDir === ":memory:") return null;
  try {
    return (opsOptions(deps).disk ?? diskSpace)(deps.config.dataDir);
  } catch {
    return null;
  }
}

export function healthFacts(deps: Deps): HealthFacts {
  const { db } = deps;
  const now = deps.now();
  return {
    now,
    tz: getSettings(db).timezone,
    disk: dataDirDisk(deps),
    db: {
      bytes: databaseBytes(db),
      samples: db.prepare<[number], { at: number; bytes: number }>("SELECT at, bytes FROM db_sizes WHERE at >= ? ORDER BY at").all(now - LIMITS.samplesKeptMs),
    },
    backups: {
      lastOk: latestBackup(db, { ok: true }),
      lastDaily: latestBackup(db, { kind: "daily" }),
      since: db.prepare<[], { at: number | null }>("SELECT MIN(created_at) AS at FROM parents").get()?.at ?? null,
      lastVerify: latestCheck(db, "verify"),
    },
    phoneSkews: phoneSkews(db, now),
    database: null,
  };
}

/** Everything the parent page and MCP show about the server. */
export interface ServerHealth {
  now: number;
  tz: string;
  status: "ok" | "attention" | "urgent";
  problems: ServerProblem[];
  /** The newest backup that worked, and the daily job's newest try. */
  lastBackup: BackupRecord | null;
  lastDaily: BackupRecord | null;
  lastVerify: CheckRecord | null;
  lastDrill: CheckRecord | null;
  drillDue: boolean;
  disk: DiskSpace | null;
  dbBytes: number | null;
  clock: { phones: number; offMs: number | null };
  /** This server is a restore drill's scratch copy. */
  drillCopy: { at: number; from: string } | null;
}

export function serverHealth(deps: Deps): ServerHealth {
  const facts = healthFacts(deps);
  const problems = serverProblems(facts);
  const lastDrill = latestCheck(deps.db, "drill");
  return {
    now: facts.now,
    tz: facts.tz,
    status: problems.some((p) => p.urgent) ? "urgent" : problems.length ? "attention" : "ok",
    problems,
    lastBackup: facts.backups?.lastOk ?? null,
    lastDaily: facts.backups?.lastDaily ?? null,
    lastVerify: facts.backups?.lastVerify ?? null,
    lastDrill,
    drillDue: !lastDrill || facts.now - lastDrill.at > LIMITS.drillEveryMs,
    disk: facts.disk,
    dbBytes: facts.db?.bytes ?? null,
    clock: clockOffset(facts.phoneSkews),
    drillCopy: drillCopy(deps.db),
  };
}

// ── /healthz ────────────────────────────────────────────────────────────

/**
 * What /healthz answers: 200 while the process is up (Docker's healthcheck relies on it), with
 * {"ok": true} or {"ok": false, "reason": "..."}; with ?strict=1, 503 when a problem is urgent,
 * for the family's own uptime monitor. No family data, no login.
 */
export function healthzAnswer(problems: ServerProblem[], strict: boolean): { status: 200 | 503; body: { ok: boolean; reason?: string } } {
  const urgent = problems.find((p) => p.urgent);
  if (strict && urgent) return { status: 503, body: { ok: false, reason: urgent.short } };
  const first = problems[0];
  return { status: 200, body: first ? { ok: false, reason: first.short } : { ok: true } };
}

export function isStrict(c: Context): boolean {
  const value = c.req.query("strict");
  return value !== undefined && value !== "0" && value !== "false";
}

export function healthz(deps: Deps) {
  return (c: Context) => {
    c.header("Cache-Control", "no-store");
    let problems: ServerProblem[];
    try {
      problems = serverProblems(healthFacts(deps));
    } catch (error) {
      deps.log(`The server couldn't check its own health: ${error instanceof Error ? error.message : "error"}`);
      problems = [{ code: "database", urgent: true, text: "The server couldn't check its own health.", short: "the server couldn't check its own health" }];
    }
    const answer = healthzAnswer(problems, isStrict(c));
    return c.json(answer.body, answer.status);
  };
}
