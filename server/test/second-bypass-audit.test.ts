/**
 * The second bypass audit's B1: a parent's password, seen over a shoulder and typed into the kid's
 * own phone, signed in silently. Now every sign-in that makes a session (the sign-in page, the
 * OAuth sign-in screen an MCP client opens, the setup link, an invite, a caregiver's sign-in and
 * link) writes the kind of browser into the activity log and pushes a notice to every parent's
 * browsers at once, urgent, past every limit, each on a page of its own, never with the client's
 * address; Settings lists a parent's signed-in browsers with Sign out for each; a restore drill's
 * copy sends nothing. Made-up names only.
 */
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { browserKind } from "../src/auth/browsers.js";
import { createSession, listSessions, newSetupToken } from "../src/auth/parents.js";
import { signInNotice } from "../src/auth/signins.js";
import { pkceChallenge } from "../src/crypto.js";
import { listCaregivers } from "../src/family/caregivers/store.js";
import { DRILL_KEY } from "../src/ops/verify.js";
import { browserName } from "../src/push.js";
import { updateSettings } from "../src/settings.js";
import { browserFor, enrollPhone, get, PASSWORD, postForm, signIn, testServer, type TestServer } from "./helpers.js";

const CHROME_ANDROID = "Mozilla/5.0 (Linux; Android 17; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36";
const SAFARI_IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1";
const CHROME_MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
/** The client's address: never in a notice, the activity log or a session. */
const ADDRESS = "203.0.113.77";
const AT = "Nov 16, 2026, 10:00 AM";
const TITLE = "Belay: a new sign-in";

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t, "sam", "Sam");
  const alex = await signIn(t, "alex", "Alex");
  const samBrowser = browserFor(t, sam.parent.id, () => fetch.mock.calls);
  const alexBrowser = browserFor(t, alex.parent.id, () => fetch.mock.calls);
  return { t, fetch, sam, alex, samBrowser, alexBrowser };
}

const from = (userAgent: string) => ({ headers: { "user-agent": userAgent, "x-forwarded-for": ADDRESS } });
const newest = (t: TestServer) => listAudit(t.deps.db, { limit: 1, includeReads: false })[0];
const newestSession = (t: TestServer, parentId: string) => listSessions(t.deps.db, parentId, t.now())[0];

/** Nothing the server keeps or pushes about a sign-in has the client's address. */
function noAddress(t: TestServer, pushed: unknown) {
  const kept = JSON.stringify([t.deps.db.prepare("SELECT * FROM audit_log").all(), t.deps.db.prepare("SELECT * FROM sessions").all(), t.deps.db.prepare("SELECT * FROM caregiver_sessions").all()]);
  expect(kept).not.toContain("203.0.113");
  expect(JSON.stringify(pushed)).not.toContain("203.0.113");
}

