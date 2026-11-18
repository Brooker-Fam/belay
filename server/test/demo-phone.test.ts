/**
 * npm run demo's simulated phone (docs/demo.md), against a server in this process: it enrolls,
 * reports its apps and health, and applies what a parent does on the parent page within seconds,
 * over the long-poll, the way Belay's agent reports it; it says in its own words what it can't do;
 * and every request it makes is one the device API's schemas accept. Made-up data only.
 */
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEnrollmentCode } from "../src/device/enroll.js";
import { addAgentFile, currentOffer } from "../src/family/agent.js";
import { listApps } from "../src/family/apps.js";
import { listCommands } from "../src/family/commands.js";
import { getDevice } from "../src/family/devices.js";
import { policyVersion } from "../src/family/policy.js";
import type { Policy } from "../src/device/schemas.js";
import { getSettings } from "../src/settings.js";
import { APPS, FIRST_APPS, NEVER_BLOCKED, PHONE_NAME, packageOf } from "../demo/family.js";
import { SAYS, SimPhone, enforce, newPhoneState } from "../demo/phone.js";
import { type Sent, checkRequest, checkedFetch, until } from "./demo-helpers.js";
import { ORIGIN, postForm, signIn, T0, testServer, type TestServer } from "./helpers.js";

const ZONE = "America/New_York";
const DAY = 86_400_000;

