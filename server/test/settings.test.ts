/**
 * What AI apps may read: a category added in an upgrade starts off for a family that turned any
 * off, and the settings page marks it new until the family saves (the security review's "new AI
 * scope defaults on after upgrade").
 */
import { describe, expect, it } from "vitest";
import { audit, listAudit } from "../src/audit.js";
import { cleanUp } from "../src/maintenance.js";
import { ACTIVITY_DAYS, getSettings, updateSettings } from "../src/settings.js";
import { get, postForm, signIn, testServer, type TestServer } from "./helpers.js";

const DAY = 86_400_000;

/** What an older server stored when a parent saved the Settings page. */
const stored = (t: TestServer, scopes: Record<string, boolean>) =>
  t.deps.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_scopes', ?)").run(JSON.stringify(scopes));

describe("AI scopes after an upgrade", () => {
  it("a family that turned every earlier one off gets the new one off too", () => {
    const t = testServer();
    stored(t, { apps: false, device_status: false });
    expect(getSettings(t.deps.db)).toMatchObject({
      aiScopes: { apps: false, device_status: false, requests: false, screen_time: false, agreement: false },
      newAiScopes: ["requests", "screen_time", "agreement", "location", "calls"],
    });
  });

  it("so does a family that turned only one off", () => {
    const t = testServer();
    stored(t, { apps: true, device_status: false });
    expect(getSettings(t.deps.db).aiScopes).toEqual({ apps: true, device_status: false, requests: false, screen_time: false, agreement: false, location: false, calls: false });
  });

  it("a family that left them all on gets the new one on, marked new", () => {
    const t = testServer();
    stored(t, { apps: true, device_status: true });
    expect(getSettings(t.deps.db)).toMatchObject({
      aiScopes: { apps: true, device_status: true, requests: true, screen_time: true, agreement: true },
      newAiScopes: ["requests", "screen_time", "agreement", "location", "calls"],
    });
  });

  it("Phase 3's screen time and agreement start off for a Phase 2 family that turned requests off", () => {
    const t = testServer();
    stored(t, { apps: true, device_status: true, requests: false });
    expect(getSettings(t.deps.db)).toMatchObject({
      aiScopes: { apps: true, device_status: true, requests: false, screen_time: false, agreement: false },
      newAiScopes: ["screen_time", "agreement", "location", "calls"],
    });
  });

  it("location starts off for every family: one that left everything on, and one that never saved", async () => {
    const t = testServer();
    expect(getSettings(t.deps.db).aiScopes.location).toBe(false);
    stored(t, { apps: true, device_status: true, requests: true, screen_time: true, agreement: true });
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, location: false, calls: false }, newAiScopes: ["location", "calls"] });
    const sam = await signIn(t);
    const html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain("It starts off for every family: tick it to let AI apps read it.");
    expect(html).toContain('value="location"/> Location: where the phone is');
    expect(updateSettings(t.deps.db, { aiScopes: { location: true } }).aiScopes.location).toBe(true);
  });

  it("a family that never saved them gets the defaults, with nothing marked new", () => {
    const t = testServer();
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, device_status: true, requests: true, screen_time: true, agreement: true }, newAiScopes: [] });
    updateSettings(t.deps.db, { aiScopes: { requests: false } });
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, device_status: true, requests: false, screen_time: true, agreement: true }, newAiScopes: [] });
  });

  it("keeps 13 months of screen time unless the family chooses 1 to 36", () => {
    const t = testServer();
    expect(getSettings(t.deps.db).usageMonths).toBe(13);
    expect(updateSettings(t.deps.db, { usageMonths: 6 }).usageMonths).toBe(6);
    expect(() => updateSettings(t.deps.db, { usageMonths: 0 })).toThrow();
    expect(() => updateSettings(t.deps.db, { usageMonths: 37 })).toThrow();
    t.deps.db.prepare("UPDATE settings SET value = '\"lots\"' WHERE key = 'usage_months'").run();
    expect(getSettings(t.deps.db).usageMonths).toBe(13);
  });

  it("the Settings page marks the new one until the family saves", async () => {
    const t = testServer();
    const sam = await signIn(t);
    stored(t, { apps: false, device_status: true });
    let html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain("Because you turned something off before, it starts off: tick it to let AI apps read it.");
    expect(html).toContain('<input type="checkbox" name="ai_scope" value="requests"/> Requests: what the kid asks for, and why, in their words, including &quot;I need help&quot; and &quot;Talk to my parent&quot;<span class="chip new">new</span>');
    const res = await postForm(t, "/settings", { _csrf: sam.csrf, timezone: "UTC", silent_hours: "12", ai_scope: ["device_status", "requests"] }, { cookie: sam.cookie });
    expect(res.status).toBe(302);
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: false, device_status: true, requests: true }, newAiScopes: [] });
    html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).not.toContain('<span class="chip new">new</span>');
  });
});

