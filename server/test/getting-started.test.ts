/**
 * The Phones page's Getting started card's steps (family/start.ts): each one's state from the
 * server's own state, the family's or this parent's where it's theirs, never a stored tick; and its
 * hiding by itself once the essential steps are done. The page itself: getting-started-pages.test.ts.
 * Made-up names only.
 */
import { describe, expect, it } from "vitest";
import { createEnrollmentCode } from "../src/device/enroll.js";
import { revokeDevice } from "../src/family/devices.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { setOpsOptions } from "../src/ops/options.js";
import { browserFor, enrollPhone } from "./helpers.js";
import { MCP, PASSPHRASE, SETTINGS, family } from "./start-helpers.js";

describe("Getting started's steps", () => {
  it("each comes from the server's own state, as a new family sets Belay up", async () => {
    const f = await family();
    expect(f.states()).toEqual({ phone: "todo", rules: "todo", look: "open", notifications: "todo", ai_reads: "todo", claude: "todo", backups: "todo" });
    expect(f.start()).toMatchObject({ essential: { done: 0, of: 4 }, hiddenAt: null, shown: true, phone: null });

    // The phone: an enrollment code waits for it, then it's enrolled.
    createEnrollmentCode(f.t.deps.db, f.t.now(), { deviceName: "Alex's phone", createdBy: f.sam.parent.id });
    expect(f.step("phone")).toMatchObject({ state: "waiting", phones: [], codes: [{ deviceName: "Alex's phone" }] });
    const phone = await enrollPhone(f.t, "Alex's phone");
    expect(f.step("phone")).toMatchObject({ state: "done", phones: [{ id: phone.deviceId, name: "Alex's phone" }] });

    // Its rules: none yet, then set (protection on) and waiting for the phone, then applied by its report.
    expect(f.step("rules")).toMatchObject({ state: "todo", phones: [{ name: "Alex's phone", rules: "none", protectedOn: false }] });
    expect((await f.form(`/devices/${phone.deviceId}/protect`)).status).toBe(302);
    expect(f.step("rules")).toMatchObject({ state: "waiting", phones: [{ rules: "waiting", protectedOn: true }] });
    expect((await f.applied(phone)).status).toBe(200);
    expect(f.step("rules")).toMatchObject({ state: "done", phones: [{ rules: "applied" }] });
    expect(f.start().phone).toEqual({ id: phone.deviceId, name: "Alex's phone" });
    // A second phone, with no rules yet, is a step left; once disconnected, it isn't one of the family's phones.
    const tablet = await enrollPhone(f.t, "Jamie's tablet");
    expect(f.step("rules").state).toBe("todo");
    revokeDevice(f.t.deps.db, tablet.deviceId, f.t.now());
    expect(f.step("rules").state).toBe("done");
    expect(f.step("phone").phones.map((p) => p.name)).toEqual(["Alex's phone"]);

    // Looking over the rules has no tick: Belay can't tell.
    expect(f.step("look")).toMatchObject({ state: "open", phone: { name: "Alex's phone" } });

    // Notifications are each parent's own.
    browserFor(f.t, f.sam.parent.id, () => []);
    expect(f.step("notifications")).toMatchObject({ state: "done", browsers: ["Chrome on Android"] });
    expect(f.step("notifications", f.alex).state).toBe("todo");

    // What AI apps may read: the family's, saved at least once in Settings.
    expect(f.step("ai_reads")).toMatchObject({ state: "todo", saved: false, on: ["apps", "device_status", "requests", "screen_time", "agreement", "mobile_data"] });
    expect((await f.form("/settings", { ...SETTINGS, ai_scope: ["apps", "requests"] }, f.alex)).status).toBe(302);
    expect(f.step("ai_reads")).toMatchObject({ state: "done", saved: true, on: ["apps", "requests"], added: [] });
    // A category a newer Belay adds is a decision to make again (stored choices without it, as an older server left them).
    f.t.deps.db
      .prepare("UPDATE settings SET value = ? WHERE key = 'ai_scopes'")
      .run(JSON.stringify({ apps: true, device_status: false, requests: true, screen_time: false, agreement: false, location: false, calls: false, network: false }));
    expect(f.step("ai_reads")).toMatchObject({ state: "todo", saved: true, added: ["mobile_data"] });
    await f.form("/settings", SETTINGS);
    expect(f.step("ai_reads").state).toBe("done");

    // Connecting Claude: each parent's own grant or token.
    createPersonalToken(f.t.deps.db, f.t.now(), f.alex.parent.id, "Alex's laptop", MCP);
    expect(f.step("claude").state).toBe("todo");
    expect(f.step("claude", f.alex)).toMatchObject({ state: "done", connections: ["Alex's laptop"] });
    createPersonalToken(f.t.deps.db, f.t.now(), f.sam.parent.id, "Claude Code on the laptop", MCP);
    expect(f.step("claude")).toMatchObject({ state: "done", connections: ["Claude Code on the laptop"] });

    // Backups with a passphrase: the server's own setting, as the daily backup reads it.
    expect(f.step("backups")).toMatchObject({ state: "todo", passphrase: "none", problem: null });
    setOpsOptions(f.t.deps, { env: { BELAY_BACKUP_PASSPHRASE: "too short" } });
    expect(f.step("backups")).toMatchObject({ state: "todo", passphrase: "unusable", problem: expect.stringContaining("too short: use at least 15 characters") });
    expect(f.start()).toMatchObject({ essential: { done: 3, of: 4 }, shown: true });
    setOpsOptions(f.t.deps, { env: { BELAY_BACKUP_PASSPHRASE: PASSPHRASE } });
    expect(f.step("backups")).toMatchObject({ state: "done", passphrase: "set", problem: null });

    // Every essential step done: it hides by itself, for Sam; Alex still has notifications to turn on.
    expect(f.start()).toMatchObject({ essential: { done: 4, of: 4 }, shown: false });
    expect(f.start(f.alex)).toMatchObject({ essential: { done: 3, of: 4 }, shown: true });
    // Nothing of it is a stored tick: a phone that stops being connected is a step left again,
    // waiting while the first enrollment code, never used, still works.
    revokeDevice(f.t.deps.db, phone.deviceId, f.t.now());
    expect(f.states()).toMatchObject({ phone: "waiting", rules: "todo" });
    expect(f.start().shown).toBe(true);
    f.t.advance(31 * 60_000);
    expect(f.states()).toMatchObject({ phone: "todo", rules: "todo" });
  });
});
