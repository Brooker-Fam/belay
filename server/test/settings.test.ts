/**
 * What AI apps may read: a category added in an upgrade starts off for a family that turned any
 * off, and the settings page marks it new until the family saves (the security review's "new AI
 * scope defaults on after upgrade").
 */
import { describe, expect, it } from "vitest";
import { getSettings, updateSettings } from "../src/settings.js";
import { get, postForm, signIn, testServer, type TestServer } from "./helpers.js";

/** What an older server stored when a parent saved the Settings page. */
const stored = (t: TestServer, scopes: Record<string, boolean>) =>
  t.deps.db.prepare("INSERT INTO settings (key, value) VALUES ('ai_scopes', ?)").run(JSON.stringify(scopes));

describe("AI scopes after an upgrade", () => {
  it("a family that turned every earlier one off gets the new one off too", () => {
    const t = testServer();
    stored(t, { apps: false, device_status: false });
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: false, device_status: false, requests: false }, newAiScopes: ["requests"] });
  });

  it("so does a family that turned only one off", () => {
    const t = testServer();
    stored(t, { apps: true, device_status: false });
    expect(getSettings(t.deps.db).aiScopes).toEqual({ apps: true, device_status: false, requests: false });
  });

  it("a family that left them all on gets the new one on, marked new", () => {
    const t = testServer();
    stored(t, { apps: true, device_status: true });
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, device_status: true, requests: true }, newAiScopes: ["requests"] });
  });

  it("a family that never saved them gets the defaults, with nothing marked new", () => {
    const t = testServer();
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, device_status: true, requests: true }, newAiScopes: [] });
    updateSettings(t.deps.db, { aiScopes: { requests: false } });
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: true, device_status: true, requests: false }, newAiScopes: [] });
  });

  it("the Settings page marks the new one until the family saves", async () => {
    const t = testServer();
    const sam = await signIn(t);
    stored(t, { apps: false, device_status: true });
    let html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain("Because you turned something off before, it starts off: tick it to let AI apps read it.");
    expect(html).toContain('<input type="checkbox" name="ai_scope" value="requests"/> Requests: what the kid asks for, and why, in their words<span class="chip new">new</span>');
    const res = await postForm(t, "/settings", { _csrf: sam.csrf, timezone: "UTC", silent_hours: "12", ai_scope: ["device_status", "requests"] }, { cookie: sam.cookie });
    expect(res.status).toBe(302);
    expect(getSettings(t.deps.db)).toMatchObject({ aiScopes: { apps: false, device_status: true, requests: true }, newAiScopes: [] });
    html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).not.toContain('<span class="chip new">new</span>');
  });
});
