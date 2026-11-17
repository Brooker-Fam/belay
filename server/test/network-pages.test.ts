/**
 * Phase 3's network logging on the parent pages: the switch on the phone's page (a parent's alone,
 * CSRF on it, in the activity log, the policy following), the Network tab (only while it's on:
 * domains per app per day, with the retention stated), Settings' retention, and Off belay's Stop
 * collecting for it. Server-rendered. Made-up apps and names only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { setNetworkLog } from "../src/family/network/changes.js";
import { buildPolicy } from "../src/family/policy.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.chat", { label: "<b>Chatter</b>" }), pkg("com.example.blocks", { label: "Block Party" })], T0));
  const base = `/devices/${phone.deviceId}`;
  const form = (path: string, fields: Record<string, string | string[]>, csrf = true) => postForm(t, path, { ...(csrf ? { _csrf: sam.csrf } : {}), ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => {
    const res = await get(t, path, sam.cookie);
    return { status: res.status, html: await res.text() };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = () => ({ db: t.deps.db, now: t.now() });
  const send = (days: unknown[]) => deviceCall(t, phone.token, "network", { days });
  return { t, sam, phone, base, form, page, policy, parent, ctx, send };
}

describe("network logging on the parent pages", () => {
  it("the switch needs a parent signed in and the CSRF token", async () => {
    const { t, base, form, policy } = await family();
    expect((await form(`${base}/network`, { on: "1" }, false)).status).toBe(403);
    expect((await postForm(t, `${base}/network`, { on: "1" })).status).toBe(401);
    const res = await get(t, `${base}/network`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    expect((await form(`${base}/network`, { on: "maybe" })).status).toBe(400);
    expect(policy().network_log).toEqual({ enabled: false });
  });

  it("is off until a parent turns it on on the phone's page, under Web; then the Network tab shows, and the policy follows", async () => {
    const { t, base, form, page, policy } = await family();
    let { html } = await page(base);
    expect(html).toContain('<h3 id="network-logging">Network logging</h3>');
    expect(html).toContain("Network logging is off: Belay notes nothing about which websites and services apps look up.");
    expect(html).toContain("never 988&#39;s websites");
    expect(html).toContain("a name looked up isn&#39;t a page visited");
    expect(html).toContain("AI apps can&#39;t read it unless you allow that in Settings.");
    expect(html).toContain("Turn network logging on</button>");
    expect(html).not.toContain(`href="${base}/network"`);
    const on = await form(`${base}/network`, { on: "1" });
    expect(on.status).toBe(302);
    expect(on.headers.get("location")).toBe(`${base}?saved=network_on#network`);
    expect(policy().network_log).toEqual({ enabled: true });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "network.on" });
    ({ html } = await page(`${base}?saved=network_on`));
    expect(html).toContain("Network logging is on. The phone starts noting which websites and services its apps look up");
    expect(html).toContain("Network logging is on, since");
    expect(html).toContain(`<a href="${base}/network">Network</a>`);
    expect(html).toContain("The phone hasn&#39;t said yet whether it logs");
    expect(html).toContain("Turn network logging off</button>");
    const off = await form(`${base}/network`, { on: "0" });
    expect(off.headers.get("location")).toBe(`${base}?saved=network_off#network`);
    expect(policy().network_log).toEqual({ enabled: false });
  });

  it("the Network tab: domains per app per day, most looked up first, with the retention stated", async () => {
    const { t, phone, ctx, parent, base, page, send } = await family();
    setNetworkLog(ctx(), phone.deviceId, true, parent);
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, network_log: { enabled: true, paused: false } } }) });
    await send([
      {
        day: "2026-11-16",
        zone: "America/New_York",
        as_of: T0,
        entries: [
          { package: "com.example.blocks", domain: "example.net", lookups: 3 },
          { package: "com.example.chat", domain: "example.com", lookups: 40 },
          { package: "com.example.chat", domain: "example.org", lookups: 2 },
        ],
        dropped: 12,
      },
    ]);
    const { status, html } = await page(`${base}/network`);
    expect(status).toBe(200);
    expect(html).toContain(`href="${base}/network" aria-current="page">Network</a>`);
    expect(html).toContain("On the phone: Android is logging");
    expect(html).toContain("Mon, Nov 16");
    // The app's name is its developer's: escaped.
    expect(html).toContain("<strong>&lt;b&gt;Chatter&lt;/b&gt;</strong>");
    expect(html).not.toContain("<b>Chatter</b>");
    expect(html.indexOf("Chatter")).toBeLessThan(html.indexOf("Block Party"));
    expect(html).toContain("42 lookups of 2 names");
    expect(html).toContain("example.com: 40");
    expect(html).toContain("And 12 more app and name pairs, each looked up less than these");
    expect(html).toContain("Belay keeps this 30 days, on this server only");
  });

  it("says when Android paused it, and keeps showing kept days after it's off", async () => {
    const { t, phone, ctx, parent, base, page, send } = await family();
    setNetworkLog(ctx(), phone.deviceId, true, parent);
    await send([{ day: "2026-11-16", zone: "America/New_York", as_of: T0, entries: [{ package: "com.example.chat", domain: "example.com", lookups: 1 }], dropped: 0 }]);
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, network_log: { enabled: true, paused: true } } }) });
    let { html } = await page(base);
    expect(html).toContain("Android paused network logging: it does while another user or profile is on the phone");
    expect(html).toContain("Network logging is paused: Android stops it while another user or profile is on the phone");
    setNetworkLog(ctx(), phone.deviceId, false, parent);
    ({ html } = await page(base));
    expect(html).toContain("The server still keeps 1 day of it from before, until it&#39;s 30 days old");
    expect(html).not.toContain(`<a href="${base}/network">Network</a>`);
    ({ html } = await page(`${base}/network`));
    expect(html).toContain("Network logging is off: nothing new arrives.");
    expect(html).toContain("example.com: 1");
  });

  it("Settings keeps network activity 1 to 90 days, and Off belay can stop collecting it", async () => {
    const { t, phone, ctx, parent, base, form, page, send } = await family();
    const saved = await form("/settings", { timezone: "America/New_York", silent_hours: "12", network_days: "14", ai_scope: ["apps", "network"] });
    expect(saved.status).toBe(302);
    expect(getSettings(t.deps.db)).toMatchObject({ networkDays: 14, aiScopes: { network: true } });
    expect((await form("/settings", { timezone: "America/New_York", silent_hours: "12", network_days: "91" })).status).toBe(400);
    expect((await page("/settings")).html).toContain('name="network_days" min="1" max="90" required="" value="14"');
    setNetworkLog(ctx(), phone.deviceId, true, parent);
    await send([{ day: "2026-11-16", zone: "America/New_York", as_of: T0, entries: [{ package: "com.example.chat", domain: "example.com", lookups: 1 }], dropped: 0 }]);
    const { html } = await page(base);
    expect(html).toContain("<strong>Websites and services apps look up</strong>");
    expect(html).toContain("Kept: 1 day of network activity: which websites and online services each app looked up, and how many times.");
    expect(html).toContain(`href="${base}/collection/network"`);
    expect((await page(`${base}/collection/network`)).status).toBe(200);
  });
});
