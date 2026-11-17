import { createReadStream, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { loadMigrations, migrate, openDatabase } from "../src/db.js";
import { backupDir, latestBackup, latestCheck, runDailyBackup, writeBackup } from "../src/ops/backups.js";
import { runOfflineCommand } from "../src/ops/cli.js";
import { drillCopy, verifyBackup } from "../src/ops/verify.js";
import { deviceCall, enrollPhone, pkg, signIn, snapshot, T0 } from "./helpers.js";
import { FAST_SCRYPT, PASSPHRASE, dailyContext, opsServer, scratchDir, type OpsServer } from "./ops-helpers.js";

const LATEST = loadMigrations().at(-1)?.version ?? 0;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A family with a parent, one phone and two apps, and the server's daily backup of it. */
async function family(opts: { encrypted?: boolean } = {}) {
  const t = opsServer();
  await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps"), pkg("com.example.chat"), pkg("com.android.settings", { system: true })], T0));
  const made = await runDailyBackup(dailyContext(t, { passphrase: () => (opts.encrypted ? PASSPHRASE : null) }));
  if (!made?.ok) throw new Error(`no backup: ${made?.error ?? "none"}`);
  return { t, file: join(backupDir(t.dataDir), made.file) };
}

function answers(...lines: string[]) {
  const asked: string[] = [];
  return {
    asked,
    readSecret: (prompt: string) => {
      asked.push(prompt);
      return Promise.resolve(lines.shift() ?? "");
    },
  };
}

async function cli(t: OpsServer, argv: string[], opts: { secrets?: string[]; interactive?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const secrets = answers(...(opts.secrets ?? []));
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: secrets.readSecret,
    interactive: opts.interactive ?? false,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked: secrets.asked };
}

async function offline(argv: string[], env: NodeJS.ProcessEnv, opts: { secrets?: string[]; stdin?: NodeJS.ReadableStream } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const secrets = answers(...(opts.secrets ?? []));
  const code = await runOfflineCommand(argv, {
    env,
    now: T0,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: secrets.readSecret,
    interactive: false,
    stdin: opts.stdin ?? process.stdin,
  });
  return { code, out: out.join("\n"), err: err.join("\n"), asked: secrets.asked };
}

describe("backup <file>", () => {
  it("writes a plain copy, says to keep it private, and records it", async () => {
    const { t } = await family();
    const file = join(scratchDir(), "manual.db");
    const done = await cli(t, ["backup", file]);
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/^Backed up to .*manual\.db \(\d+ KB\)\. It holds the family's data: keep it as private as the server, or use --encrypt/);
    expect(readFileSync(file).subarray(0, 15).toString()).toBe("SQLite format 3");
    expect(latestBackup(t.deps.db)).toMatchObject({ kind: "manual", file, ok: true, encrypted: false });
    expect((await cli(t, ["backup", file])).err).toContain("already exists. Pick a new name.");
    expect((await cli(t, ["backup"])).err).toContain("Usage: backup <file> [--encrypt]");
  });

  it("--encrypt seals it with BELAY_BACKUP_PASSPHRASE, without asking", async () => {
    const { t } = await family();
    vi.stubEnv("BELAY_BACKUP_PASSPHRASE", PASSPHRASE);
    const file = join(scratchDir(), "manual.db.enc");
    const done = await cli(t, ["backup", file, "--encrypt"]);
    expect(done).toMatchObject({ code: 0, asked: [] });
    expect(done.out).toContain("encrypted. Keep the passphrase somewhere safe");
    expect(readFileSync(file).subarray(0, 8).toString()).toBe("BELAYBAK");
    expect(latestBackup(t.deps.db)).toMatchObject({ kind: "manual", ok: true, encrypted: true });
    expect((await verifyBackup(file, { now: t.now(), passphrase: () => Promise.resolve(PASSPHRASE) })).ok).toBe(true);
  });

  it("--encrypt asks for a passphrase twice at a terminal, and wants a long one", async () => {
    const { t } = await family();
    const dir = scratchDir();
    const mismatch = await cli(t, ["backup", join(dir, "a.enc"), "--encrypt"], { interactive: true, secrets: [PASSPHRASE, "something else entirely"] });
    expect(mismatch).toMatchObject({ code: 1, err: "The two passphrases don't match." });
    const short = await cli(t, ["backup", join(dir, "b.enc"), "--encrypt"], { interactive: true, secrets: ["short", "short"] });
    expect(short.err).toBe("That passphrase is too short: use at least 15 characters, like four or five random words.");
    const good = await cli(t, ["backup", join(dir, "c.enc"), "--encrypt"], { interactive: true, secrets: [PASSPHRASE, PASSPHRASE] });
    expect(good.code).toBe(0);
    expect(good.asked).toEqual(["A passphrase for this backup: ", "The same passphrase again: "]);
    expect(existsSync(join(dir, "a.enc")) || existsSync(join(dir, "b.enc"))).toBe(false);
  });

  it("records a backup that failed", async () => {
    const { t } = await family();
    const done = await cli(t, ["backup", join(scratchDir(), "no-such-folder", "x.db")]);
    expect(done.code).toBe(1);
    expect(done.err).toMatch(/^The backup didn't work: The folder .* doesn't exist\.$/);
    expect(latestBackup(t.deps.db)).toMatchObject({ kind: "manual", ok: false });
  });
});

describe("verify-backup <file>", () => {
  it("proves the server's own backup restores, counts what's in it, and records it as checked", async () => {
    const { t, file } = await family();
    const done = await cli(t, ["verify-backup", file]);
    expect(done.code).toBe(0);
    expect(done.out.split("\n")).toEqual([
      `${file}: it restores.`,
      "  Encrypted: no.",
      "  Integrity: ok.",
      `  Schema: version ${LATEST}, the same as this server.`,
      "  In it: 1 phone, 2 apps, 1 parent.",
      "  Newest data: Nov 16, 2026, 10:00 AM (UTC-05:00).",
      expect.stringMatching(/^ {2}Size: \d+ KB\.$/),
      "Recorded as this server's latest backup check.",
    ]);
    expect(latestCheck(t.deps.db, "verify")).toMatchObject({ ok: true, file: "belay-2026-11-16.db", at: T0, detail: { counts: { phones: 1, apps: 2, parents: 1, disconnected: 0 } } });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "backup.verified", detail: { file: "belay-2026-11-16.db", ok: true } });
  });

  it("decrypts an encrypted one with the passphrase it asks for", async () => {
    const { t, file } = await family({ encrypted: true });
    const done = await cli(t, ["verify-backup", file], { secrets: [PASSPHRASE] });
    expect(done.code).toBe(0);
    expect(done.asked).toEqual(["The backup's passphrase: "]);
    expect(done.out).toContain("  Encrypted: yes, and the passphrase works.");
  });

  it("uses the server's own passphrase when it's set", async () => {
    const { t, file } = await family({ encrypted: true });
    vi.stubEnv("BELAY_BACKUP_PASSPHRASE", PASSPHRASE);
    expect(await cli(t, ["verify-backup", file])).toMatchObject({ code: 0, asked: [] });
  });

  it("fails cleanly on a wrong passphrase, and records that the check failed", async () => {
    const { t, file } = await family({ encrypted: true });
    const done = await cli(t, ["verify-backup", file], { secrets: ["not the passphrase, sorry"] });
    expect(done).toMatchObject({ code: 1, out: "Recorded as this server's latest backup check." });
    expect(done.err).toBe(`${file}: it does NOT restore. The passphrase is wrong for this backup.\n  Size: ${(readFileSync(file).length / 1000).toFixed(0)} KB.`);
    expect(latestCheck(t.deps.db, "verify")).toMatchObject({ ok: false, detail: { problem: "The passphrase is wrong for this backup." } });
  });

  it("rejects a backup cut short or changed", async () => {
    const { t, file } = await family({ encrypted: true });
    const whole = readFileSync(file);
    const dir = scratchDir();
    writeFileSync(join(dir, "cut.db.enc"), whole.subarray(0, whole.length - 100));
    const changed = Buffer.from(whole);
    changed[2000] = (changed[2000] ?? 0) ^ 0xff;
    writeFileSync(join(dir, "changed.db.enc"), changed);
    for (const name of ["cut.db.enc", "changed.db.enc"]) {
      const done = await cli(t, ["verify-backup", join(dir, name)], { secrets: [PASSPHRASE] });
      expect(done.code).toBe(1);
      expect(done.err).toContain("it does NOT restore. This backup is damaged, or was changed after it was made");
    }
  });

  it("rejects what isn't a backup: a missing file, another file, a damaged database, another database", async () => {
    const { t, file } = await family();
    const dir = scratchDir();
    writeFileSync(join(dir, "notes.txt"), "not a backup");
    writeFileSync(join(dir, "cut.db"), readFileSync(file).subarray(0, 8192));
    const other = new Database(join(dir, "other.db"));
    other.exec("CREATE TABLE recipes (name TEXT)");
    other.pragma("user_version = 3");
    other.close();
    const problems = {
      "missing.db": "There's no file at",
      "notes.txt": "This isn't a Belay backup: it's neither a database nor an encrypted backup.",
      "cut.db": "The database in it is damaged",
      "other.db": "It's a database, but not Belay's.",
    };
    for (const [name, problem] of Object.entries(problems)) {
      const done = await cli(t, ["verify-backup", join(dir, name)]);
      expect([name, done.code]).toEqual([name, 1]);
      expect(done.err).toContain(problem);
    }
  });

  it("upgrades an older backup on a copy to show this server can restore it, and leaves the backup alone", async () => {
    const { t } = await family();
    const file = join(scratchDir(), "old.db");
    const old = new Database(file);
    migrate(
      old,
      loadMigrations().filter((m) => m.version <= 2),
    );
    old.prepare("INSERT INTO devices (id, name, enrolled_at) VALUES ('d1', 'Old phone', ?)").run(T0);
    old.close();
    const done = await cli(t, ["verify-backup", file]);
    expect(done.code).toBe(0);
    expect(done.out).toContain(`  Schema: version 2, older than this server's ${LATEST}: the upgrade worked, on a copy.`);
    expect(done.out).toContain("  In it: 1 phone, 0 apps, 0 parents.");
    const after = new Database(file, { readonly: true });
    expect(after.pragma("user_version", { simple: true })).toBe(2);
    after.close();
  });

  it("refuses a backup from a newer Belay", async () => {
    const { t, file } = await family();
    const newer = join(scratchDir(), "newer.db");
    writeFileSync(newer, readFileSync(file));
    const db = new Database(newer);
    db.pragma(`user_version = ${LATEST + 1}`);
    db.close();
    const done = await cli(t, ["verify-backup", newer]);
    expect(done.code).toBe(1);
    expect(done.err).toContain(`It's from a newer Belay (schema ${LATEST + 1}; this server knows ${LATEST}): restore it with a server at least that new.`);
  });

  it("doesn't record a check of a file outside the server's data dir", async () => {
    const { t, file } = await family();
    const elsewhere = join(scratchDir(), "copy.db");
    writeFileSync(elsewhere, readFileSync(file));
    const done = await cli(t, ["verify-backup", elsewhere]);
    expect(done.code).toBe(0);
    expect(done.out).not.toContain("Recorded");
    expect(latestCheck(t.deps.db, "verify")).toBeNull();
  });
});