describe("the activity log", () => {
  it(`is kept ${ACTIVITY_DAYS.default} days unless the family chooses ${ACTIVITY_DAYS.min} to ${ACTIVITY_DAYS.max}`, () => {
    const t = testServer();
    expect(getSettings(t.deps.db).activityDays).toBe(400);
    expect(updateSettings(t.deps.db, { activityDays: 90 }).activityDays).toBe(90);
    // Never less than a month: what a parent did can't vanish before the other parent could see it.
    expect(() => updateSettings(t.deps.db, { activityDays: 29 })).toThrow();
    expect(() => updateSettings(t.deps.db, { activityDays: 3651 })).toThrow();
    expect(() => updateSettings(t.deps.db, { activityDays: 45.5 })).toThrow();
    t.deps.db.prepare("UPDATE settings SET value = '7' WHERE key = 'activity_days'").run();
    expect(getSettings(t.deps.db).activityDays).toBe(400);
  });

  it("the hourly clean-up deletes the entries older than the family keeps it, and keeps the rest", () => {
    const t = testServer();
    const server = { kind: "server" } as const;
    audit(t.deps.db, t.now() - 401 * DAY, server, "backup.verified", { detail: { ok: true, file: "old" } });
    audit(t.deps.db, t.now() - 399 * DAY, server, "backup.verified", { detail: { ok: true, file: "kept" } });
    audit(t.deps.db, t.now() - 5 * DAY, server, "backup.verified", { detail: { ok: true, file: "recent" } });
    const files = () => listAudit(t.deps.db, { limit: 10, includeReads: true }).map((e) => e.detail?.file);
    cleanUp(t.deps.db, t.now());
    expect(files()).toEqual(["recent", "kept"]);
    updateSettings(t.deps.db, { activityDays: 30 });
    cleanUp(t.deps.db, t.now());
    expect(files()).toEqual(["recent"]);
  });

  it("the Settings page shows and saves how long it's kept, and refuses less than a month", async () => {
    const t = testServer();
    const sam = await signIn(t);
    const html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain("Keep the activity log for this many days, then delete older entries (30 at least)");
    expect(html).toContain('name="activity_days" min="30" max="3650" required="" value="400"');
    const save = (days: string) => postForm(t, "/settings", { _csrf: sam.csrf, timezone: "UTC", silent_hours: "12", activity_days: days, ai_scope: ["apps"] }, { cookie: sam.cookie });
    expect((await save("731")).status).toBe(302);
    expect(getSettings(t.deps.db).activityDays).toBe(731);
    const refused = await save("7");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Keep the activity log 30 to 3650 days.");
    expect(getSettings(t.deps.db).activityDays).toBe(731);
    // The change itself is in the log, with what it was before.
    expect(listAudit(t.deps.db, { limit: 5, includeReads: false }).find((e) => e.action === "settings.changed")?.detail).toMatchObject({ before: { activityDays: 400 }, after: { activityDays: 731 } });
  });
});
