import { describe, expect, it } from "vitest";
import type { BackupRecord, CheckRecord } from "../src/ops/backups.js";
import { recordBackup, recordCheck } from "../src/ops/backups.js";
import { LIMITS, clockOffset, sampleDatabaseSize, serverHealth, serverProblems, type HealthFacts } from "../src/ops/health.js";
import { opsTick } from "../src/ops/jobs.js";
import { setOpsOptions } from "../src/ops/options.js";
import { device, deviceCall, enrollPhone, get, signIn, testServer, T0 } from "./helpers.js";
import { ROOMY_DISK, opsServer } from "./ops-helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const MB = 1000 * 1000;
const TZ = "America/New_York";

function backup(overrides: Partial<BackupRecord> = {}): BackupRecord {
  return { id: 1, kind: "daily", startedAt: T0 - HOUR, finishedAt: T0 - HOUR, file: "belay-2026-11-16.db", bytes: 2 * MB, dbBytes: 2 * MB, encrypted: false, ok: true, error: null, ...overrides };
}

function facts(overrides: Partial<HealthFacts> = {}): HealthFacts {
  return {
    now: T0,
    tz: TZ,
    disk: ROOMY_DISK,
    db: { bytes: 5 * MB, samples: [] },
    backups: { lastOk: backup(), lastDaily: backup(), since: T0 - 30 * DAY, lastVerify: null },
    phoneSkews: [],
    database: null,
    ...overrides,
  };
}

const codes = (f: HealthFacts) => serverProblems(f).map((p) => `${p.code}${p.urgent ? "!" : ""}`);