describe("the simulated phone", () => {
  let t: TestServer;
  let phone: SimPhone;
  let form: (path: string, fields: Record<string, string | string[]>) => Promise<Response>;
  let parentId: () => string = () => "";
  const sent: Sent[] = [];
  /** What the demo's terminal shows the phone doing: what the kid would see on it. */
  const lines: string[] = [];
  const agents = mkdtempSync(join(tmpdir(), "belay-demo-agents-"));

  beforeAll(async () => {
    t = testServer({ config: { agentsDir: join(agents, "store") } });
    const parent = await signIn(t, "jordan", "Jordan");
    parentId = () => parent.parent.id;
    form = async (path, fields) => postForm(t, path, { _csrf: parent.csrf, ...fields }, { cookie: parent.cookie });
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: PHONE_NAME, createdBy: parent.parent.id });
    phone = new SimPhone({
      server: ORIGIN,
      zone: ZONE,
      state: newPhoneState({ now: t.now(), bootCount: 3, lastBootAt: t.now() - 3_600_000, apps: FIRST_APPS.map((a) => packageOf(a, T0 - 30 * DAY)) }),
      fetch: checkedFetch(t, sent),
      now: () => t.now(),
      log: (line) => lines.push(line),
    });
    await phone.enroll(code);
    await phone.sendInventory();
    await phone.checkin();
  });

  afterAll(async () => {
    await phone.stop();
    rmSync(agents, { recursive: true, force: true });
  });

  const deviceId = () => phone.state.deviceId ?? "";
  const reported = () => getDevice(t.deps.db, deviceId(), getSettings(t.deps.db), t.now())?.enforcement ?? null;

  it("enrolls and reports its apps and health", () => {
    const device = getDevice(t.deps.db, deviceId(), getSettings(t.deps.db), t.now());
    expect(device?.name).toBe(PHONE_NAME);
    expect(device?.status).toBe("ok");
    expect(listApps(t.deps.db, deviceId(), { includeSystem: true }).length).toBe(FIRST_APPS.length);
  });

  it("applies an app approval a parent makes on the parent page within seconds, over the long-poll", async () => {
    expect((await form(`/devices/${deviceId()}/protect`, {})).status).toBe(302);
    phone.start({ rebooted: false });
    await until(() => reported()?.policy_version === policyVersion(t.deps.db, deviceId()));
    expect(phone.state.policy?.apps.new_apps).toBe("ask");

    // The kid installs a chat app: it waits for a parent, and asks, with why.
    const requestId = phone.install(APPS.lanternChat);
    expect(requestId).not.toBeNull();
    phone.explain(requestId ?? "", "The robotics club plans our meetups in it.");
    await phone.flush();
    await phone.checkin();
    expect(phone.suspended().get(APPS.lanternChat.package)).toBe("waiting");
    const held = reported()?.suspended_count ?? 0;
    expect(held).toBe(1);

    // The parent approves it on the Requests page; the phone holds the long-poll meanwhile.
    const started = Date.now();
    const res = await form(`/devices/${deviceId()}/requests/${requestId ?? ""}/answer`, { answer: "approved", back: "requests", note: "OK, for the club." });
    expect(res.headers.get("location")).toBe("/requests?saved=answer_approved");
    const version = policyVersion(t.deps.db, deviceId());
    await until(() => reported()?.policy_version === version);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(phone.suspended().has(APPS.lanternChat.package)).toBe(false);
    expect(reported()?.suspended_count).toBe(0);
    expect(phone.state.asked[requestId ?? ""]).toMatchObject({ status: "approved", note: "OK, for the club." });
    expect(lines.at(-1)).toBe(`${PHONE_NAME}: applied the rules (version ${String(version)}). Lantern Chat runs now. Robin sees your answer: Lantern Chat: approved ("OK, for the club.").`);
  });

  it("runs a lock now, and says in its own words that it can't check where it is", async () => {
    expect((await form(`/devices/${deviceId()}/lock`, { minutes: "15" })).status).toBe(302);
    await until(() => listCommands(t.deps.db, deviceId(), t.now(), { kind: "lock_now" })[0]?.state === "done");
    // A pause came with it: every app but the never-blocked ones is held.
    expect([...phone.suspended().values()].every((why) => why === "paused")).toBe(true);
    expect(phone.suspended().size).toBeGreaterThan(5);
    expect(lines).toContainEqual(expect.stringMatching(/apps are paused\. Locked the screen \(lock now\)\.$/));
    // Its result, reported, leaves the rules: a new version with nothing new for the phone.
    await until(() => reported()?.policy_version === policyVersion(t.deps.db, deviceId()) && phone.state.policy?.commands.length === 0);
    expect(lines.at(-1)).toMatch(/: applied the rules \(version \d+\): nothing new on the phone\.$/);

    expect((await form(`/devices/${deviceId()}/location`, { mode: "on_demand", provider: "gps" })).status).toBe(302);
    await until(() => reported()?.location?.problem === SAYS.noGps);
    expect(lines).toContainEqual(expect.stringMatching(/Location is on, but it has no GPS: it can't share where it is\.$/));
    expect((await form(`/devices/${deviceId()}/location/check`, {})).status).toBe(302);
    await until(() => listCommands(t.deps.db, deviceId(), t.now(), { kind: "locate_now" })[0]?.state === "failed");
    expect(listCommands(t.deps.db, deviceId(), t.now(), { kind: "locate_now" })[0]?.problem).toBe(SAYS.noGps);
  });

  it("notices its pause run out as the clock moves, says so and checks in", async () => {
    expect(reported()?.suspended_count).toBeGreaterThan(5);
    t.advance(16 * 60_000);
    await phone.recheck();
    expect(lines.at(-1)).toMatch(/^Robin's phone: \d+ apps run now\.$/);
    expect(phone.suspended().size).toBe(0);
    expect(reported()?.suspended_count).toBe(0);
  });

  it("starts a schedule that locks as the clock moves: it holds the apps, locks the screen and checks in", async () => {
    const policy = phone.state.policy;
    if (!policy) throw new Error("no policy");
    // Two minutes before a made-up bedtime, on a phone whose server only answers check-ins.
    let clock = Date.parse("2026-11-16T20:58:00-05:00");
    const bedtime = { id: "s_bedtime", kind: "bedtime" as const, name: "Bedtime", days: ["mon" as const], start: "21:00", end: "07:00", allow: [], lock: true, skip: [] };
    const rules: Policy = {
      ...policy,
      pause: null,
      commands: [],
      screen_time: { measure: false, zone: ZONE, day_starts: "00:00", limits: [], schedules: [bedtime], exempt: [], if_unmeasured: "pause_limited", extra: [], self_serve: null, warn_before: 5 },
    };
    const checkins: string[] = [];
    const said: string[] = [];
    const quiet = new SimPhone({
      server: ORIGIN,
      zone: ZONE,
      state: { ...newPhoneState({ now: clock, bootCount: 1, lastBootAt: clock - DAY, apps: phone.state.apps }), token: "made-up", deviceId: "made-up", name: PHONE_NAME },
      fetch: (_input, init) => {
        checkins.push(typeof init?.body === "string" ? init.body : "");
        return Promise.resolve(Response.json({ server_time: clock, policy: rules }));
      },
      now: () => clock,
      log: (line) => said.push(line),
    });
    quiet.apply(rules);
    await quiet.recheck();
    expect([said.length, checkins.length]).toEqual([1, 0]);
    clock += 3 * 60_000;
    await quiet.recheck();
    expect(said.at(-1)).toMatch(/^Robin's phone: \d+ apps are off during Bedtime\. Locked the screen: Bedtime started\.$/);
    expect(checkins.length).toBe(1);
    expect(checkRequest("POST", `${ORIGIN}/api/v1/checkin`, checkins[0] ?? null).problem).toBeNull();
    // Nothing changes a minute later: nothing said, no early check-in.
    clock += 60_000;
    await quiet.recheck();
    expect([said.length, checkins.length]).toEqual([2, 1]);
  });

  it("says it can't install a new version of Belay a parent offers it", async () => {
    // A made-up APK: the server stores and offers it without reading it (docs/protocol.md).
    const apk = join(agents, "belay.apk");
    writeFileSync(apk, Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), randomBytes(4096)]));
    const { file } = await addAgentFile(t.deps.db, t.deps.config.agentsDir, t.now(), apk, { code: 7, name: "0.6.0" }, { parentId: parentId() });
    expect((await form(`/devices/${deviceId()}/update`, { sha256: file.sha256 })).status).toBe(302);
    await until(() => currentOffer(t.deps.db, deviceId())?.state === "failed");
    expect(currentOffer(t.deps.db, deviceId())?.problem).toBe(SAYS.noUpdate);
    expect(lines).toContainEqual(expect.stringMatching(/Couldn't install Belay 0\.6\.0: it can't install a new version\.$/));
  });

  it("says it can't log the network, as a problem the phone's page shows", async () => {
    expect((await form(`/devices/${deviceId()}/network`, { on: "1" })).status).toBe(302);
    await until(() => reported()?.network_log?.enabled === false);
    const device = getDevice(t.deps.db, deviceId(), getSettings(t.deps.db), t.now());
    expect(device?.problems.map((p) => p.fromPhone)).toContain(SAYS.noNetworkLog);
    expect(lines).toContainEqual(expect.stringMatching(/Network logging is on, but it can't note which websites its apps look up\.$/));
  });

  it("tells the kid who else can look after the phone when a parent adds a caregiver", async () => {
    // Phase 12: a made-up caregiver, on the parents' Caregivers page.
    const added = await form("/caregivers", { name: "Grandma", phone: [deviceId()], can: ["status", "pause"], until: "2026-11-19T18:00" });
    expect(added.status).toBe(200);
    await until(() => lines.at(-1)?.endsWith("Robin sees who else can look after the phone: Grandma.") ?? false);
    expect(reported()?.policy_version).toBe(policyVersion(t.deps.db, deviceId()));
  });

  it("sends only what the device API's schemas accept", () => {
    expect(sent.length).toBeGreaterThan(10);
    expect(sent.filter((s) => s.problem !== null)).toEqual([]);
  });

  it("never holds the apps it never blocks, even paused and with each one blocked", () => {
    const policy = phone.state.policy;
    if (!policy) throw new Error("no policy");
    const blocked = NEVER_BLOCKED.map((pkg) => ({ package: pkg, state: "blocked" as const }));
    const everything = { ...policy, pause: { until: null, note: null }, apps: { new_apps: "ask" as const, decisions: blocked } };
    const held = enforce(everything, phone.state.apps, t.now(), ZONE, () => undefined).suspended;
    for (const pkg of NEVER_BLOCKED) expect(held.has(pkg), pkg).toBe(false);
    expect(held.size).toBeGreaterThan(5);
  });
});