describe("a parent's sign-in, by any path, reaches every parent at once (B1)", () => {
  it("the sign-in page: an urgent notice to each parent, the browser in the activity log, never the address", async () => {
    const { t, fetch, sam, alex, samBrowser, alexBrowser } = await family();
    const res = await postForm(t, "/login", { username: "sam", password: PASSWORD }, from(CHROME_ANDROID));
    expect(res.status).toBe(302);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const entry = newest(t);
    expect(entry).toMatchObject({ actor: "parent", parentId: sam.parent.id, action: "parent.signed_in", detail: { browser: "Chrome on Android" } });
    const session = newestSession(t, sam.parent.id);
    expect(session?.browser).toBe("Chrome on Android");
    expect(samBrowser.notices()).toEqual([
      {
        title: TITLE,
        body: `Sam signed in on Chrome on Android (${AT}). If that wasn't you, sign that browser out in Settings and change your password.`,
        url: `/settings#browser-${session?.id}`,
        urgent: true,
        urgency: "high",
      },
    ]);
    expect(alexBrowser.notices()).toEqual([
      {
        title: TITLE,
        body: `Sam signed in on Chrome on Android (${AT}). If that wasn't Sam, tell them: they can sign it out in their Settings and change their password.`,
        url: `/activity#entry-${entry?.id}`,
        urgent: true,
        urgency: "high",
      },
    ]);
    noAddress(t, [samBrowser.notices(), alexBrowser.notices()]);
    // The activity log says it, and the notice's tap lands on that line.
    const html = await (await get(t, "/activity", alex.cookie)).text();
    expect(html).toContain(`id="entry-${entry?.id}"`);
    expect(html).toContain("<strong>Sam on the web</strong> signed in on Chrome on Android");
    expect(html).not.toContain("203.0.113");
  });

  it("a wrong password tells no one", async () => {
    const { t, fetch } = await family();
    expect((await postForm(t, "/login", { username: "sam", password: "not the password at all" }, from(CHROME_ANDROID))).status).toBe(401);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("the OAuth sign-in screen an MCP client opens is a sign-in too: it says it was to connect an AI app", async () => {
    const { t, fetch, sam, samBrowser, alexBrowser } = await family();
    const reg = await t.app.request("/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Inspector", redirect_uris: ["http://localhost:6274/oauth/callback"], token_endpoint_auth_method: "none" }),
    });
    const client = (await reg.json()) as { client_id: string };
    const params = {
      client_id: client.client_id,
      redirect_uri: "http://localhost:6274/oauth/callback",
      response_type: "code",
      state: "state-1",
      code_challenge: pkceChallenge("v".repeat(50)),
      code_challenge_method: "S256",
      resource: "https://belay.example.org/mcp",
      scope: "belay",
    };
    const res = await postForm(t, "/oauth/authorize", { ...params, username: "sam", password: PASSWORD }, from(CHROME_ANDROID));
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Connect to Belay?");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const entry = newest(t);
    expect(entry).toMatchObject({ action: "parent.signed_in", detail: { browser: "Chrome on Android", to: "connect_ai" } });
    expect(samBrowser.notices()[0]?.body).toBe(
      `Sam signed in on Chrome on Android to connect an AI app (${AT}). If that wasn't you, sign that browser out in Settings, disconnect any AI app you don't know, and change your password.`,
    );
    expect(samBrowser.notices()[0]?.url).toBe(`/settings#browser-${newestSession(t, sam.parent.id)?.id}`);
    expect(alexBrowser.notices()[0]).toMatchObject({ url: `/activity#entry-${entry?.id}`, urgent: true, urgency: "high" });
    expect(alexBrowser.notices()[0]?.body).toContain("If that wasn't Sam, tell them");
    noAddress(t, [samBrowser.notices(), alexBrowser.notices()]);
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("signed in on Chrome on Android, to connect an AI app");
  });

  it("an invite: every parent hears that someone joined as a parent, and on what", async () => {
    const { t, fetch, sam, samBrowser, alexBrowser } = await family();
    const page = await postForm(t, "/settings/invite", { _csrf: sam.csrf }, { cookie: sam.cookie });
    const token = /\/invite\/([A-Za-z0-9_-]{43})/.exec(await page.text())?.[1] ?? "";
    const joined = await postForm(t, `/invite/${token}`, { name: "Robin", username: "robin", password: PASSWORD, repeat: PASSWORD }, from(SAFARI_IPHONE));
    expect(joined.status).toBe(302);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const entry = newest(t);
    expect(entry).toMatchObject({ action: "parent.joined", detail: { browser: "Safari on iPhone" } });
    for (const browser of [samBrowser, alexBrowser]) {
      expect(browser.notices()).toEqual([
        {
          title: TITLE,
          body: `Robin joined Belay as a parent, on Safari on iPhone (${AT}). If you didn't invite them, remove them in Settings.`,
          url: `/activity#entry-${entry?.id}`,
          urgent: true,
          urgency: "high",
        },
      ]);
    }
    noAddress(t, [samBrowser.notices()]);
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("<strong>Robin on the web</strong> joined as a parent, signed in on Safari on iPhone");
  });

  it("the first-run setup link: the activity log has the browser (no parent had a browser to tell yet)", async () => {
    const fetch = vi.fn(() => Promise.resolve(new Response(null, { status: 201 })));
    const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
    const token = newSetupToken(t.deps.db, t.now());
    const fields = { token, name: "Sam", username: "sam", password: PASSWORD, repeat: PASSWORD, timezone: "America/New_York" };
    expect((await postForm(t, "/setup", fields, from(CHROME_MAC))).status).toBe(302);
    expect(newest(t)).toMatchObject({ action: "parent.setup", detail: { browser: "Chrome on a Mac" } });
    const parentId = newest(t)?.parentId ?? "";
    expect(newestSession(t, parentId)?.browser).toBe("Chrome on a Mac");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    noAddress(t, []);
    const cookie = `__Host-belay=${createSession(t.deps.db, t.now(), parentId).cookie}`;
    expect(await (await get(t, "/activity", cookie)).text()).toContain("set up Belay, signed in on Chrome on a Mac");
  });

  it("no limit swallows one: past the per-phone notice limits and the test notices', every sign-in still goes, each on a page of its own", async () => {
    const { t, fetch, sam, samBrowser, alexBrowser } = await family();
    const phone = await enrollPhone(t, "Jamie's phone");
    // Use up what limits there are on the parents' notices.
    for (let i = 0; i < 10; i++) {
      t.deps.limits.noticesPerPhone.hit(phone.deviceId);
      t.deps.limits.helpNoticesPerPhone.hit(phone.deviceId);
    }
    for (let i = 0; i < 6; i++) await postForm(t, "/settings/push/test", { _csrf: sam.csrf }, { cookie: sam.cookie });
    fetch.mockClear();
    for (let i = 0; i < 12; i++) {
      expect((await postForm(t, "/login", { username: "sam", password: PASSWORD }, from(CHROME_ANDROID))).status).toBe(302);
      t.advance(1000);
    }
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(24);
    });
    const signIns = (notices: { url: string; title: string }[]) => notices.filter((n) => n.title === TITLE);
    expect(signIns(samBrowser.notices())).toHaveLength(12);
    expect(signIns(alexBrowser.notices())).toHaveLength(12);
    // sw.js shows one notice per page: each sign-in's page is its own, so none replaces another.
    expect(new Set(signIns(samBrowser.notices()).map((n) => n.url)).size).toBe(12);
    expect(new Set(signIns(alexBrowser.notices()).map((n) => n.url)).size).toBe(12);
  });

  it("a restore drill's copy sends nothing, but keeps the line", async () => {
    const { t, fetch } = await family();
    t.deps.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(DRILL_KEY, JSON.stringify({ at: t.now(), from: "belay-2026-11-16.db.enc" }));
    expect((await postForm(t, "/login", { username: "sam", password: PASSWORD }, from(CHROME_MAC))).status).toBe(302);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).not.toHaveBeenCalled();
    expect(newest(t)).toMatchObject({ action: "parent.signed_in", detail: { browser: "Chrome on a Mac" } });
  });

  it("entries from before keep their words", async () => {
    const { t, sam } = await family();
    t.deps.db.prepare("INSERT INTO audit_log (at, actor, parent_id, action) VALUES (?, 'parent', ?, 'parent.signed_in')").run(t.now(), sam.parent.id);
    const html = await (await get(t, "/activity", sam.cookie)).text();
    expect(html).toMatch(/<strong>Sam on the web<\/strong> signed in<\/div>/);
  });
});