describe("the server's health problems", () => {
  it("none when all is well", () => {
    expect(serverProblems(facts())).toEqual([]);
  });

  it("disk free under 10% of the data dir's filesystem, urgent under 5%", () => {
    expect(serverProblems(facts({ disk: { freeBytes: 40e9, totalBytes: 500e9 } }))).toEqual([
      { code: "disk_low", urgent: false, text: "The server's disk is getting full: 8% free (40 GB of 500 GB).", short: "the disk is getting full (8% free)" },
    ]);
    expect(serverProblems(facts({ disk: { freeBytes: 20e9, totalBytes: 500e9 } }))).toEqual([
      {
        code: "disk_low",
        urgent: true,
        text: "The server's disk is almost full: 4% free (20 GB of 500 GB). Free some space now: once it's full, Belay can't save anything.",
        short: "the disk is almost full (4% free)",
      },
    ]);
    expect(serverProblems(facts({ disk: { freeBytes: 1e9, totalBytes: 500e9 } }))[0]?.short).toBe("the disk is almost full (less than 1% free)");
    expect(serverProblems(facts({ disk: null }))).toEqual([]);
  });

  it("no backup that worked for 2 days is urgent, with why the last try failed", () => {
    const old = backup({ startedAt: T0 - 3 * DAY - 8 * HOUR });
    const failed = backup({ startedAt: T0 - 2 * HOUR, ok: false, error: "Not enough free disk space: a backup needs about 70 MB free, and there's 20 MB." });
    expect(serverProblems(facts({ backups: { lastOk: old, lastDaily: failed, since: T0 - 30 * DAY, lastVerify: null } }))).toEqual([
      {
        code: "backup_old",
        urgent: true,
        text: "No backup has worked for 3 days: the last one was Nov 13, 2026, 2:00 AM. The last try (today, 8:00 AM) failed: Not enough free disk space: a backup needs about 70 MB free, and there's 20 MB.",
        short: "no backup for 3 days",
      },
    ]);
    expect(codes(facts({ backups: { lastOk: backup({ startedAt: T0 - 47 * HOUR }), lastDaily: null, since: null, lastVerify: null } }))).toEqual([]);
  });

  it("no backup at all: only 2 days after there's data to back up", () => {
    const none = (since: number | null) => facts({ backups: { lastOk: null, lastDaily: null, since, lastVerify: null } });
    expect(codes(none(null))).toEqual([]);
    expect(codes(none(T0 - DAY))).toEqual([]);
    expect(serverProblems(none(T0 - 3 * DAY))[0]).toMatchObject({ code: "backup_old", urgent: true, text: "No backup has worked yet, 3 days after the family's data started.", short: "no backup yet" });
  });

  it("the last daily backup failing is a warning while a recent one worked", () => {
    const failed = backup({ startedAt: T0 - HOUR, ok: false, error: "disk I/O error" });
    expect(serverProblems(facts({ backups: { lastOk: backup({ startedAt: T0 - DAY }), lastDaily: failed, since: null, lastVerify: null } }))).toEqual([
      { code: "backup_failed", urgent: false, text: "The last daily backup (today, 9:00 AM) failed: disk I/O error", short: "the last backup failed" },
    ]);
  });

  it("a backup check that failed", () => {
    const check: CheckRecord = { id: 1, kind: "verify", at: T0 - DAY, file: "belay-2026-11-15.db.enc", ok: false, detail: { problem: "The passphrase is wrong for this backup." }, parentId: null };
    expect(serverProblems(facts({ backups: { lastOk: backup(), lastDaily: backup(), since: null, lastVerify: check } }))).toEqual([
      {
        code: "backup_check_failed",
        urgent: false,
        text: "The last backup check (verify-backup belay-2026-11-15.db.enc, yesterday, 10:00 AM) found that it doesn't restore. The passphrase is wrong for this backup.",
        short: "the last backup check failed",
      },
    ]);
  });

  it("the database growing fast: by 50 MB and half within a day, or filling the disk within 30 days", () => {
    const grown = (from: number, to: number, ago = DAY) => facts({ db: { bytes: to, samples: [{ at: T0 - ago, bytes: from }] } });
    expect(serverProblems(grown(60 * MB, 130 * MB))).toEqual([
      { code: "db_growing", urgent: false, text: "The database is growing fast: it grew 70 MB in 24 hours, to 130 MB.", short: "the database is growing fast" },
    ]);
    expect(codes(grown(200 * MB, 270 * MB))).toEqual([]);
    expect(codes(grown(10 * MB, 40 * MB))).toEqual([]);
    expect(codes(grown(60 * MB, 130 * MB, 3 * DAY))).toEqual([]);

    // 100 MB a day: 2 GB free fills in 20 days; 5 GB in 50.
    const filling = (freeBytes: number) => facts({ disk: { freeBytes, totalBytes: 10e9 }, db: { bytes: 1400 * MB, samples: [{ at: T0 - 4 * DAY, bytes: 1000 * MB }] } });
    expect(serverProblems(filling(2e9))).toEqual([
      {
        code: "db_growing",
        urgent: false,
        text: "The database is growing fast: at its rate over the last 4 days (100 MB a day), the server's disk fills in about 20 days.",
        short: "the database is growing fast",
      },
    ]);
    expect(codes(filling(5e9))).toEqual([]);
  });

  it("the server's clock: off when 2 or more phones agree, beyond 5 minutes, in the same direction", () => {
    expect(clockOffset([20 * MIN, 22 * MIN])).toEqual({ phones: 2, offMs: -21 * MIN });
    expect(clockOffset([20 * MIN, -MIN])).toEqual({ phones: 2, offMs: 0 });
    expect(clockOffset([20 * MIN])).toEqual({ phones: 1, offMs: null });
    expect(clockOffset([-8 * MIN, -9 * MIN, -30 * MIN])).toEqual({ phones: 3, offMs: 9 * MIN });
    expect(serverProblems(facts({ phoneSkews: [20 * MIN, 22 * MIN] }))).toEqual([
      {
        code: "clock_off",
        urgent: false,
        text: "The server's clock seems to be about 21 minutes behind: all 2 phones that checked in today say so. Check the server's time sync (NTP).",
        short: "the server's clock is off",
      },
    ]);
    expect(codes(facts({ phoneSkews: [4 * MIN, 4 * MIN] }))).toEqual([]);
  });

  it("a database that couldn't be opened comes first, and urgent problems before the rest", () => {
    const f = facts({ database: "Belay couldn't upgrade its database to schema 5.", disk: { freeBytes: 40e9, totalBytes: 500e9 }, phoneSkews: [20 * MIN, 21 * MIN] });
    expect(codes(f)).toEqual(["database!", "disk_low", "clock_off"]);
    expect(serverProblems(f)[0]?.text).toBe("Belay couldn't upgrade its database to schema 5. Belay isn't working until that's fixed: the server's log has the details.");
    expect(codes(facts({ disk: { freeBytes: 40e9, totalBytes: 500e9 }, backups: { lastOk: null, lastDaily: null, since: T0 - 5 * DAY, lastVerify: null } }))).toEqual(["backup_old!", "disk_low"]);
  });
});

