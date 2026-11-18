/**
 * npm run demo's made-up family (docs/demo.md): what the seed makes on a new database, through the
 * device API and the parent's own code, every request checked against the device API's schemas;
 * and every parent page of it, with the banner. Made-up data only: the demo's own.
 */
import { describe, beforeAll, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { createSession, listParents } from "../src/auth/parents.js";
import { listApps } from "../src/family/apps.js";
import { listCallRecords } from "../src/family/calls/records.js";
import { getDevice, listDevices } from "../src/family/devices.js";
import { locationSettings } from "../src/family/location/store.js";
import { networkSettings } from "../src/family/network/store.js";
import { policyVersion } from "../src/family/policy.js";
import { recentRequests } from "../src/family/requests.js";
import { currentAgreement } from "../src/family/screentime/agreement.js";
import { listStages, phoneRules, phoneStage } from "../src/family/screentime/rules.js";
import { usageDays } from "../src/family/screentime/usage.js";
import { setOpsOptions } from "../src/ops/options.js";
import { getSettings } from "../src/settings.js";
import { APPS, PHONE_NAME } from "../demo/family.js";
import { type Seeded, seedDemo } from "../demo/seed.js";
import { type Sent, checkRequest } from "./demo-helpers.js";
import { get, testServer, type TestServer } from "./helpers.js";
import { structureProblems } from "./html.js";

const BANNER = "Demo: a made-up family. Nothing here is real.";
const ZONE = "America/New_York";
const DAY = 86_400_000;

describe("the demo's family", () => {
  let t: TestServer;
  let seeded: Seeded;
  let cookie: string;
  const sent: Sent[] = [];

  beforeAll(async () => {
    t = testServer({ config: { demoBanner: true } });
    seeded = await seedDemo({
      db: t.deps.db,
      config: t.deps.config,
      now: t.now(),
      zone: ZONE,
      password: "a made-up password for the demo",
      observe: (method, url, body) => sent.push(checkRequest(method, url, body)),
    });
    cookie = `__Host-belay=${createSession(t.deps.db, t.now(), seeded.parentId).cookie}`;
  });

  it("is one parent and one phone, with made-up apps and numbers only", () => {
    const db = t.deps.db;
    expect(listParents(db).map((p) => p.username)).toEqual(["demo"]);
    const phones = listDevices(db, getSettings(db), t.now());
    expect(phones.map((p) => [p.name, p.status, p.facts?.model])).toEqual([[PHONE_NAME, "ok", "Demo phone (simulated)"]]);
    const apps = listApps(db, seeded.deviceId, { includeSystem: true, includeRemoved: true });
    expect(apps.length).toBeGreaterThan(15);
    for (const app of apps) expect(app.package, app.label).toMatch(/^(org\.example\.|family\.brooker\.belay$)/);
    const calls = listCallRecords(db, seeded.deviceId);
    expect(calls.length).toBeGreaterThanOrEqual(5);
    // The 555-01xx numbers are kept for fiction: a contact's call names the contact, a stranger's the number.
    for (const c of calls) if (c.number !== null) expect(c.number).toMatch(/^\+155555501\d\d$/);
    expect(calls.some((c) => c.number === null && c.contactName !== null)).toBe(true);
  });

  it("has a week of history: installs, updates, a removal, answered and waiting requests", () => {
    const db = t.deps.db;
    const kinds = db.prepare<[string], { kind: string }>("SELECT DISTINCT kind FROM app_events WHERE device_id = ?").all(seeded.deviceId).map((r) => r.kind);
    expect(kinds.sort()).toEqual(["installed", "removed", "updated"]);
    const first = db.prepare<[], { at: number }>("SELECT MIN(at) AS at FROM audit_log").get()?.at ?? t.now();
    expect(t.now() - first).toBeGreaterThan(6 * DAY);
    const requests = recentRequests(db, t.now(), { limit: 50 });
    const of = (kind: string, status: string) => requests.filter((r) => r.kind === kind && r.status === status);
    const waiting = of("app", "pending");
    expect(waiting.map((r) => (r.kind === "app" ? [r.package, r.reason !== null] : null))).toEqual([[APPS.lanternChat.package, true]]);
    expect(of("more_time", "pending").map((r) => r.id)).toEqual([seeded.waiting.moreTime]);
    expect(of("app", "approved").map((r) => (r.kind === "app" ? r.package : ""))).toEqual([APPS.fractionForest.package]);
    expect(of("app", "declined").map((r) => (r.kind === "app" ? r.package : ""))).toEqual([APPS.clipStream.package]);
    expect(of("more_time", "approved").map((r) => (r.kind === "more_time" ? r.givenMinutes : 0))).toEqual([15]);
    // Every one of it is the parent's or the phone's, in the activity log.
    const log = listAudit(db, { limit: 1000, includeReads: true });
    expect(log.some((e) => e.action === "request.answered" && e.parentName === "Jordan")).toBe(true);
    expect(log.some((e) => e.action === "phone.enrolled")).toBe(true);
  });

  it("has screen time with a limit, school and bedtime, a stage and an agreement", () => {
    const db = t.deps.db;
    const rules = phoneRules(db, seeded.deviceId);
    expect(rules.settings.measure).toBe(true);
    expect(rules.rules.limits.map((l) => l.name)).toEqual(["Games"]);
    expect(rules.rules.schedules.map((s) => s.kind).sort()).toEqual(["bedtime", "school"]);
    expect(phoneStage(db, seeded.deviceId)?.stage.name).toBe("Starter");
    expect(listStages(db).map((s) => s.name)).toEqual(["Starter", "Explorer", "Off belay"]);
    const agreement = currentAgreement(db, seeded.deviceId);
    expect([agreement?.version, agreement?.kidAnswer]).toEqual([1, "agree"]);
    const days = usageDays(db, seeded.deviceId);
    expect(days.length).toBeGreaterThanOrEqual(7);
    // Games never past the day's limit and its extra time: the phone pauses them once it's up.
    const games = new Set(rules.rules.limits[0]?.packages);
    for (const d of days) expect(d.apps.filter((a) => games.has(a.package)).reduce((n, a) => n + a.minutes, 0), d.day).toBeLessThanOrEqual(105);
  });

  it("leaves location and network logging off, for a parent to turn on", () => {
    expect(locationSettings(t.deps.db, seeded.deviceId)?.mode ?? "off").toBe("off");
    expect(networkSettings(t.deps.db, seeded.deviceId)?.enabled ?? false).toBe(false);
  });

  it("was made through the device API with only what its schemas accept", () => {
    expect(sent.filter((s) => s.problem !== null)).toEqual([]);
    expect(new Set(sent.map((s) => s.endpoint))).toEqual(new Set(["enroll", "checkin", "inventory", "events", "requests", "usage", "calls", "policy"]));
  });

  it("leaves the phone with the rules the server has, applied", () => {
    const device = getDevice(t.deps.db, seeded.deviceId, getSettings(t.deps.db), t.now());
    expect(device?.enforcement?.policy_version).toBe(policyVersion(t.deps.db, seeded.deviceId));
    expect(seeded.phone.policy?.version).toBe(policyVersion(t.deps.db, seeded.deviceId));
    expect(device?.problems).toEqual([]);
  });

  it("shows Getting started as the family has it, a week in: the phone and its rules done, notifications and the backup passphrase left", async () => {
    // As npm run demo starts the server's work: no backup passphrase, whatever the shell says.
    setOpsOptions(t.deps, { env: {} });
    const html = await (await get(t, "/", cookie)).text();
    const card = /<section class="card start"[\s\S]*?<\/section>/.exec(html)?.[0] ?? "";
    expect(card).toContain("2 of the 4 essential steps are done");
    expect(card).toContain(`${PHONE_NAME.replace("'", "&#39;")} is enrolled.`);
    expect(card).toContain(`${PHONE_NAME.replace("'", "&#39;")} applied its rules.`);
    expect(card).toContain("Not on in any of your browsers yet.");
    expect(card).toContain("Not set: the daily backups aren&#39;t encrypted");
    // The phone's own parts go to the demo phone's pages, which have its week.
    expect(card).toContain(`href="/devices/${seeded.deviceId}/calls"`);
    // After the phone's card: its status first.
    expect(html.indexOf(`href="/devices/${seeded.deviceId}"`)).toBeLessThan(html.indexOf('id="start"'));
  });

  const pages = (): [string, string][] => {
    const base = `/devices/${seeded.deviceId}`;
    const stage = listStages(t.deps.db)[0]?.id ?? "";
    return [
      ["Phones", "/"],
      ["a phone", base],
      ["the waiting app", `${base}/apps/${APPS.lanternChat.package}`],
      ["Screen time", `${base}/screen-time`],
      ["Screen-time rules", `${base}/screen-time/rules`],
      ["Agreement", `${base}/agreement`],
      ["Location and help", `${base}/location`],
      ["Calls", `${base}/calls`],
      ["Network", `${base}/network`],
      ["Mobile data", `${base}/mobile-data`],
      ["what's kept of a data category", `${base}/collection/apps`],
      ["Requests", "/requests"],
      ["Proposals", "/proposals"],
      ["Stages", "/stages"],
      ["Caregivers", "/caregivers"],
      ["a stage", `/stages/${stage}`],
      ["Timeline", "/timeline"],
      ["Add a phone", "/add"],
      ["Settings", "/settings"],
      ["Activity", "/activity"],
    ];
  };

  it("shows the banner on every parent page, and the pages keep their structure", async () => {
    for (const [name, path] of pages()) {
      const res = await get(t, path, cookie);
      expect(res.status, name).toBe(200);
      const html = await res.text();
      expect(html, name).toContain(BANNER);
      expect(structureProblems(html), name).toEqual([]);
    }
    // Signed out, connecting an AI app, and the links a parent is sent, too.
    for (const path of ["/login", "/oauth/authorize", "/invite/made-up"]) expect(await (await get(t, path)).text(), path).toContain(BANNER);
  });
});

describe("the demo's week, whenever and wherever it's made", () => {
  // The week is the one before now, in the computer's own timezone: some starts make awkward weeks.
  const starts: [string, string, string][] = [
    ["just after midnight, in a week whose clocks went back", "2026-11-03T05:10:00Z", "America/New_York"],
    ["late in the evening, in a week whose clocks went forward", "2026-03-10T04:55:00Z", "America/Los_Angeles"],
    ["before dawn, a half-hour zone", "2026-06-15T23:59:00Z", "Asia/Kolkata"],
    ["the evening the clocks go back, south of the equator", "2026-04-05T11:45:00Z", "Australia/Sydney"],
  ];
  for (const [when, iso, zone] of starts) {
    it(`is made ${when} (${zone})`, async () => {
      const now = Date.parse(iso);
      const t = testServer();
      const sent: Sent[] = [];
      const seeded = await seedDemo({ db: t.deps.db, config: t.deps.config, now, zone, password: "a made-up password for the demo", observe: (m, u, b) => sent.push(checkRequest(m, u, b)) });
      expect(sent.filter((s) => s.problem !== null)).toEqual([]);
      const waiting = recentRequests(t.deps.db, now, { limit: 50 }).filter((r) => r.status === "pending");
      expect(waiting.map((r) => r.id).sort()).toEqual([seeded.waiting.app, seeded.waiting.moreTime].sort());
      const days = usageDays(t.deps.db, seeded.deviceId);
      expect(days.length).toBeGreaterThanOrEqual(7);
      const games = new Set(phoneRules(t.deps.db, seeded.deviceId).rules.limits[0]?.packages);
      for (const d of days) expect(d.apps.filter((a) => games.has(a.package)).reduce((n, a) => n + a.minutes, 0), d.day).toBeLessThanOrEqual(105);
      // Nothing happened after now.
      const last = t.deps.db.prepare<[], { at: number }>("SELECT MAX(at) AS at FROM audit_log").get()?.at ?? 0;
      expect(last).toBeLessThanOrEqual(now);
    });
  }
});