describe("a caregiver's sign-in reaches every parent too (B1)", () => {
  async function withCaregiver() {
    const f = await family();
    await enrollPhone(f.t, "Jamie's phone");
    const phoneId = f.t.deps.db.prepare<[], { id: string }>("SELECT id FROM devices").get()?.id ?? "";
    const res = await postForm(f.t, "/caregivers", { _csrf: f.sam.csrf, name: "Grandma", phone: [phoneId], can: ["status", "pause", "help"], until: "2026-11-19T18:00" }, { cookie: f.sam.cookie });
    const token = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await res.text())?.[1] ?? "";
    const caregiver = listCaregivers(f.t.deps.db).find((c) => c.name === "Grandma");
    // Her own browser, for help requests: never told of sign-ins.
    const hers = browserFor(f.t, caregiver?.id ?? "", () => f.fetch.mock.calls, "caregiver");
    return { ...f, token, caregiverId: caregiver?.id ?? "", hers };
  }

  it("joining with her link, then signing in: each parent hears of each, with the browser, never the address", async () => {
    const { t, fetch, token, caregiverId, samBrowser, alexBrowser, hers, sam } = await withCaregiver();
    fetch.mockClear();
    expect((await postForm(t, `/care/join/${token}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD }, from(SAFARI_IPHONE))).status).toBe(302);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const joined = newest(t);
    expect(joined).toMatchObject({ actor: "caregiver", caregiverName: "Grandma", action: "caregiver.joined", detail: { browser: "Safari on iPhone" } });
    const joinedNotice = {
      title: TITLE,
      body: `Grandma joined as a caregiver, on Safari on iPhone (${AT}). If that wasn't them, end their access on the Caregivers page.`,
      url: `/activity#entry-${joined?.id}`,
      urgent: true,
      urgency: "high",
    };
    expect(samBrowser.notices()).toEqual([joinedNotice]);
    expect(alexBrowser.notices()).toEqual([joinedNotice]);

    t.advance(60_000);
    expect((await postForm(t, "/care/login", { username: "grandma", password: PASSWORD }, from(CHROME_ANDROID))).status).toBe(302);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    const signedIn = newest(t);
    expect(signedIn).toMatchObject({ actor: "caregiver", action: "caregiver.signed_in", detail: { browser: "Chrome on Android" } });
    expect(samBrowser.notices()[1]).toEqual({
      title: TITLE,
      body: "Grandma signed in to their caregiver page on Chrome on Android (Nov 16, 2026, 10:01 AM). If that wasn't them, end their access on the Caregivers page.",
      url: `/activity#entry-${signedIn?.id}`,
      urgent: true,
      urgency: "high",
    });
    expect(hers.notices()).toEqual([]);
    noAddress(t, [samBrowser.notices(), alexBrowser.notices()]);
    expect(caregiverId).not.toBe("");
    const html = await (await get(t, "/activity", sam.cookie)).text();
    expect(html).toContain("<strong>Grandma (caregiver)</strong> joined as a caregiver, signed in on Safari on iPhone");
    expect(html).toContain("<strong>Grandma (caregiver)</strong> signed in to their caregiver page on Chrome on Android");
  });

  it("a new password with a new link says so", async () => {
    const { t, fetch, token, caregiverId, sam, samBrowser } = await withCaregiver();
    await postForm(t, `/care/join/${token}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD }, from(SAFARI_IPHONE));
    const res = await postForm(t, `/caregivers/${caregiverId}/link`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    const again = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await res.text())?.[1] ?? "";
    expect(again).not.toBe("");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    fetch.mockClear();
    expect((await postForm(t, `/care/join/${again}`, { username: "grandma", password: `${PASSWORD} again`, repeat: `${PASSWORD} again` }, from(SAFARI_IPHONE))).status).toBe(302);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(newest(t)).toMatchObject({ action: "caregiver.joined", detail: { browser: "Safari on iPhone", again: true } });
    expect(samBrowser.notices().at(-1)?.body).toBe(
      `Grandma chose a new password with a sign-in link, on Safari on iPhone (${AT}). If that wasn't them, end their access on the Caregivers page.`,
    );
  });
});

describe("Settings → Your account: where you're signed in (B1)", () => {
  it("lists only your own browsers, newest first, with the kind of each and Sign out", async () => {
    const { t, sam } = await family();
    t.advance(60_000);
    await postForm(t, "/login", { username: "sam", password: PASSWORD }, from(CHROME_ANDROID));
    t.advance(60_000);
    await postForm(t, "/login", { username: "alex", password: PASSWORD }, from(SAFARI_IPHONE));
    const phone = newestSession(t, sam.parent.id);
    const html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain("Where you&#39;re signed in");
    expect(html).toContain(`id="browser-${phone?.id}"`);
    expect(html).toContain("<strong>Chrome on Android</strong>");
    expect(html).not.toContain("Safari on iPhone");
    // The helper's session is from before Belay noted browsers: this one.
    expect(html).toContain("<strong>A browser from before Belay noted which</strong>");
    expect(html).toContain('<span class="chip">this browser</span>');
    expect(html).toContain(`action="/settings/browsers/${phone?.id}/sign-out"`);
    expect(html.indexOf("Chrome on Android")).toBeLessThan(html.indexOf("A browser from before Belay noted which"));
  });

  it("Sign out ends that browser's session only, in the activity log; another parent's can't be signed out from here", async () => {
    const { t, sam, alex } = await family();
    const res = await postForm(t, "/login", { username: "sam", password: PASSWORD }, from(CHROME_ANDROID));
    const kidsCookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    expect((await get(t, "/settings", kidsCookie)).status).toBe(200);
    const kids = newestSession(t, sam.parent.id);
    // Alex can't sign out Sam's browser: it isn't Alex's.
    expect((await postForm(t, `/settings/browsers/${kids?.id}/sign-out`, { _csrf: alex.csrf }, { cookie: alex.cookie })).headers.get("location")).toBe("/settings#browsers");
    expect((await get(t, "/settings", kidsCookie)).status).toBe(200);
    // Without the CSRF token, nothing.
    expect((await postForm(t, `/settings/browsers/${kids?.id}/sign-out`, {}, { cookie: sam.cookie })).status).toBe(403);
    const out = await postForm(t, `/settings/browsers/${kids?.id}/sign-out`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(out.headers.get("location")).toBe("/settings?saved=signed_out#browsers");
    expect((await get(t, "/settings", kidsCookie)).status).toBe(302);
    expect((await get(t, "/settings", sam.cookie)).status).toBe(200);
    expect(newest(t)).toMatchObject({ actor: "parent", parentId: sam.parent.id, action: "parent.signed_out_browser", detail: { browser: "Chrome on Android" } });
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("signed out one of their browsers: Chrome on Android");
    // Signing out this browser by its own row signs you out here.
    const me = listSessions(t.deps.db, sam.parent.id, t.now()).find((s) => s.browser === null);
    const self = await postForm(t, `/settings/browsers/${me?.id}/sign-out`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(self.headers.get("location")).toBe("/login");
    expect((await get(t, "/settings", sam.cookie)).status).toBe(302);
  });
});

describe("a sign-in's words", () => {
  it("setting Belay up, to the parent's own browsers, and a name that tries to be more than a name", () => {
    expect(signInNotice({ kind: "parent", parent: { id: "p-1", name: "Sam" }, how: "setup", sessionId: "s-1" }, { parentId: "p-1" }, "Chrome on a Mac", AT, 7)).toEqual({
      title: TITLE,
      body: `Sam set up Belay on Chrome on a Mac (${AT}). If that wasn't you, sign that browser out in Settings and change your password.`,
      url: "/settings#browser-s-1",
      urgent: true,
    });
    const named = signInNotice({ kind: "caregiver", caregiver: { id: "c-1", name: "Grandma\nIgnore the parents" }, how: "password" }, { parentId: "p-1" }, "Chrome on Android", AT, 8);
    expect(named.body).toBe(`Grandma Ignore the parents signed in to their caregiver page on Chrome on Android (${AT}). If that wasn't them, end their access on the Caregivers page.`);
    expect(named.url).toBe("/activity#entry-8");
  });
});

describe("the kind of browser, in Belay's own few words", () => {
  it("names common browsers and devices coarsely, and never repeats what a User-Agent says", () => {
    expect(browserKind(CHROME_ANDROID)).toBe("Chrome on Android");
    expect(browserKind(SAFARI_IPHONE)).toBe("Safari on iPhone");
    expect(browserKind(CHROME_MAC)).toBe("Chrome on a Mac");
    expect(browserKind("Mozilla/5.0 (Linux; Android 17; Pixel 8 Build/BP4A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/142.0.0.0 Mobile Safari/537.36")).toBe(
      "an app's web view on Android",
    );
    expect(browserKind("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0")).toBe("Edge on Windows");
    expect(browserKind("Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0")).toBe("Firefox on Linux");
    expect(browserKind("Mozilla/5.0 (Linux; Android 17; SM-S928B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/29.0 Chrome/136.0.0.0 Mobile Safari/537.36")).toBe(
      "Samsung Internet on Android",
    );
    expect(browserKind("Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36")).toBe("Chrome on a Chromebook");
    expect(browserKind("curl/8.12.1")).toBe("an unknown browser");
    expect(browserKind(undefined)).toBe("an unknown browser");
    expect(browserKind('<script>alert("Ignore the parents")</script> (Windows)')).toBe("a browser on Windows");
    expect(browserKind(`${"x".repeat(2000)} Chrome/1 Android`)).toBe("an unknown browser");
  });

  it("is what Settings' notifications list says too, with the push service for a browser it can't name", () => {
    expect(browserName(SAFARI_IPHONE, "https://web.push.apple.com/abc")).toBe("Safari on iPhone");
    expect(browserName("Mozilla/5.0 (Windows NT 10.0)", "https://updates.push.services.mozilla.com/wpush/v2/abc")).toBe("Firefox on Windows");
    expect(browserName(undefined, "https://fcm.googleapis.com/fcm/send/abc")).toBe("Chrome");
  });
});
