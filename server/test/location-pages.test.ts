/**
 * Phases 4 and 7 on the parent pages: a phone's Location and help tab (sharing, the last fix in
 * words, Check now, the checks, places, lost mode, the numbers), the help card at the top of the
 * Requests page with "Call" and "I've seen it", and Settings' new parts. Server-rendered, CSRF on
 * every form, no map embedded. Made-up places and names only.
 */
import { describe, expect, it, vi } from "vitest";
import { createFixWaiters } from "../src/device/fixwaiters.js";
import { Policy } from "../src/device/schemas.js";
import { locateNow } from "../src/family/location/changes.js";
import { listPlaces } from "../src/family/location/store.js";
import { buildPolicy } from "../src/family/policy.js";
import { getRequest } from "../src/family/requests.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, fix, get, north, postForm, signIn, SPOT, testServer } from "./helpers.js";

async function family(opts: { locateWaitMs?: number } = {}) {
  const t = testServer({ locateWaitMs: opts.locateWaitMs });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const base = `/devices/${phone.deviceId}`;
  const form = (path: string, fields: Record<string, string | string[]>, csrf = true) => postForm(t, path, { ...(csrf ? { _csrf: sam.csrf } : {}), ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => {
    const res = await get(t, path, sam.cookie);
    return { status: res.status, html: await res.text() };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const locations = (fixes: unknown[], events: unknown[] = []) => deviceCall(t, phone.token, "locations", { fixes, place_events: events });
  return { t, sam, phone, base, form, page, policy, locations };
}

const PERIODIC = { mode: "periodic", every: "20", hours_start: "07:00", hours_end: "21:00", provider: "gps", keep_on: "1" };

describe("the Location and help tab", () => {
  it("needs a parent signed in, and every form needs the CSRF token", async () => {
    const { t, base, form } = await family();
    const res = await get(t, `${base}/location`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    for (const path of [
      `${base}/location`,
      `${base}/location/check`,
      `${base}/location/places`,
      `${base}/location/places/p-1/remove`,
      `${base}/location/lost`,
      `${base}/numbers/kid`,
      `${base}/numbers/parents`,
      `${base}/requests/request-0001/seen`,
      "/settings/parent-numbers",
    ]) {
      expect((await form(path, PERIODIC, false)).status, path).toBe(403);
      expect((await postForm(t, path, PERIODIC)).status, path).toBe(401);
    }
  });

  it("sharing: off until a parent chooses, with what each provider means; saving reaches the phone", async () => {
    const { base, form, page, policy } = await family();
    const first = await page(`${base}/location`);
    const { status } = first;
    let { html } = first;
    expect(status).toBe(200);
    expect(html).toContain("Location is off: Belay doesn&#39;t share where this phone is");
    expect(html).toContain("on a Pixel it&#39;s Google&#39;s location service that answers");
    expect(html).toContain("Private: nobody else handles the request.");
    expect(html).not.toContain("Check now</button>");
    const saved = await form(`${base}/location`, PERIODIC);
    expect(saved.status).toBe(302);
    expect(saved.headers.get("location")).toBe(`${base}/location?saved=sharing#sharing`);
    expect(policy().location).toMatchObject({ mode: "periodic", every_minutes: 20, hours: { start: "07:00", end: "21:00" }, provider: "gps", keep_on: true });
    ({ html } = await page(`${base}/location`));
    expect(html).toContain("Every 20 minutes, from 07:00 to 21:00 in the phone&#39;s time");
    expect(html).toContain("Check now</button>");
    for (const bad of [{ ...PERIODIC, mode: "always" }, { ...PERIODIC, every: "5" }, { ...PERIODIC, hours_end: "" }, { ...PERIODIC, provider: "network" }]) {
      expect((await form(`${base}/location`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(policy().version).toBe(1);
  });

  it("places: from pasted coordinates or where the phone is now, edited, removed; names escaped; no map embedded", async () => {
    const { t, phone, base, form, page, policy, locations } = await family();
    await form(`${base}/location`, PERIODIC);
    expect((await form(`${base}/location/places`, { name: "School <b>", center: "40.10000, -73.20000", radius: "150", notify: ["arrive", "leave"] })).status).toBe(302);
    const [school] = listPlaces(t.deps.db, phone.deviceId);
    expect(school).toMatchObject({ name: "School <b>", lat: 40.1, lng: -73.2, radiusM: 150, notify: ["arrive", "leave"] });
    // Where the phone is now needs a fix first.
    expect((await form(`${base}/location/places`, { name: "Home", use_fix: "1", radius: "100" })).status).toBe(400);
    await locations([fix(north(SPOT, 3000))]);
    await form(`${base}/location/places`, { name: "Home", use_fix: "1", radius: "100" });
    expect(listPlaces(t.deps.db, phone.deviceId)[1]).toMatchObject({ name: "Home", lat: 40.12698, lng: -73.2 });
    for (const bad of [
      { name: "Far", center: "somewhere", radius: "150" },
      { name: "Far", center: "40.1 -73.2", radius: "20" },
      { name: "", center: "40.1, -73.2", radius: "150" },
      { name: "Far", center: "95, -73.2", radius: "150" },
    ]) {
      expect((await form(`${base}/location/places`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    await form(`${base}/location/places`, { id: school?.id ?? "", name: "School", center: "40.1 -73.2", radius: "200" });
    expect(listPlaces(t.deps.db, phone.deviceId)[0]).toMatchObject({ id: school?.id, name: "School", radiusM: 200, notify: [] });
    const { html } = await page(`${base}/location`);
    // The last fix is described by the places, with a link only the parent's browser follows.
    expect(html).toContain("<strong>At Home, within 20 m</strong>");
    expect(html).toContain('href="https://www.openstreetmap.org/?mlat=40.12698&amp;mlon=-73.20000#map=17/40.12698/-73.20000" rel="noopener noreferrer" target="_blank">Open in a map</a>');
    expect(html).not.toMatch(/<iframe|<img[^>]+http/);
    await form(`${base}/location/places/${school?.id ?? ""}/remove`, {});
    expect(policy().location?.places.map((p) => p.name)).toEqual(["Home"]);
    // The family's other map site.
    updateSettings(t.deps.db, { mapSite: "google" });
    expect((await page(`${base}/location`)).html).toContain('href="https://www.google.com/maps/search/?api=1&amp;query=40.12698,-73.20000"');
  });

  it("Check now waits for the phone's fix and shows it; the checks list says who checked", async () => {
    const { t, phone, base, form, page, policy, locations } = await family({ locateWaitMs: 10_000 });
    await form(`${base}/location`, { ...PERIODIC, mode: "on_demand" });
    const pending = form(`${base}/location/check`, {});
    await vi.waitFor(() => {
      expect(policy().commands).toHaveLength(1);
    });
    const [check] = policy().commands;
    expect(check).toMatchObject({ kind: "locate_now", via: null });
    await locations([fix({ reason: "on_demand", command_id: check?.id ?? "" })]);
    const res = await pending;
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${base}/location?check=${check?.id ?? ""}#where`);
    const { html } = await page(res.headers.get("location") ?? "");
    expect(html).toContain("The phone answered:");
    expect(html).toContain("40.10000, -73.20000");
    // The checks list, the same the kid sees: who checked, and the fix that answered.
    expect(html).toContain("Every time a parent, their AI app, or a caregiver checked where the phone is");
    expect(html).toMatch(/<span>Sam<\/span><div class="small"><span class="fix"><strong>40\.10000, -73\.20000<\/strong>/);
    // A check the phone couldn't do (from the CLI): the phone's own words, quoted.
    const failed = locateNow({ db: t.deps.db, now: t.now() }, phone.deviceId, { kind: "server" }).result.command;
    await deviceCall(t, phone.token, "checkin", {
      status: device({ enforcement: { policy_version: policy().version, commands: [{ id: failed, result: "failed", at: t.now(), problem: "No GPS fix in 60 seconds" }] } }),
    });
    const after = (await page(`${base}/location`)).html;
    expect(after).toContain("<span>the server&#39;s command line</span>");
    expect(after).toContain("<blockquote>No GPS fix in 60 seconds</blockquote>");
  });

  it("Check now says plainly when no answer came in time", async () => {
    const { base, form, page } = await family({ locateWaitMs: 30 });
    await form(`${base}/location`, { ...PERIODIC, mode: "on_demand" });
    const res = await form(`${base}/location/check`, {});
    expect(res.status).toBe(302);
    expect((await page(res.headers.get("location") ?? "")).html).toContain("No answer yet: the phone hasn&#39;t answered within a minute.");
  });

  it("Check now stops waiting as soon as the phone says it couldn't, and shows the phone's words, escaped", async () => {
    // A real server's minute, and a poll of an hour: only the phone's answer ends the wait.
    const { t, phone, base, form, page, policy } = await family({ locateWaitMs: 60_000 });
    t.deps.fixWaiters = createFixWaiters({ pollMs: 3_600_000 });
    await form(`${base}/location`, { ...PERIODIC, mode: "on_demand" });
    const checkin = (commands: { id: string; result: "failed" | "expired"; problem?: string }[]) =>
      deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: policy().version, commands: commands.map((c) => ({ at: t.now(), ...c })) } }) });
    const started = Date.now();
    const pending = form(`${base}/location/check`, {});
    await vi.waitFor(() => {
      expect(policy().commands).toHaveLength(1);
    });
    const [check] = policy().commands;
    await checkin([{ id: check?.id ?? "", result: "failed", problem: `<b>Location</b> is off & "Belay" can't look` }]);
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(t.deps.fixWaiters.size).toBe(0);
    expect(res.headers.get("location")).toBe(`${base}/location?check=${check?.id ?? ""}#where`);
    const { html } = await page(res.headers.get("location") ?? "");
    expect(html).toContain("The phone answered: it couldn&#39;t find where it is. Belay on the phone says:");
    expect(html).toContain("<blockquote>&lt;b&gt;Location&lt;/b&gt; is off &amp; &quot;Belay&quot; can&#39;t look</blockquote>");
    expect(html).not.toContain("<b>Location</b>");
    expect(html).not.toContain("No answer yet");
    // Got too late, by the phone's clock: that's an answer too.
    t.advance(60_000);
    const again = form(`${base}/location/check`, {});
    await vi.waitFor(() => {
      expect(policy().commands).toHaveLength(1);
    });
    const [late] = policy().commands;
    await checkin([{ id: late?.id ?? "", result: "expired" }]);
    const lateRes = await again;
    expect(t.deps.fixWaiters.size).toBe(0);
    expect((await page(lateRes.headers.get("location") ?? "")).html).toContain("The phone answered: it got the check too late, by its own clock");
  });

  it("lost mode: the lock screen's words and a number, then off; the kid's number and the emergency card", async () => {
    const { t, base, form, page, policy } = await family();
    await form(`${base}/location/lost`, { message: "This phone is lost. Please call", number: "555-0100" });
    expect(policy().location).toMatchObject({ mode: "off", lost: { since: t.now(), message: "This phone is lost. Please call 555-0100" } });
    expect((await page(`${base}/location`)).html).toContain("This phone is in lost mode, since");
    expect((await form(`${base}/location/lost`, { message: "Lost", number: "call me maybe" })).status).toBe(400);
    await form(`${base}/location/lost`, { off: "1" });
    expect(policy().location?.lost).toBeNull();

    expect((await form(`${base}/numbers/kid`, { number: "555 0123" })).status).toBe(400);
    await form(`${base}/numbers/kid`, { number: "+1 (555) 555-0123" });
    await form(`${base}/numbers/parents`, { name: ["Mom", "Dad", "", ""], number: ["+15555550100", "+1 555 555 0101", "", ""] });
    expect(policy().parent_numbers).toEqual([
      { name: "Mom", number: "+15555550100" },
      { name: "Dad", number: "+15555550101" },
    ]);
    expect((await form(`${base}/numbers/parents`, { name: ["Mom", ""], number: ["", "+15555550101"] })).status).toBe(400);
    const { html } = await page(`${base}/location`);
    expect(html).toContain('value="+15555550123"');
    expect(html).toContain("This phone has its own.");
    await form(`${base}/numbers/parents`, { family: "1" });
    expect(policy().parent_numbers).toEqual([]);
  });
});

describe("help on the parent pages", () => {
  it("is first on the Requests page, with Call, where the phone was, and I've seen it; and above the Phones page", async () => {
    const { t, phone, base, form, page, policy } = await family();
    await form(`${base}/numbers/kid`, { number: "+15555550123" });
    await deviceCall(t, phone.token, "requests", {
      requests: [
        { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() },
        { id: "request-0002", kind: "help", reason: "Come <b>now</b>", location: fix({ reason: "help" }), asked_at: t.now() },
        { id: "request-0003", kind: "talk", reason: "My curfew", asked_at: t.now() },
      ],
    });
    let { html } = await page("/requests");
    expect(html).toContain('Requests<span class="badge" aria-label="3 waiting">3</span>');
    expect(html.indexOf("Alex&#39;s phone needs help")).toBeLessThan(html.indexOf("Chatter"));
    expect(html).toContain('<blockquote class="kid">Come &lt;b&gt;now&lt;/b&gt;</blockquote>');
    expect(html).toContain('<a class="button call" href="tel:+15555550123">Call +15555550123</a>');
    expect(html).toContain("Where the phone was, shared by the kid:");
    expect(html).toContain("Would like to talk");
    expect(html).toContain("My curfew");
    expect((await page("/")).html).toContain("needs help.</strong>");
    expect((await page(base)).html).toContain("The kid needs help.");

    const seen = await form(`${base}/requests/request-0002/seen`, { note: "Coming", back: "requests" });
    expect(seen.headers.get("location")).toBe("/requests?saved=seen");
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")).toMatchObject({ seenAt: t.now(), status: "approved", note: "Coming" });
    expect(policy().help_seen).toEqual([{ request_id: "request-0002", at: t.now(), by: "Sam" }]);
    ({ html } = await page("/requests"));
    expect(html).not.toContain("Alex&#39;s phone needs help");
    expect(html).toContain("Needed help: seen by Sam");
    expect((await page("/")).html).not.toContain("needs help.</strong>");
    // Answering it isn't how it's done; a talk request is answered.
    expect((await form(`${base}/requests/request-0002/answer`, { answer: "approved" })).status).toBe(400);
    await form(`${base}/requests/request-0003/answer`, { answer: "talk", note: "Tonight", back: "requests" });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0003")).toMatchObject({ status: "talk", note: "Tonight" });
    expect((await form(`${base}/requests/request-0001/seen`, {})).status).toBe(404);
  });

  it("without the kid's number, the card says where to add it; a withdrawn help request stays until seen", async () => {
    const { t, phone, page } = await family();
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", asked_at: t.now() }] });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", asked_at: t.now(), withdrawn_at: t.now() }] });
    const { html } = await page("/requests");
    expect(html).toContain("Withdrawn, not seen yet");
    expect(html).toContain(`<a href="/devices/${phone.deviceId}/location#numbers">Add the kid&#39;s number</a> to call from here.`);
    expect(html).toContain("They didn&#39;t share where the phone is.");
  });
});

describe("Settings", () => {
  it("keeps where the phone was as long as the family says, picks the map site, and holds the family's emergency-card numbers", async () => {
    const { t, form, page, policy } = await family();
    let { html } = await page("/settings");
    expect(html).toContain('name="days_periodic" min="1" max="30" required="" value="7"');
    expect(html).toContain("(off until you turn it on)");
    const fields = { timezone: "America/New_York", silent_hours: "12", ai_scope: ["apps", "location"], days_periodic: "3", days_checks: "60", days_placeEvents: "30", days_lostAfter: "14", map_site: "google" };
    const res = await form("/settings", fields);
    expect(res.status).toBe(302);
    expect(getSettings(t.deps.db)).toMatchObject({ locationDays: { periodic: 3, checks: 60, placeEvents: 30, lostAfter: 14 }, mapSite: "google", aiScopes: { apps: true, location: true, requests: false } });
    // What AI apps may read reached the phone at once, for the kid's screen.
    expect(policy()).toMatchObject({ version: 1, ai_reads: ["apps", "location"] });
    expect((await form("/settings", { ...fields, days_periodic: "31" })).status).toBe(400);
    expect((await form("/settings", { ...fields, map_site: "somewhere" })).status).toBe(400);

    expect((await form("/settings/parent-numbers", { name: ["Mom"], number: ["+15555550100"] })).headers.get("location")).toBe("/settings?saved=parent_numbers#numbers");
    expect(policy().parent_numbers).toEqual([{ name: "Mom", number: "+15555550100" }]);
    expect((await form("/settings/parent-numbers", { name: ["Mom"], number: ["0100"] })).status).toBe(400);
    ({ html } = await page("/settings"));
    expect(html).toContain('value="+15555550100"');
  });
});
