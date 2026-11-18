import { describe, expect, it } from "vitest";
import { createSession, newSetupToken } from "../src/auth/parents.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, event, get, PASSWORD, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

describe("first-run setup", () => {
  it("needs the one-time link from the server's log", async () => {
    const t = testServer();
    expect((await get(t, "/setup")).status).toBe(400);
    expect((await get(t, "/setup?token=wrong")).status).toBe(400);
    const token = newSetupToken(t.deps.db, t.now());
    const page = await get(t, `/setup?token=${token}`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Create the first parent account");
  });

  it("creates the first parent once, with a long enough password", async () => {
    const t = testServer();
    const token = newSetupToken(t.deps.db, t.now());
    const fields = { token, name: "Sam", username: "sam", password: PASSWORD, repeat: PASSWORD, timezone: "America/New_York" };
    const short = await postForm(t, "/setup", { ...fields, password: "short", repeat: "short" });
    expect(short.status).toBe(400);
    expect(await short.text()).toContain("at least 15 characters");

    const ok = await postForm(t, "/setup", fields);
    expect(ok.status).toBe(302);
    const setCookie = ok.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/^__Host-belay=[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain("Path=/");

    expect((await postForm(t, "/setup", { ...fields, username: "intruder" })).status).toBe(400);
    expect((await get(t, `/setup?token=${token}`)).status).toBe(302);
  });

  it("expires after a day", async () => {
    const t = testServer();
    const token = newSetupToken(t.deps.db, t.now());
    t.advance(24 * 3_600_000);
    expect((await get(t, `/setup?token=${token}`)).status).toBe(400);
  });
});

describe("signing in", () => {
  it("sends a signed-out visitor to the sign-in page", async () => {
    const t = testServer();
    await signIn(t);
    const res = await get(t, "/settings");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login?next=%2Fsettings");
  });

  it("checks the password, and returns only to paths on this site", async () => {
    const t = testServer();
    await signIn(t);
    expect((await postForm(t, "/login", { username: "sam", password: "wrong password here" })).status).toBe(401);
    const ok = await postForm(t, "/login", { username: "SAM", password: PASSWORD, next: "//evil.example/x" });
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe("/");
    const back = await postForm(t, "/login", { username: "sam", password: PASSWORD, next: "/timeline?device=x" });
    expect(back.headers.get("location")).toBe("/timeline?device=x");
  });

  it("slows down password guessing", async () => {
    const t = testServer();
    await signIn(t);
    for (let i = 0; i < 10; i++) expect((await postForm(t, "/login", { username: "sam", password: `guess number ${i}` })).status).toBe(401);
    const blocked = await postForm(t, "/login", { username: "sam", password: PASSWORD });
    expect(blocked.status).toBe(429);
    t.advance(15 * 60_000 + 1);
    expect((await postForm(t, "/login", { username: "sam", password: PASSWORD })).status).toBe(302);
  });

  it("signs out everywhere", async () => {
    const t = testServer();
    const a = await signIn(t);
    const other = createSession(t.deps.db, t.now(), a.parent.id);
    const otherCookie = `__Host-belay=${other.cookie}`;
    expect((await get(t, "/settings", otherCookie)).status).toBe(200);
    expect((await postForm(t, "/settings/sign-out-everywhere", { _csrf: a.csrf }, { cookie: a.cookie })).status).toBe(302);
    expect((await get(t, "/settings", otherCookie)).status).toBe(302);
    expect((await get(t, "/settings", a.cookie)).status).toBe(302);
  });

  it("adds a second parent with a one-time invite", async () => {
    const t = testServer();
    const a = await signIn(t);
    const page = await postForm(t, "/settings/invite", { _csrf: a.csrf }, { cookie: a.cookie });
    const link = /https:\/\/belay\.example\.org\/invite\/([A-Za-z0-9_-]{43})/.exec(await page.text());
    expect(link).not.toBeNull();
    const path = `/invite/${link![1]}`;
    expect((await get(t, path)).status).toBe(200);
    const joined = await postForm(t, path, { name: "Alex", username: "alex", password: PASSWORD, repeat: PASSWORD });
    expect(joined.status).toBe(302);
    expect((await postForm(t, path, { name: "Eve", username: "eve", password: PASSWORD, repeat: PASSWORD })).status).toBe(400);
    const settings = await get(t, "/settings", a.cookie);
    expect(await settings.text()).toContain("Alex");
  });
});

describe("CSRF", () => {
  it("refuses a form without the session's token", async () => {
    const t = testServer();
    const a = await signIn(t);
    const fields = { timezone: "America/New_York", silent_hours: "6", ai_scope: "apps" };
    expect((await postForm(t, "/settings", fields, { cookie: a.cookie })).status).toBe(403);
    expect((await postForm(t, "/settings", { ...fields, _csrf: "x".repeat(43) }, { cookie: a.cookie })).status).toBe(403);
    expect((await postForm(t, "/settings", { ...fields, _csrf: a.csrf }, { cookie: a.cookie })).status).toBe(302);
  });

  it("refuses a form from another site, even with the token", async () => {
    const t = testServer();
    const a = await signIn(t);
    const res = await postForm(t, "/settings/sign-out-everywhere", { _csrf: a.csrf }, { cookie: a.cookie, origin: "https://evil.example" });
    expect(res.status).toBe(403);
    expect((await get(t, "/settings", a.cookie)).status).toBe(200);
  });

  it("refuses a form too large to be one", async () => {
    const t = testServer();
    await signIn(t);
    const res = await postForm(t, "/login", { username: "sam", password: "x".repeat(70_000) });
    expect(res.status).toBe(413);
  });

  it("refuses a sign-in posted from another site", async () => {
    const t = testServer();
    await signIn(t);
    expect((await postForm(t, "/login", { username: "sam", password: PASSWORD }, { origin: "https://evil.example" })).status).toBe(403);
  });
});

describe("pages", () => {
  async function family() {
    const t = testServer();
    updateSettings(t.deps.db, { timezone: "America/New_York" });
    const a = await signIn(t);
    const phone = await enrollPhone(t, "Sam's phone");
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps"), pkg("com.android.settings", { system: true, source: "preinstalled" })], T0));
    return { t, a, phone };
  }

  it("list the phones with their status, and send headers that lock the page down", async () => {
    const { t, a } = await family();
    const res = await get(t, "/", a.cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Sam&#39;s phone");
    expect(body).toContain("OK");
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(res.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("report a silent phone plainly", async () => {
    const { t, a } = await family();
    t.advance(14 * 3_600_000);
    expect(await (await get(t, "/", a.cookie)).text()).toContain("Silent for 14 hours");
  });

  it("show a phone's user apps, with system apps on request, and escape what developers wrote", async () => {
    const { t, a, phone } = await family();
    await deviceCall(t, phone.token, "events", {
      events: [event("installed", "com.example.evil", { label: '<script>alert("hi")</script>', to: { code: 1 }, happened_at: T0 + 5 })],
    });
    const page = await (await get(t, `/devices/${phone.deviceId}`, a.cookie)).text();
    expect(page).toContain("maps");
    expect(page).not.toContain("com.android.settings");
    expect(page).not.toContain('<script>alert("hi")</script>');
    expect(page).toContain("&lt;script&gt;");
    const withSystem = await (await get(t, `/devices/${phone.deviceId}?system=1`, a.cookie)).text();
    expect(withSystem).toContain("com.android.settings");
  });

  it("mark apps reviewed, which clears their new badge", async () => {
    const { t, a, phone } = await family();
    const before = await (await get(t, `/devices/${phone.deviceId}`, a.cookie)).text();
    expect(before).toContain("1 new");
    const res = await postForm(t, `/devices/${phone.deviceId}/review`, { _csrf: a.csrf, package: ["com.example.maps"], note: "Fine for school" }, { cookie: a.cookie });
    expect(res.headers.get("location")).toBe(`/devices/${phone.deviceId}?reviewed=1`);
    const after = await (await get(t, `/devices/${phone.deviceId}/apps/com.example.maps`, a.cookie)).text();
    expect(after).toContain("Fine for school");
    expect(after).toContain("on the web");
  });

  it("group the timeline by day in the family's timezone", async () => {
    const { t, a, phone } = await family();
    // 23:30 in New York on Sunday Nov 15 is 04:30 UTC on Monday Nov 16.
    const lateSunday = Date.UTC(2026, 10, 16, 4, 30);
    await deviceCall(t, phone.token, "events", {
      events: [event("installed", "com.example.chat", { to: { code: 1 }, happened_at: lateSunday, detected_at: lateSunday })],
    });
    const page = await (await get(t, "/timeline", a.cookie)).text();
    expect(page).toContain("Sunday, November 15, 2026");
    expect(page).toContain("11:30 PM");
    expect(page).toContain("2026-11-15T23:30:00-05:00");
    expect(page).not.toContain("Monday, November 16, 2026");
  });

  it("make an enrollment code with a QR code", async () => {
    const { t, a } = await family();
    const res = await postForm(t, "/add", { _csrf: a.csrf, name: "Second phone" }, { cookie: a.cookie });
    expect(res.status).toBe(200);
    const page = await res.text();
    expect(page).toContain("<svg");
    expect(page).toMatch(/belay:\/\/enroll\?server=https%3A%2F%2Fbelay\.example\.org&amp;code=[0-9A-Z]{8}/);
    expect(page).toMatch(/provision\.sh --server https:\/\/belay\.example\.org --code [0-9A-Z]{8}/);
    expect(await (await get(t, "/", a.cookie)).text()).toContain("Waiting to enroll");
  });

  it("point to the setup kit for a computer without the Android SDK: a link, not a request", async () => {
    const { t, a } = await family();
    const page = await (await get(t, "/add", a.cookie)).text();
    expect(page).toContain('kit does the same from Chrome or Edge, with Docker: <a href="https://github.com/brooker-fam/belay/blob/main/docs/setup-kit.md">docs/setup-kit.md</a>.');
  });

  it("disconnect a phone, which stops its token", async () => {
    const { t, a, phone } = await family();
    await postForm(t, `/devices/${phone.deviceId}/disconnect`, { _csrf: a.csrf }, { cookie: a.cookie });
    expect((await deviceCall(t, phone.token, "checkin", {})).status).toBe(401);
    expect(await (await get(t, "/", a.cookie)).text()).toContain("Disconnected");
  });

  it("log who did what", async () => {
    const { t, a, phone } = await family();
    await postForm(t, `/devices/${phone.deviceId}/review`, { _csrf: a.csrf, package: "com.example.maps" }, { cookie: a.cookie });
    const page = await (await get(t, "/activity", a.cookie)).text();
    expect(page).toContain("Sam on the web");
    expect(page).toContain("marked maps reviewed");
    expect(page).toContain("enrolled (Pixel 8)");
  });
});
