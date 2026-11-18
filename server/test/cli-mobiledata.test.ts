/**
 * The CLI's Phase 13 commands, in the exact shapes CI's emulator test reads: wifi-only (and
 * --remove), mobile-data --measure on|off, and status --json's mobile_data and mobile_data_days.
 * Each acts as a person (the server), in the activity log, and bumps the policy. Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, testServer, T0, type TestServer } from "./helpers.js";

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

const status = async (t: TestServer) => (JSON.parse((await cli(t, "status", "--json")).out) as { phones: Record<string, unknown>[] }).phones[0];

describe("wifi-only and mobile-data", () => {
  it("make an app Wi-Fi only and take it off, as a person, never one the phone never blocks", async () => {
    const { t, policy } = await family();
    expect(await cli(t, "wifi-only", "CI phone", "family.brooker.belay.fixture")).toMatchObject({
      code: 0,
      out: "CI phone: family.brooker.belay.fixture is Wi-Fi only: the phone keeps it off mobile data (rules version 1).",
    });
    expect(policy().mobile_data).toEqual({ wifi_only: ["family.brooker.belay.fixture"], measure: false });
    expect((await cli(t, "wifi-only", "CI phone", "family.brooker.belay.fixture")).out).toBe("CI phone: family.brooker.belay.fixture was Wi-Fi only already.");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "mobile_data.wifi_only_added" });
    const refused = await cli(t, "wifi-only", "CI phone", "com.android.phone");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("com.android.phone can't be Wi-Fi only.");
    expect((await cli(t, "wifi-only", "CI phone", "not a package")).code).toBe(1);
    expect((await cli(t, "wifi-only", "CI phone")).code).toBe(1);
    expect((await cli(t, "wifi-only", "CI phone", "--remove", "family.brooker.belay.fixture")).out).toBe("CI phone: family.brooker.belay.fixture may use mobile data again (rules version 2).");
    expect((await cli(t, "wifi-only", "CI phone", "--remove", "family.brooker.belay.fixture")).out).toBe("CI phone: family.brooker.belay.fixture wasn't Wi-Fi only.");
    expect(policy().mobile_data.wifi_only).toEqual([]);
  });

  it("turn measuring on and off, and status --json lists the days the phone sent", async () => {
    const { t, phone, policy } = await family();
    expect((await cli(t, "mobile-data", "CI phone", "--measure", "maybe")).code).toBe(1);
    expect((await cli(t, "mobile-data", "CI phone")).code).toBe(1);
    expect((await cli(t, "mobile-data", "CI phone", "--measure", "on")).out).toContain("CI phone: measuring mobile data is on (rules version 1).");
    expect(policy().mobile_data.measure).toBe(true);
    await deviceCall(t, phone.token, "mobile-data", {
      days: [
        {
          day: "2026-11-16",
          zone: "America/New_York",
          from: T0,
          as_of: T0,
          complete: false,
          mobile_bytes: 0,
          wifi_bytes: 0,
          apps: [],
          android_bytes: 0,
          removed_bytes: 0,
          hotspot_bytes: 0,
        },
      ],
    });
    expect(await status(t)).toMatchObject({
      mobile_data: { wifi_only: [], measure: true },
      mobile_data_days: [{ day: "2026-11-16", zone: "America/New_York", from: T0, as_of: T0, complete: false, mobile_bytes: 0, apps: [] }],
    });
    expect((await cli(t, "status")).out).toContain("  mobile data: 0 Wi-Fi-only apps; measuring on; 1 day kept; 2026-11-16: 0 bytes on mobile data");
    expect((await cli(t, "mobile-data", "CI phone", "--measure", "off")).out).toContain("The phone stops sending it.");
    expect((await cli(t, "mobile-data", "CI phone", "--measure", "off")).out).toBe("CI phone: measuring mobile data was already off (rules version 2).");
  });
});