describe("the server's health, from the server itself", () => {
  it("phones whose clocks agree the server's is off", async () => {
    const t = opsServer();
    for (const name of ["Phone one", "Phone two"]) {
      const phone = await enrollPhone(t, name);
      await deviceCall(t, phone.token, "checkin", { status: device({ device_time: T0 + 20 * MIN }) });
    }
    const health = serverHealth(t.deps);
    expect(health.clock).toEqual({ phones: 2, offMs: -20 * MIN });
    expect(health.problems.map((p) => p.code)).toEqual(["clock_off"]);
    // A day later, without check-ins, there's nothing to compare.
    t.advance(DAY + MIN);
    expect(serverHealth(t.deps).clock).toEqual({ phones: 0, offMs: null });
  });

  it("no backup 2 days after the first parent: urgent", async () => {
    const t = opsServer();
    await signIn(t);
    expect(serverHealth(t.deps)).toMatchObject({ status: "ok", problems: [], lastBackup: null, drillDue: true });
    t.advance(2 * DAY + HOUR);
    expect(serverHealth(t.deps)).toMatchObject({ status: "urgent", problems: [{ code: "backup_old", short: "no backup yet" }] });
    await opsTick(t.deps);
    expect(serverHealth(t.deps)).toMatchObject({ status: "ok", lastBackup: { kind: "daily", ok: true } });
  });

  it("a restore drill is due every 3 months", () => {
    const t = opsServer();
    recordCheck(t.deps.db, { kind: "drill", at: T0, file: null, ok: true, detail: null, parentId: null });
    expect(serverHealth(t.deps).drillDue).toBe(false);
    t.advance(LIMITS.drillEveryMs + HOUR);
    expect(serverHealth(t.deps).drillDue).toBe(true);
  });

  it("samples the database's size once an hour, for 8 days", () => {
    const t = testServer();
    const count = () => t.deps.db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM db_sizes").get()?.n;
    sampleDatabaseSize(t.deps.db, t.now());
    t.advance(5 * MIN);
    sampleDatabaseSize(t.deps.db, t.now());
    expect(count()).toBe(1);
    for (let i = 0; i < 9 * 24; i++) {
      t.advance(HOUR);
      sampleDatabaseSize(t.deps.db, t.now());
    }
    expect(count()).toBe(8 * 24 + 1);
  });
});

describe("/healthz", () => {
  it("answers 200 and ok, with no login and nothing cached", async () => {
    const t = testServer();
    const res = await get(t, "/healthz");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
    expect((await get(t, "/healthz?strict=1")).status).toBe(200);
  });

  it("gives the short reason, and with ?strict=1 answers 503 only for an urgent problem", async () => {
    const t = opsServer();
    await signIn(t, "sam", "Sam");
    const phone = await enrollPhone(t, "Sam's phone");
    await deviceCall(t, phone.token, "checkin", { status: device() });
    setOpsOptions(t.deps, { disk: () => ({ freeBytes: 40e9, totalBytes: 500e9 }) });
    let res = await get(t, "/healthz?strict=1");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "the disk is getting full (8% free)" });

    setOpsOptions(t.deps, { disk: () => ROOMY_DISK });
    t.advance(3 * DAY);
    res = await get(t, "/healthz");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: false, reason: "no backup yet" });
    for (const query of ["?strict=1", "?strict", "?strict=true"]) {
      res = await get(t, `/healthz${query}`);
      expect(res.status).toBe(503);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ ok: false, reason: "no backup yet" });
      expect(text).not.toContain("Sam");
    }
    expect((await get(t, "/healthz?strict=0")).status).toBe(200);
    const { id: _id, ...worked } = backup({ startedAt: t.now(), finishedAt: t.now() });
    recordBackup(t.deps.db, worked);
    expect(await (await get(t, "/healthz?strict=1")).json()).toEqual({ ok: true });
  });
});