describe("verify-backup and restore, without the live database open", () => {
  /** The server's database as a file in its data dir, and a backup of it in its backups folder. */
  async function serverOnDisk(opts: { encrypted?: boolean } = {}) {
    const dataDir = scratchDir();
    const db = openDatabase(dataDir);
    db.prepare("INSERT INTO devices (id, name, enrolled_at) VALUES ('d1', 'Sam''s phone', ?)").run(T0);
    mkdirSync(backupDir(dataDir));
    const file = join(backupDir(dataDir), opts.encrypted ? "belay-2026-11-16.db.enc" : "belay-2026-11-16.db");
    await writeBackup(db, file, { passphrase: opts.encrypted ? PASSPHRASE : null, scrypt: FAST_SCRYPT });
    db.close();
    return { dataDir, file };
  }

  it("verify-backup records the check in the server's database on disk", async () => {
    const { dataDir, file } = await serverOnDisk();
    const done = await offline(["verify-backup", file], { BELAY_DATA_DIR: dataDir });
    expect(done.code).toBe(0);
    expect(done.out).toContain("In it: 1 phone, 0 apps, 0 parents.");
    expect(done.out).toContain("Recorded as this server's latest backup check.");
    const db = openDatabase(dataDir);
    expect(latestCheck(db, "verify")).toMatchObject({ ok: true, file: "belay-2026-11-16.db" });
    db.close();
  });

  it("verify-backup refuses the live database itself", async () => {
    const { dataDir } = await serverOnDisk();
    const done = await offline(["verify-backup", join(dataDir, "belay.db")], { BELAY_DATA_DIR: dataDir });
    expect(done).toMatchObject({ code: 1, err: "That's the live database, not a backup. Make a backup first (backup <file>), then check that." });
  });

  it("verify-backup - reads a backup on stdin; an encrypted one needs the passphrase setting", async () => {
    const { file } = await serverOnDisk({ encrypted: true });
    const noPass = await offline(["verify-backup", "-"], {}, { stdin: createReadStream(file) });
    expect(noPass.code).toBe(1);
    expect(noPass.err).toContain("The backup on stdin: it does NOT restore. It's encrypted, and it's coming in on stdin: set BELAY_BACKUP_PASSPHRASE");
    const withPass = await offline(["verify-backup", "-"], { BELAY_BACKUP_PASSPHRASE: PASSPHRASE }, { stdin: createReadStream(file) });
    expect(withPass.code).toBe(0);
    expect(withPass.out).toContain("The backup on stdin: it restores.");
  });

  it("restore puts a checked backup into an empty data dir, and the restored database says so", async () => {
    const { file } = await serverOnDisk({ encrypted: true });
    const target = join(scratchDir(), "restored");
    const done = await offline(["restore", file], { BELAY_DATA_DIR: target }, { secrets: [PASSPHRASE] });
    expect(done.code).toBe(0);
    expect(done.out).toContain(`Restored to ${join(target, "belay.db")}. Start the server.`);
    const db = openDatabase(target);
    expect(db.prepare("SELECT name FROM devices").all()).toEqual([{ name: "Sam's phone" }]);
    expect(listAudit(db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "backup.restored", detail: { file: "belay-2026-11-16.db.enc", drill: false } });
    expect(drillCopy(db)).toBeNull();
    db.close();
  });

  it("restore --drill - marks a scratch copy from stdin, which sends no notifications", async () => {
    const { file } = await serverOnDisk();
    const target = join(scratchDir(), "drill");
    const done = await offline(["restore", "--drill", "-"], { BELAY_DATA_DIR: target }, { stdin: createReadStream(file) });
    expect(done.code).toBe(0);
    expect(done.out).toContain("as a restore drill's copy: it sends no notifications");
    const db = openDatabase(target);
    expect(drillCopy(db)).toEqual({ at: T0, from: "a backup from stdin" });
    db.close();
  });

  it("restore never overwrites a database, and restores nothing from a bad backup", async () => {
    const { dataDir, file } = await serverOnDisk();
    const taken = await offline(["restore", file], { BELAY_DATA_DIR: dataDir });
    expect(taken.code).toBe(1);
    expect(taken.err).toContain("There's a database in");
    expect(taken.err).toContain("so it can't overwrite the family's data by mistake");

    const target = join(scratchDir(), "restored");
    const bad = join(scratchDir(), "bad.db");
    writeFileSync(bad, readFileSync(file).subarray(0, 4096));
    const refused = await offline(["restore", bad], { BELAY_DATA_DIR: target });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("Nothing was restored.");
    expect(existsSync(join(target, "belay.db"))).toBe(false);
    expect((await offline(["restore"], {})).err).toBe("Usage: restore [--drill] <file>, or - for a backup on stdin");
  });
});

describe("restore-drill", () => {
  it("gives the drill's steps for the newest backup", async () => {
    const { t, file } = await family({ encrypted: true });
    const done = await cli(t, ["restore-drill"]);
    expect(done.code).toBe(0);
    expect(done.out).toContain(`The newest backup: ${file} (today, 10:00 AM`);
    expect(done.out).toContain("Last restore drill: never. Last check with verify-backup: never.");
    expect(done.out).toContain(`docker compose exec belay node dist/cli.js verify-backup ${file}`);
    expect(done.out).toContain("read -rs BELAY_BACKUP_PASSPHRASE && export BELAY_BACKUP_PASSPHRASE");
    expect(done.out).toContain("node dist/cli.js restore --drill - < belay-2026-11-16.db.enc");
    expect(done.out).toContain("sign in with your usual username and password, and check that the phones are there");
  });

  it("says when there's no backup yet", async () => {
    const t = opsServer();
    const done = await cli(t, ["restore-drill"]);
    expect(done.code).toBe(1);
    expect(done.err).toContain("There's no backup in");
  });
});
