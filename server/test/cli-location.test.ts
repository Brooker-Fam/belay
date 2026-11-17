/**
 * The CLI's Phase 4 and 7 commands, in the exact shapes CI's emulator test reads: place and
 * locate-now print only an id; status --json gains location, fixes, place_events, help and talk
 * requests (with withdrawn_at), help_seen, parent_numbers and ai_reads. Each acts as a person (the
 * server), in the activity log, and bumps the policy. Made-up places only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, fix, testServer, T0, type TestServer } from "./helpers.js";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const phone = await enrollPhone(t, "CI phone");
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

describe("the CLI's location commands", () => {
  it('location "<phone>" --mode … [--every] [--hours] [--provider] [--keep-on]: the policy\'s location, as a parent sets it', async () => {
    const { t, policy } = await family();
    const set = await cli(t, "location", "CI phone", "--mode", "periodic", "--every", "15", "--hours", "07:00-21:00", "--provider", "fused", "--keep-on", "on");
    expect(set.code).toBe(0);
    expect(set.out).toBe("CI phone: location is every 15 minutes, from 07:00 to 21:00 in the phone's time, with arrivals and departures for the family's places, kept on, with Android's combined provider (rules version 1).");
    expect(policy().location).toEqual({ mode: "periodic", every_minutes: 15, hours: { start: "07:00", end: "21:00" }, provider: "fused", fallback_fused: false, places: [], keep_on: true, lost: null });
    expect((await cli(t, "location", "CI phone", "--hours", "all", "--provider", "gps", "--fallback", "on")).code).toBe(0);
    expect(policy().location).toMatchObject({ hours: null, provider: "gps", fallback_fused: true });
    expect((await cli(t, "location", "CI phone", "--mode", "on_demand")).out).toBe(
      "CI phone: location is on demand: Belay shares where the phone is only when a parent checks, kept on, with GPS only (rules version 3).",
    );
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "location.changed", deviceName: "CI phone" });
    for (const bad of [
      ["location", "CI phone"],
      ["location", "CI phone", "--mode", "always"],
      ["location", "CI phone", "--every", "10"],
      ["location", "CI phone", "--hours", "7-21"],
      ["location", "CI phone", "--provider", "network"],
      ["location", "CI phone", "--keep-on", "yes"],
      ["location", "No phone", "--mode", "off"],
    ]) {
      const res = await cli(t, ...bad);
      expect(res.code, bad.join(" ")).toBe(1);
      expect(res.out).toBe("");
    }
  });

  it('place "<phone>" --name --lat --lng --radius prints only the place id; the same name again changes it; --remove <id> prints the id', async () => {
    const { t, policy } = await family();
    await cli(t, "location", "CI phone", "--mode", "periodic");
    const add = await cli(t, "place", "CI phone", "--name", "Test point", "--lat", "40.1", "--lng", "-73.2", "--radius", "100", "--notify", "arrive,leave");
    expect(add.code).toBe(0);
    expect(add.out).toMatch(/^p-[A-Za-z0-9_-]+$/);
    expect(add.err).toBe("CI phone: Test point, 100 m around 40.1, -73.2 (rules version 2).");
    expect(policy().location?.places).toEqual([{ id: add.out, name: "Test point", lat: 40.1, lng: -73.2, radius_m: 100, notify: ["arrive", "leave"] }]);
    const again = await cli(t, "place", "CI phone", "--name", "test point", "--lat", "40.2", "--lng", "-73.3", "--radius", "250");
    expect(again.out).toBe(add.out);
    expect(policy().location?.places).toEqual([{ id: add.out, name: "test point", lat: 40.2, lng: -73.3, radius_m: 250, notify: [] }]);
    for (const bad of [
      ["place", "CI phone", "--name", "X", "--lat", "40.1", "--lng", "-73.2"],
      ["place", "CI phone", "--name", "X", "--lat", "north", "--lng", "-73.2", "--radius", "100"],
      ["place", "CI phone", "--name", "X", "--lat", "40.1", "--lng", "-73.2", "--radius", "20"],
      ["place", "CI phone", "--name", "X", "--lat", "40.1", "--lng", "-73.2", "--radius", "100", "--notify", "always"],
      ["place", "CI phone", "--remove", "p-nothing"],
    ]) {
      const res = await cli(t, ...bad);
      expect(res.code, bad.join(" ")).toBe(1);
      expect(res.out).toBe("");
    }
    const removed = await cli(t, "place", "CI phone", "--remove", add.out);
    expect(removed.out).toBe(add.out);
    expect(policy().location?.places).toEqual([]);
  });

  it('locate-now "<phone>" prints only the command id, doesn\'t wait, and needs location on', async () => {
    const { t, policy } = await family();
    const off = await cli(t, "locate-now", "CI phone");
    expect(off.code).toBe(1);
    expect(off.err).toContain("Location is off for this phone");
    await cli(t, "location", "CI phone", "--mode", "on_demand");
    const check = await cli(t, "locate-now", "CI phone");
    expect(check.code).toBe(0);
    expect(check.out).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(policy().commands).toEqual([{ id: check.out, kind: "locate_now", issued_at: t.now(), expires_at: t.now() + 2 * 60_000, via: null }]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "command.issued", detail: { kind: "locate_now", command: check.out } });
  });

  it('lost "<phone>" --message <words> [--number], and --off', async () => {
    const { t, policy } = await family();
    const on = await cli(t, "lost", "CI phone", "--message", "This phone is lost. Please call", "--number", "555-0100");
    expect(on.out).toBe('CI phone: lost mode is on; the lock screen says "This phone is lost. Please call 555-0100" (rules version 1).');
    expect(policy().location?.lost).toEqual({ since: t.now(), message: "This phone is lost. Please call 555-0100" });
    expect((await cli(t, "lost", "CI phone")).code).toBe(1);
    expect((await cli(t, "lost", "CI phone", "--off")).out).toBe("CI phone: lost mode is off (rules version 2).");
    expect((await cli(t, "lost", "CI phone", "--off")).out).toBe("CI phone wasn't in lost mode.");
    expect(policy().location?.lost).toBeNull();
  });

  it('help-seen "<phone>" <request id>, parent-number and kid-number, as a parent would', async () => {
    const { t, phone, policy } = await family();
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", reason: "Help", asked_at: t.now() }] });
    const seen = await cli(t, "help-seen", "CI phone", "request-0001");
    expect(seen.out).toBe("CI phone: help request request-0001 is marked seen; the kid's phone shows it (rules version 1).");
    expect(policy().help_seen).toEqual([{ request_id: "request-0001", at: t.now(), by: null }]);
    expect((await cli(t, "help-seen", "CI phone", "request-0001")).out).toMatch(/^CI phone: help request request-0001 was already seen, at 2026-11-16T10:00:00-05:00\.$/);
    expect((await cli(t, "help-seen", "CI phone", "request-9999")).code).toBe(1);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "request.seen" });

    const mom = await cli(t, "parent-number", "CI phone", "--name", "Mom", "--number", "+15555550100");
    expect(mom.out).toBe("CI phone: the emergency card lists Mom (+15555550100) (rules version 2).");
    await cli(t, "parent-number", "CI phone", "--name", "mom", "--number", "+15555550111");
    await cli(t, "parent-number", "CI phone", "--name", "Dad", "--number", "+15555550101");
    expect(policy().parent_numbers).toEqual([
      { name: "mom", number: "+15555550111" },
      { name: "Dad", number: "+15555550101" },
    ]);
    expect((await cli(t, "parent-number", "CI phone", "--name", "Gran", "--number", "555-0102")).code).toBe(1);
    expect((await cli(t, "parent-number", "CI phone", "--remove", "Dad")).out).toBe("CI phone: Dad is off the emergency card (rules version 5).");
    expect((await cli(t, "parent-number", "CI phone", "--remove", "Dad")).code).toBe(1);
    expect((await cli(t, "kid-number", "CI phone", "+1 555 555 0123")).out).toBe('CI phone: "Call" on a help request dials +15555550123.');
    expect((await cli(t, "kid-number", "CI phone", "0123")).code).toBe(1);
    expect((await cli(t, "kid-number", "CI phone", "--clear")).out).toBe('CI phone: no number for "Call".');
  });
});

describe("status --json", () => {
  it("each phone gains location, fixes (newest first, at most 50), place_events, help and talk requests with withdrawn_at, help_seen, parent_numbers and ai_reads", async () => {
    const { t, phone } = await family();
    expect(await status(t)).toMatchObject({ location: null, fixes: [], place_events: [], help_seen: [], parent_numbers: [], ai_reads: ["apps", "device_status", "requests", "screen_time", "agreement"] });
    await cli(t, "location", "CI phone", "--mode", "periodic");
    const place = (await cli(t, "place", "CI phone", "--name", "Test point", "--lat", "40.1", "--lng", "-73.2", "--radius", "100")).out;
    const check = (await cli(t, "locate-now", "CI phone")).out;
    const fixes = Array.from({ length: 55 }, (_, i) => fix({ at: T0 - (55 - i) * 60_000 }));
    const answer = fix({ at: T0, reason: "on_demand", command_id: check, mock: true });
    await deviceCall(t, phone.token, "locations", { fixes: [...fixes, answer], place_events: [{ id: "event-0001", place_id: place, kind: "arrived", at: T0 - 60_000, fix_id: fixes[0]?.id ?? "" }] });
    await deviceCall(t, phone.token, "requests", {
      requests: [
        { id: "request-0001", kind: "help", location: fix({ reason: "help", at: T0 - 90 * 60_000 }), asked_at: t.now() },
        { id: "request-0002", kind: "talk", reason: "My curfew", asked_at: t.now() },
      ],
    });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0002", kind: "talk", reason: "My curfew", asked_at: t.now(), withdrawn_at: T0 + 5 }] });
    await cli(t, "help-seen", "CI phone", "request-0001");
    const s = await status(t);
    expect(s.location).toMatchObject({ mode: "periodic", every_minutes: 30, places: [{ id: place, name: "Test point" }] });
    expect(s.fixes).toHaveLength(50);
    expect(s.fixes[0]).toEqual({ id: answer.id, at: T0, lat: 40.1, lng: -73.2, accuracy_m: 20, provider: "gps", reason: "on_demand", command_id: check, mock: true });
    expect(s.fixes[1]).toMatchObject({ id: fixes[54]?.id, reason: "periodic", command_id: null, mock: false });
    expect(s.place_events).toEqual([{ id: "event-0001", place_id: place, place_name: "Test point", kind: "arrived", at: T0 - 60_000, fix_id: fixes[0]?.id }]);
    const help = s.requests.find((r: { kind: string }) => r.kind === "help");
    expect(help).toMatchObject({ id: "request-0001", kind: "help", package: null, status: "approved", reason: null, seen_at: "2026-11-16T10:00:00-05:00", seen_by: "the server", location: { lat: 40.1, lng: -73.2, accuracy_m: 20, mock: false } });
    expect(s.requests.find((r: { kind: string }) => r.kind === "talk")).toEqual({ id: "request-0002", kind: "talk", package: null, status: "withdrawn", reason: "My curfew", withdrawn_at: T0 + 5 });
    expect(s.help_seen).toEqual([{ request_id: "request-0001", at: t.now(), by: null }]);
    const text = (await cli(t, "status")).out;
    expect(text).toContain("  location: every 30 minutes, with arrivals and departures for the family's places; last fix just now");
  });
});
