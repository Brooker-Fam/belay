/**
 * The CLI's Phase 3 commands, in the exact shapes CI's ci-emulator-test.sh reads: limit, schedule
 * and lock-now print only an id; status --json gains screen_time and usage. Each acts as a person
 * (the server), in the activity log, and bumps the policy. Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, pkg, snapshot, testServer, T0, type TestServer } from "./helpers.js";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const phone = await enrollPhone(t, "CI phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.fixture", { label: "Fixture" })], T0));
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, phone, policy };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(""),
    interactive: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const status = async (t: TestServer) => (JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, any>[] }).phones[0] ?? {};

describe("the CLI's screen-time commands", () => {
  it('limit "<phone>" <package> --minutes <n> prints only the limit id, and sets that phone\'s limit for that app', async () => {
    const { t, policy } = await family();
    const set = await cli(t, "limit", "CI phone", "com.example.fixture", "--minutes", "1");
    expect(set.code).toBe(0);
    expect(set.out).toMatch(/^l-[A-Za-z0-9_-]+$/);
    expect(set.err).toBe("CI phone: 1 min a day for com.example.fixture (rules version 1).");
    expect(policy().screen_time?.limits).toEqual([{ id: set.out, name: "Fixture", packages: ["com.example.fixture"], minutes: 1, by_day: null }]);
    // Again: the same limit, its minutes and name changed.
    const again = await cli(t, "limit", "CI phone", "com.example.fixture", "--minutes", "30", "--name", "The fixture");
    expect(again.out).toBe(set.out);
    expect(policy().screen_time?.limits).toEqual([{ id: set.out, name: "The fixture", packages: ["com.example.fixture"], minutes: 30, by_day: null }]);
    expect(policy().version).toBe(2);
    // * is the daily total.
    const total = await cli(t, "limit", "CI phone", "*", "--minutes", "120");
    expect(policy().screen_time?.limits[1]).toEqual({ id: total.out, name: "Screen time", packages: ["*"], minutes: 120, by_day: null });
    // --remove prints the id it removed.
    expect((await cli(t, "limit", "CI phone", "com.example.fixture", "--remove")).out).toBe(set.out);
    expect(policy().screen_time?.limits.map((l) => l.id)).toEqual([total.out]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "screen_time.changed", deviceName: "CI phone" });
    for (const bad of [
      ["limit", "CI phone", "com.example.fixture"],
      ["limit", "CI phone", "com.example.fixture", "--minutes", "1441"],
      ["limit", "CI phone", "com.example.fixture", "--minutes", "soon"],
      ["limit", "CI phone", "not a package", "--minutes", "5"],
      ["limit", "CI phone", "com.google.android.dialer", "--minutes", "5"],
      ["limit", "CI phone", "com.example.nothing", "--remove"],
    ]) {
      const res = await cli(t, ...bad);
      expect(res.code, bad.join(" ")).toBe(1);
      expect(res.out).toBe("");
    }
  });

  it('schedule "<phone>" --name --start --end [--days] [--lock] [--allow] prints only the schedule id; --remove <id> removes it', async () => {
    const { t, policy } = await family();
    const all = await cli(t, "schedule", "CI phone", "--name", "Test time", "--start", "21:00", "--end", "07:00");
    expect(all.code).toBe(0);
    expect(all.out).toMatch(/^s-[A-Za-z0-9_-]+$/);
    expect(all.err).toBe("CI phone: Test time from 21:00 to 07:00 the next day (rules version 1).");
    expect(policy().screen_time?.schedules).toEqual([
      { id: all.out, kind: "custom", name: "Test time", days: ["mon", "tue", "wed", "thu", "fri", "sat", "sun"], start: "21:00", end: "07:00", allow: [], lock: false, skip: [] },
    ]);
    const some = await cli(t, "schedule", "CI phone", "--name", "School", "--start", "08:00", "--end", "15:00", "--days", "mon,fri", "--lock", "--allow", "com.example.fixture,com.example.calc");
    expect(policy().screen_time?.schedules[1]).toMatchObject({ id: some.out, days: ["mon", "fri"], lock: true, allow: ["com.example.fixture", "com.example.calc"] });
    // --lock last, as a bare flag.
    const locked = await cli(t, "schedule", "CI phone", "--name", "Now", "--start", "10:00", "--end", "10:30", "--lock");
    expect(policy().screen_time?.schedules[2]).toMatchObject({ id: locked.out, lock: true });
    expect((await cli(t, "schedule", "CI phone", "--remove", some.out)).out).toBe(some.out);
    expect(policy().screen_time?.schedules.map((s) => s.id)).toEqual([all.out, locked.out]);
    for (const bad of [
      ["schedule", "CI phone", "--start", "21:00", "--end", "07:00"],
      ["schedule", "CI phone", "--name", "X", "--start", "9pm", "--end", "07:00"],
      ["schedule", "CI phone", "--name", "X", "--start", "21:00", "--end", "07:00", "--days", "mon,funday"],
      ["schedule", "CI phone", "--name", "X", "--start", "21:00", "--end", "07:00", "--allow", "not a package"],
      ["schedule", "CI phone", "--remove", "s-nope"],
    ]) {
      expect((await cli(t, ...bad)).code, bad.join(" ")).toBe(1);
    }
  });

  it('lock-now "<phone>" [--minutes <n>] prints only the command id, and it expires after n minutes (10)', async () => {
    const { t, phone, policy } = await family();
    const lock = await cli(t, "lock-now", "CI phone");
    expect(lock.code).toBe(0);
    expect(lock.out).toMatch(/^[0-9a-f-]{36}$/);
    expect(policy().commands).toEqual([{ id: lock.out, kind: "lock_now", issued_at: t.now(), expires_at: t.now() + 10 * 60_000, via: null }]);
    expect(policy().version).toBe(1);
    // Another one takes the waiting one's place.
    const five = await cli(t, "lock-now", "CI phone", "--minutes", "5");
    expect(policy().commands).toEqual([{ id: five.out, kind: "lock_now", issued_at: t.now(), expires_at: t.now() + 5 * 60_000, via: null }]);
    // The phone reports it: it leaves the policy.
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 2, commands: [{ id: five.out, result: "done", at: t.now() }] } }) });
    expect(policy().commands).toEqual([]);
    const s = await status(t);
    expect(s.commands[0]).toMatchObject({ id: five.out, kind: "lock_now", state: "done", result: "done" });
    expect((await cli(t, "lock-now", "CI phone", "--minutes", "0")).code).toBe(1);
  });

  it('screen-time "<phone>" --measure on|off', async () => {
    const { t, policy } = await family();
    expect((await cli(t, "screen-time", "CI phone", "--measure", "on")).out).toBe("CI phone: measuring screen time is on (rules version 1). The phone sends how long apps are used.");
    expect(policy().screen_time).toMatchObject({ measure: true, limits: [] });
    expect((await cli(t, "screen-time", "CI phone", "--measure", "off")).out).toContain("measuring screen time is off (rules version 2)");
    expect(policy().screen_time).toBeNull();
    expect((await cli(t, "screen-time", "CI phone", "--measure", "maybe")).code).toBe(1);
  });

  it("status --json gains screen_time (the rules the server sends) and usage (the days the phone sent, newest first)", async () => {
    const { t, phone } = await family();
    let s = await status(t);
    expect(s).toMatchObject({ screen_time: null, usage: [] });
    await cli(t, "screen-time", "CI phone", "--measure", "on");
    const id = (await cli(t, "limit", "CI phone", "com.example.fixture", "--minutes", "1")).out;
    const day = (date: string, minutes: number) => ({
      day: date,
      zone: "America/New_York",
      as_of: T0 + minutes,
      complete: false,
      screen_minutes: minutes,
      unlocks: 2,
      by_hour: Array.from({ length: 24 }, () => 0),
      apps: [{ package: "com.example.fixture", minutes, opens: 1 }],
      gaps: [],
    });
    await deviceCall(t, phone.token, "usage", { days: [day("2026-11-15", 3), day("2026-11-16", 2)] });
    await deviceCall(t, phone.token, "checkin", {
      status: device({ enforcement: { policy_version: 2, screen_time: { day: "2026-11-16", measured: true, used_minutes: 2, limits: [{ id, used: 2, left: 0, state: "used_up" }] } } }),
    });
    s = await status(t);
    expect(s.screen_time).toMatchObject({ measure: true, zone: "phone", limits: [{ id, packages: ["com.example.fixture"], minutes: 1 }] });
    expect(s.usage).toEqual([
      { day: "2026-11-16", zone: "America/New_York", as_of: T0 + 2, screen_minutes: 2, apps: [{ package: "com.example.fixture", minutes: 2, opens: 1 }] },
      { day: "2026-11-15", zone: "America/New_York", as_of: T0 + 3, screen_minutes: 3, apps: [{ package: "com.example.fixture", minutes: 3, opens: 1 }] },
    ]);
    // The phone's own report stays as it sent it.
    expect(s.enforcement.screen_time).toEqual({ day: "2026-11-16", measured: true, used_minutes: 2, limits: [{ id, used: 2, left: 0, state: "used_up" }] });
    expect((await cli(t, "status")).out).toContain("screen time: 1 limit, 0 schedules, measuring on; 2026-11-16: 2 min so far");
  });

  it('answer "<phone>" <id> approve --minutes <n> gives more time, as a parent would', async () => {
    const { t, phone, policy } = await family();
    const id = (await cli(t, "limit", "CI phone", "com.example.fixture", "--minutes", "1")).out;
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "more_time", limit_id: id, minutes: 15, asked_at: t.now() }] });
    expect((await status(t)).requests).toEqual([{ id: "request-0001", kind: "more_time", package: null, status: "pending", reason: null, limit_id: id, minutes: 15, given_minutes: null }]);
    const res = await cli(t, "answer", "CI phone", "request-0001", "approve", "--minutes", "15");
    expect(res.out).toBe("CI phone: request request-0001 is approved: 15 more minutes for 2026-11-16 (rules version 2).");
    expect(policy().screen_time?.extra).toMatchObject([{ limit_id: id, minutes: 15, request_id: "request-0001" }]);
    expect(policy().requests[0]).toMatchObject({ status: "approved", minutes: 15, answered_by: null });
    expect((await cli(t, "answer", "CI phone", "request-0001", "approve")).code).toBe(1);
    expect((await cli(t, "answer", "CI phone", "request-0404", "decline")).err).toBe("CI phone has no request request-0404.");
    expect((await cli(t, "answer", "CI phone", "request-0001", "maybe")).code).toBe(1);
  });

  it("the commands are in the usage text", async () => {
    const { t } = await family();
    const usage = (await cli(t, "frobnicate")).err;
    for (const line of ['limit "<phone>" <package|*> --minutes <n> [--name <words>]', 'schedule "<phone>" --remove <id>', 'lock-now "<phone>" [--minutes <n>]', 'screen-time "<phone>" --measure on|off']) {
      expect(usage).toContain(line);
    }
  });
});
