/**
 * Phase 13's Mobile data tab on the parent pages: always there; the Wi-Fi-only apps with what the
 * phone says of each, who added it, and "Let it use mobile data again"; the Add form (the phone's
 * apps that can be, and any package by name); measuring's switch (a parent's alone, CSRF on it, in
 * the activity log, the policy following); the days as bars with a table of the same numbers, and a
 * chosen day's apps the same way, a Wi-Fi-only app that still used mobile data flagged; Settings'
 * retention; the activity log's words. Server-rendered. Made-up apps only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { changeWifiOnly, setMobileDataMeasure } from "../src/family/mobiledata/changes.js";
import { buildPolicy } from "../src/family/policy.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

const MB = 1_000_000;

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(
    t,
    phone.token,
    "inventory",
    snapshot(
      [
        pkg("com.example.video", { label: "<b>Video Tube</b>" }),
        pkg("com.example.blocks", { label: "Block Party" }),
        pkg("com.example.carrier", { label: "Carrier Services", system: true, launchable: false }),
        pkg("com.google.android.apps.messaging", { label: "Messages", system: true }),
      ],
      T0,
    ),
  );
  const base = `/devices/${phone.deviceId}`;
  const form = (path: string, fields: Record<string, string | string[]>, csrf = true) => postForm(t, path, { ...(csrf ? { _csrf: sam.csrf } : {}), ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => {
    const res = await get(t, path, sam.cookie);
    return { status: res.status, html: await res.text() };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = () => ({ db: t.deps.db, now: t.now() });
  return { t, sam, phone, base, form, page, policy, parent, ctx };
}

describe("the Mobile data tab", () => {
  it("is always there, needs a parent signed in, and the CSRF token on its forms", async () => {
    const { t, base, form, page, policy } = await family();
    const { status, html } = await page(base);
    expect(status).toBe(200);
    expect(html).toContain(`<a href="${base}/mobile-data">Mobile data</a>`);
    expect((await get(t, `${base}/mobile-data`)).status).toBe(302);
    expect((await form(`${base}/mobile-data/measure`, { on: "1" }, false)).status).toBe(403);
    expect((await form(`${base}/mobile-data/wifi-only`, { package: "com.example.video" }, false)).status).toBe(403);
    expect((await form(`${base}/mobile-data/measure`, { on: "maybe" })).status).toBe(400);
    expect(policy().mobile_data).toEqual({ wifi_only: [], measure: false });
    const tab = await page(`${base}/mobile-data`);
    expect(tab.html).toContain('aria-current="page">Mobile data</a>');
    expect(tab.html).toContain("No app is Wi-Fi only: every app may use mobile data.");
    expect(tab.html).toContain("Measuring is off: the phone sends nothing about how much mobile data apps use.");
    expect(tab.html).toContain("Measure mobile data</button>");
    expect(tab.html).toContain("Nothing kept.");
  });

  it("Wi-Fi only: the Add form offers the phone's apps that can be, and a parent may add any package; never one the phone never blocks", async () => {
    const { t, phone, base, form, page, policy } = await family();
    let { html } = await page(`${base}/mobile-data`);
    expect(html).toContain('<option value="com.example.video">&lt;b&gt;Video Tube&lt;/b&gt; (com.example.video)</option>');
    expect(html).toContain('<option value="com.example.blocks">Block Party (com.example.blocks)</option>');
    // Never the texting app, nor Android's own parts.
    expect(html).not.toContain('<option value="com.google.android.apps.messaging"');
    expect(html).not.toContain('<option value="com.example.carrier"');
    expect(html).toContain("app updates, which come through Play");
    const added = await form(`${base}/mobile-data/wifi-only`, { package: "com.example.video" });
    expect(added.status).toBe(302);
    expect(added.headers.get("location")).toBe(`${base}/mobile-data?saved=wifi_only#wifi-only`);
    expect(policy().mobile_data.wifi_only).toEqual(["com.example.video"]);
    expect((await form(`${base}/mobile-data/wifi-only`, { package: "com.example.later" })).status).toBe(302);
    const refused = await form(`${base}/mobile-data/wifi-only`, { package: "com.google.android.apps.messaging" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("can&#39;t be Wi-Fi only. The phone never blocks its texting app: texting 988 must always work.");
    expect((await form(`${base}/mobile-data/wifi-only`, { package: "not a package" })).status).toBe(400);
    ({ html } = await page(`${base}/mobile-data?saved=wifi_only`));
    expect(html).toContain("Saved: the phone keeps it off mobile data when it gets this");
    expect(html).toContain("Waiting for the phone to get it.");
    expect(html).toContain("Not on the phone: it&#39;s kept off mobile data once it&#39;s installed.");
    expect(html).toContain("Added <time");
    expect(html).toContain(" by Sam.");
    // The phone reports it: on the phone.
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: policy().version, mobile_data: { wifi_only: ["com.example.video"] } } }) });
    ({ html } = await page(`${base}/mobile-data`));
    expect(html).toContain("On the phone: it can&#39;t use mobile data.");
    // Let it use mobile data again: a parent's.
    const removed = await form(`${base}/mobile-data/wifi-only/remove`, { package: "com.example.video" });
    expect(removed.headers.get("location")).toBe(`${base}/mobile-data?saved=wifi_only_removed#wifi-only`);
    expect(policy().mobile_data.wifi_only).toEqual(["com.example.later"]);
    ({ html } = await page("/activity"));
    expect(html).toContain("made &lt;b&gt;Video Tube&lt;/b&gt; Wi-Fi only (no mobile data) (Alex&#39;s phone)");
    expect(html).toContain("let &lt;b&gt;Video Tube&lt;/b&gt; use mobile data again (Alex&#39;s phone)");
  });

  it("measuring: a parent's switch, the policy following, in the activity log; the days as bars with a table, and a day's apps", async () => {
    const { t, phone, base, form, page, policy, ctx, parent } = await family();
    const on = await form(`${base}/mobile-data/measure`, { on: "1" });
    expect(on.headers.get("location")).toBe(`${base}/mobile-data?saved=measure_on#measuring`);
    expect(policy().mobile_data.measure).toBe(true);
    changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: [] }, parent);
    t.advance(60_000);
    const day = (d: string, from: number, complete: boolean, apps: { package: string; bytes: number }[]) => ({
      day: d,
      zone: "America/New_York",
      from,
      as_of: from + 3_600_000,
      complete,
      mobile_bytes: apps.reduce((n, a) => n + a.bytes, 0) + 7 * MB,
      wifi_bytes: 1200 * MB,
      apps,
      android_bytes: 4 * MB,
      removed_bytes: 1 * MB,
      hotspot_bytes: 2 * MB,
    });
    await deviceCall(t, phone.token, "mobile-data", {
      days: [
        day("2026-11-16", t.now(), false, [{ package: "com.example.video", bytes: 300 * MB }, { package: "com.example.blocks", bytes: 20 * MB }]),
        day("2026-11-15", T0 - 86_400_000, true, [{ package: "com.example.blocks", bytes: 50 * MB }]),
      ],
    });
    let { html } = await page(`${base}/mobile-data?saved=measure_on`);
    expect(html).toContain("Measuring is on. The phone starts sending how much mobile data each app uses");
    expect(html).toContain("Measuring is on, since");
    expect(html).toContain("Stop measuring</button>");
    expect(html).toContain(`The server keeps it ${getSettings(t.deps.db).mobileDataDays} days`);
    expect(html).toContain("AI apps you connected may read each day once it&#39;s over, never today so far");
    // The bars and the table, the same numbers.
    expect(html).toContain('aria-label="327 MB of mobile data on Mon, Nov 16"');
    expect(html).toContain("<td>327 MB</td><td>1.2 GB</td><td>&lt;b&gt;Video Tube&lt;/b&gt; (300 MB)</td>");
    expect(html).toContain("<td>57 MB</td><td>1.2 GB</td><td>Block Party (50 MB)</td>");
    // Today's apps, with the lines that aren't one app's, and the Wi-Fi-only app that still used mobile data.
    expect(html).toContain('aria-label="&lt;b&gt;Video Tube&lt;/b&gt;: 300 MB"');
    expect(html).toContain('aria-label="Android, calls and texting: 4 MB"');
    expect(html).toContain('aria-label="Apps removed since: 1 MB"');
    expect(html).toContain('aria-label="Other devices, through this phone&#39;s hotspot: 2 MB"');
    expect(html).toContain("Used mobile data</span>");
    expect(html).toContain(`<input type="hidden" name="package" value="com.example.blocks"/><input type="hidden" name="back" value="2026-11-16"/>`);
    // Another day, chosen.
    ({ html } = await page(`${base}/mobile-data?day=2026-11-15`));
    expect(html).toContain('<h3>Sun, Nov 15</h3>');
    expect(html).not.toContain("Used mobile data</span>");
    // Making an app Wi-Fi only from a day goes back to that day.
    const back = await form(`${base}/mobile-data/wifi-only`, { package: "com.example.blocks", back: "2026-11-15" });
    expect(back.headers.get("location")).toBe(`${base}/mobile-data?saved=wifi_only&day=2026-11-15#wifi-only`);
    // Off: the days stay until they're old, and the phone sends nothing more.
    expect((await form(`${base}/mobile-data/measure`, { on: "0" })).headers.get("location")).toBe(`${base}/mobile-data?saved=measure_off#measuring`);
    expect(policy().mobile_data.measure).toBe(false);
    ({ html } = await page(`${base}/mobile-data`));
    expect(html).toContain("The server still keeps 2 days of it from before");
    expect(listAudit(t.deps.db, { limit: 10, includeReads: false }).map((e) => e.action)).toContain("mobile_data.measure_on");
    ({ html } = await page("/activity"));
    expect(html).toContain("turned on measuring mobile data (how much mobile data each app uses) (Alex&#39;s phone)");
    expect(html).toContain("turned off measuring mobile data (how much mobile data each app uses) (Alex&#39;s phone)");
    setMobileDataMeasure(ctx(), phone.deviceId, true, parent);
  });

  it("Settings: how long mobile data use is kept, 1 to 400 days", async () => {
    const { t, sam, page } = await family();
    const { html } = await page("/settings");
    expect(html).toContain('name="mobile_data_days" min="1" max="400" required="" value="90"');
    expect(html).toContain('value="mobile_data" checked=""/> Mobile data: how much mobile data each app uses each day');
    const save = (days: string) => postForm(t, "/settings", { _csrf: sam.csrf, timezone: "UTC", silent_hours: "12", mobile_data_days: days, ai_scope: ["apps", "mobile_data"] }, { cookie: sam.cookie });
    expect((await save("31")).status).toBe(302);
    expect(getSettings(t.deps.db).mobileDataDays).toBe(31);
    const refused = await save("401");
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Keep mobile data use 1 to 400 days.");
  });
});
