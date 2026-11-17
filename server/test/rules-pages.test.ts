import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy, getRules, setHardening, type PolicyContext } from "../src/family/policy.js";
import { createProposal, listProposals } from "../src/family/proposals.js";
import { getRequest } from "../src/family/requests.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, event, get, pkg, postForm, signIn, snapshot, testServer, T0, type TestServer } from "./helpers.js";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(
    t,
    phone.token,
    "inventory",
    snapshot([pkg("com.example.maps", { label: "Trail Maps" }), pkg("com.example.chat", { label: "Chatter Box" }), pkg("com.android.settings", { label: "Settings", system: true, source: "preinstalled" })], T0),
  );
  const page = async (path = `/devices/${phone.deviceId}`) => {
    const res = await get(t, path, sam.cookie);
    expect(res.status).toBe(200);
    return res.text();
  };
  const send = (path: string, fields: Record<string, string | string[]> = {}) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const at = (path: string) => `/devices/${phone.deviceId}${path}`;
  return { t, sam, phone, page, send, policy, at };
}

async function newApp(t: TestServer, token: string, name: string, label: string, reason: string | null) {
  await deviceCall(t, token, "events", { events: [event("installed", name, { label, to: { code: 1 }, happened_at: t.now() - 1000, detected_at: t.now() })] });
  await deviceCall(t, token, "requests", { requests: [{ id: "request-0001", kind: "app", package: name, label, reason, asked_at: t.now() }] });
}

const parentCtx = (t: TestServer): PolicyContext => ({ db: t.deps.db, now: t.now() });

describe("the phone's Rules section", () => {
  it("shows the protection switch with a summary of what it does, and the hardening warning", async () => {
    const { page } = await family();
    const html = await page();
    expect(html).toContain('<h2 id="rules">Rules</h2>');
    expect(html).toContain("Protection is off.");
    expect(html).toContain("The 2 apps already on the phone are allowed, so nothing stops working by surprise.");
    expect(html).toContain("Filters the web with CleanBrowsing Family");
    expect(html).toContain("Turn protection on");
    expect(html).toContain("These can lock the phone for good.");
    expect(html).toContain("<code>people/me</code>");
    expect(html).toContain("Belay&#39;s server never contacts Google");
    expect(html).not.toContain("This is a debug build");
  });

  it("turns protection on in one step, allowing every app already there", async () => {
    const { t, page, send, policy, at } = await family();
    const res = await send(at("/protect"));
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${at("")}?saved=protected#rules`);
    expect(policy()).toMatchObject({
      version: 1,
      apps: { new_apps: "ask", decisions: [{ package: "com.example.chat", state: "allowed" }, { package: "com.example.maps", state: "allowed" }] },
      web: { private_dns: "family-filter-dns.cleanbrowsing.org" },
    });
    const html = await page(`${at("")}?saved=protected`);
    expect(html).toContain("Protection is on. The phone gets the new rules within seconds if it&#39;s online.");
    expect(html).toContain('<span class="chip allowed">Allowed</span>');
    expect(html).toContain("The phone hasn&#39;t taken them yet");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", parentName: "Sam", action: "policy.protected" });

    expect((await send(at("/unprotect"))).status).toBe(302);
    expect(policy()).toMatchObject({ version: 2, apps: { new_apps: "allow" }, web: { private_dns: null } });
  });

  it("puts waiting apps first, each with the kid's request and their reason, escaped and labeled as theirs", async () => {
    const { t, phone, page, send, at } = await family();
    await send(at("/protect"));
    await newApp(t, phone.token, "com.example.game", "Block Party", "<b>Everyone</b> plays it");
    const html = await page();
    expect(html.indexOf("Block Party")).toBeLessThan(html.indexOf("Trail Maps"));
    expect(html).toContain('<span class="chip waiting">Waiting for you</span>');
    expect(html).toContain('In their words:</span></p><blockquote class="kid">&lt;b&gt;Everyone&lt;/b&gt; plays it</blockquote>');
    expect(html).not.toContain("<b>Everyone</b>");
    expect(html).toContain('<form id="answer-request-0001" method="post" action="/devices/');
    expect(html).toContain('form="answer-request-0001" name="answer" value="approved"');
  });

  it("allows and blocks apps, but never the ones 911 and 988 need", async () => {
    const { page, send, policy, at } = await family();
    const res = await send(at("/decide"), { block: "com.example.chat" });
    expect(res.headers.get("location")).toBe(`${at("")}?saved=blocked#apps`);
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "blocked" }]);
    expect(await page()).toContain('<span class="chip blocked">Blocked</span>');
    await send(at("/decide"), { allow: "com.example.chat" });
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "allowed" }]);
    const belay = await send(at("/decide"), { block: "family.brooker.belay" });
    expect(belay.status).toBe(400);
    expect(await belay.text()).toContain("Belay never blocks that app");
    expect((await send(at("/decide"), { block: "not a package" })).status).toBe(400);
    expect((await send(at("/decide"), { allow: "com.example.chat", block: "com.example.maps" })).status).toBe(400);
  });

  it("pauses with a note shown to the kid, and resumes", async () => {
    const { t, page, send, policy, at } = await family();
    await send(at("/pause"), { minutes: "30", note: "Dinner time" });
    expect(policy().pause).toEqual({ until: t.now() + 30 * 60_000, note: "Dinner time" });
    const html = await page();
    expect(html).toContain("<strong>Paused</strong> until");
    expect(html).toContain("<blockquote>Dinner time</blockquote>");
    await send(at("/pause"), { minutes: "until", note: "" });
    expect(policy().pause).toEqual({ until: null, note: null });
    await send(at("/resume"));
    expect(policy().pause).toBeNull();
    expect((await send(at("/pause"), { minutes: "7" })).status).toBe(400);
  });

  it("switches new apps between ask and allow", async () => {
    const { send, policy, at } = await family();
    await send(at("/new-apps"), { mode: "ask" });
    expect(policy().apps).toMatchObject({ new_apps: "ask", decisions: [{ package: "com.example.chat" }, { package: "com.example.maps" }] });
    await send(at("/new-apps"), { mode: "allow" });
    expect(policy().apps.new_apps).toBe("allow");
    expect((await send(at("/new-apps"), { mode: "sometimes" })).status).toBe(400);
  });

  it("locks settings in groups; accounts and the SIM need their step done first", async () => {
    const { send, policy, at } = await family();
    await send(at("/restrictions"), { lock: ["safe_boot", "config_vpn"] });
    expect(policy().restrictions).toMatchObject({ safe_boot: true, config_vpn: true, add_user: false });
    const accounts = await send(at("/restrictions"), { lock: ["safe_boot", "modify_accounts"] });
    expect(accounts.status).toBe(400);
    expect(await accounts.text()).toContain("Add the parent-owned Google account to the phone first");
    expect((await send(at("/restrictions"), { lock: ["sim"] })).status).toBe(400);
    await send(at("/restrictions"), { lock: ["modify_accounts", "sim"], accounts_ready: "1", sim_ready: "1" });
    expect(policy().restrictions).toMatchObject({ safe_boot: false, config_vpn: false, modify_accounts: true, sim: true });
    // Hardening isn't one of these, whatever the form says.
    await send(at("/restrictions"), { lock: ["factory_reset", "debugging", "modify_accounts", "sim"] });
    expect(policy().restrictions).toMatchObject({ factory_reset: false, debugging: false });
  });

  it("turns hardening on only when the parent types the phone's name", async () => {
    const { send, policy, at } = await family();
    for (const confirm of ["", "Sam", "Alex's phone"]) {
      const res = await send(at("/hardening"), { factory_reset: "1", debugging: "1", frp_accounts: "", confirm });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain("These can lock the phone for good. To turn them on, type the phone&#39;s name, Sam&#39;s phone, in the box.");
    }
    expect(policy().restrictions).toMatchObject({ factory_reset: false, debugging: false });
    expect((await send(at("/hardening"), { frp_accounts: "112233445566778899000", confirm: "nope" })).status).toBe(400);
    expect(policy().frp_accounts).toEqual([]);

    await send(at("/hardening"), { factory_reset: "1", debugging: "1", frp_accounts: "people/112233445566778899000\n998877665544332211000", confirm: " sam's PHONE " });
    expect(policy()).toMatchObject({ restrictions: { factory_reset: true, debugging: true }, frp_accounts: ["112233445566778899000", "998877665544332211000"] });
    // Turning them off is loosening the lock-out risk: no name needed.
    await send(at("/hardening"), { frp_accounts: "" });
    expect(policy()).toMatchObject({ restrictions: { factory_reset: false, debugging: false }, frp_accounts: [] });
    const bad = await send(at("/hardening"), { frp_accounts: "sam@example.com", confirm: "Sam's phone" });
    expect(bad.status).toBe(400);
    expect(await bad.text()).toContain("A Google account id is a long number");
  });

  it("says when the phone runs a debug build, which doesn't apply hardening", async () => {
    const { t, phone, page } = await family();
    await deviceCall(t, phone.token, "checkin", { status: device({ device_time: t.now() }, { test_only: true }) });
    expect(await page()).toContain("This is a debug build: Belay won&#39;t apply these.");
  });

  it("lifts the debugging lock for 1, 4 or 24 hours in maintenance mode", async () => {
    const { t, sam, phone, page, send, policy, at } = await family();
    expect(await page()).toContain("Debugging isn&#39;t locked, so adb works already.");
    setHardening(parentCtx(t), phone.deviceId, { factoryReset: false, debugging: true, frpAccounts: [] }, { kind: "parent", parentId: sam.parent.id });
    await send(at("/maintenance"), { hours: "4" });
    expect(policy().maintenance_until).toBe(t.now() + 4 * 3_600_000);
    expect(await page()).toContain("<strong>Maintenance mode is on</strong> until");
    expect((await send(at("/maintenance"), { hours: "2" })).status).toBe(400);
    await send(at("/maintenance"), { end: "1" });
    expect(policy().maintenance_until).toBeNull();
  });

  it("sets the web filter, Chrome's settings, and no browser", async () => {
    const { send, policy, at } = await family();
    await send(at("/web"), {
      filter: "adguard",
      chrome: "1",
      safe_search: "1",
      youtube: "moderate",
      allowlist_mode: "1",
      allowlist: "school.example.org\n*.wikipedia.org\n",
      blocklist: "games.example.com",
      hide_browsers: "1",
    });
    expect(policy().web).toEqual({
      private_dns: "family.adguard-dns.com",
      chrome: {
        incognito: false,
        safe_search: true,
        youtube_restrict: "moderate",
        safe_sites: false,
        allow_downloads: false,
        url_allowlist: ["school.example.org", "*.wikipedia.org"],
        url_blocklist: ["games.example.com"],
      },
      hide_browsers: true,
    });
    await send(at("/web"), { filter: "custom", custom_host: "DNS.Example.org." });
    expect(policy().web).toEqual({ private_dns: "dns.example.org", chrome: null, hide_browsers: false });
    const invalid: Record<string, string>[] = [
      { filter: "custom", custom_host: "http://dns.example.org" },
      { filter: "custom", custom_host: "192.168.1.1" },
      { filter: "nextdns" },
      { filter: "off", chrome: "1", youtube: "loud" },
    ];
    for (const fields of invalid) {
      expect((await send(at("/web"), fields)).status).toBe(400);
    }
    await send(at("/web"), { filter: "off" });
    expect(policy().web.private_dns).toBeNull();
    await send(at("/web"), { filter: "cleanbrowsing" });
    expect(policy().web.private_dns).toBe("family-filter-dns.cleanbrowsing.org");
  });

  it("keeps the parent's words for blocked-app screens", async () => {
    const { send, policy, at } = await family();
    await send(at("/support"), { message: "Ask Mom or Dad" });
    expect(policy().support_message).toBe("Ask Mom or Dad");
    expect((await send(at("/support"), { message: "x".repeat(201) })).status).toBe(400);
  });

  it("refuses every new form without the session's CSRF token, or from another site", async () => {
    const { t, sam, phone, policy, at } = await family();
    await newApp(t, phone.token, "com.example.game", "Block Party", null);
    const proposal = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "new_apps_allow" }, "x", { parentId: sam.parent.id, clientName: "Claude" }).proposal;
    const forms: [string, Record<string, string>][] = [
      [at("/protect"), {}],
      [at("/unprotect"), {}],
      [at("/new-apps"), { mode: "ask" }],
      [at("/decide"), { block: "com.example.chat" }],
      [at("/pause"), { minutes: "30" }],
      [at("/resume"), {}],
      [at("/restrictions"), { lock: "safe_boot" }],
      [at("/hardening"), { factory_reset: "1", confirm: "Sam's phone" }],
      [at("/maintenance"), { hours: "1" }],
      [at("/web"), { filter: "adguard" }],
      [at("/support"), { message: "Hi" }],
      [at("/requests/request-0001/answer"), { answer: "approved" }],
      [`/proposals/${proposal.id}/approve`, {}],
      [`/proposals/${proposal.id}/reject`, {}],
    ];
    for (const [path, fields] of forms) {
      expect((await postForm(t, path, fields, { cookie: sam.cookie })).status, path).toBe(403);
      expect((await postForm(t, path, { ...fields, _csrf: "x".repeat(43) }, { cookie: sam.cookie })).status, path).toBe(403);
      expect((await postForm(t, path, { ...fields, _csrf: sam.csrf }, { cookie: sam.cookie, origin: "https://evil.example" })).status, path).toBe(403);
      expect((await postForm(t, path, fields)).status, path).toBe(401);
    }
    expect(policy().version).toBe(0);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("pending");
    expect(listProposals(t.deps.db)[0]?.status).toBe("pending");
  });
});

describe("answering the kid's requests", () => {
  it("approving allows the app, bumps the version, and the answer reaches the phone", async () => {
    const { t, phone, send, policy, at } = await family();
    await send(at("/protect"));
    await newApp(t, phone.token, "com.example.game", "Block Party", "My friends play it");
    const res = await send(at("/requests/request-0001/answer"), { answer: "approved", note: "OK, on weekends", back: "requests" });
    expect(res.headers.get("location")).toBe("/requests?saved=answer_approved");
    const p = policy();
    expect(p.version).toBe(2);
    expect(p.apps.decisions).toContainEqual({ package: "com.example.game", state: "allowed" });
    expect(p.requests).toEqual([{ id: "request-0001", status: "approved", note: "OK, on weekends", answered_at: t.now(), answered_by: "Sam" }]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "request.answered", detail: { answer: "approved" } });
  });

  it("declining or 'let's talk' answers without allowing", async () => {
    const { t, phone, send, policy, at } = await family();
    await send(at("/protect"));
    await newApp(t, phone.token, "com.example.game", "Block Party", null);
    await send(at("/requests/request-0001/answer"), { answer: "talk", note: "Let's talk at dinner" });
    expect(policy()).toMatchObject({ version: 2, requests: [{ status: "talk", note: "Let's talk at dinner" }] });
    expect(policy().apps.decisions.some((d) => d.package === "com.example.game")).toBe(false);
    await send(at("/requests/request-0001/answer"), { answer: "declined" });
    expect(policy().requests[0]?.status).toBe("declined");
    expect((await send(at("/requests/request-0001/answer"), { answer: "maybe" })).status).toBe(400);
    expect((await send(at("/requests/request-9999/answer"), { answer: "approved" })).status).toBe(404);
  });

  it("the Requests page lists every phone's, waiting first, with a count in the menu", async () => {
    const { t, phone, page, send, at } = await family();
    const second = await enrollPhone(t, "Alex's phone");
    await newApp(t, phone.token, "com.example.game", "Block Party", "Everyone in my class plays it");
    await deviceCall(t, second.token, "requests", { requests: [{ id: "request-0002", kind: "app", package: "com.example.draw", label: "Sketchbook", asked_at: t.now() }] });
    let html = await page("/requests");
    expect(html).toContain('Requests<span class="badge" aria-label="2 waiting">2</span>');
    expect(html).toContain("Everyone in my class plays it");
    expect(html).toContain("They didn&#39;t say why.");
    expect(html).toContain("Alex&#39;s phone · ");
    await send(at("/requests/request-0001/answer"), { answer: "declined", note: "Not yet" });
    html = await page("/requests");
    expect(html).toContain('Requests<span class="badge" aria-label="1 waiting">1</span>');
    expect(html.indexOf("Sketchbook")).toBeLessThan(html.indexOf("Answered in the last 30 days"));
    expect(html.indexOf("Answered in the last 30 days")).toBeLessThan(html.indexOf("Block Party"));
    expect(html).toContain("<blockquote>Not yet</blockquote>");
  });
});

describe("the Proposals page", () => {
  it("lists what AI apps proposed; approving applies it, rejecting doesn't", async () => {
    const { t, sam, phone, page, send, policy, at } = await family();
    await send(at("/decide"), { block: "com.example.chat" });
    const by = { parentId: sam.parent.id, clientName: "Claude" };
    const allow = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "allow_app", package: "com.example.chat" }, "It's the <i>class</i> chat", by).proposal;
    const lift = createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "lift_restriction", restriction: "config_vpn" }, "For a school VPN", by).proposal;
    const html = await page("/proposals");
    expect(html).toContain('Proposals<span class="badge" aria-label="2 waiting">2</span>');
    expect(html).toContain("Allow &quot;Chatter Box&quot;");
    expect(html).toContain("Lift the lock on vpn settings");
    expect(html).toContain('Its reason, in its words:</p><blockquote class="ai">It&#39;s the &lt;i&gt;class&lt;/i&gt; chat</blockquote>');
    expect(html).toContain("Proposed by Claude, through Sam&#39;s connection");
    expect(html).toContain(`formaction="/proposals/${lift.id}/reject"`);

    const approved = await send(`/proposals/${allow.id}/approve`, { note: "OK for homework" });
    expect(approved.headers.get("location")).toBe("/proposals?saved=proposal_approved");
    expect(policy()).toMatchObject({ version: 2, apps: { decisions: [{ package: "com.example.chat", state: "allowed" }] } });
    expect((await send(`/proposals/${allow.id}/approve`)).status).toBe(400);

    await send(`/proposals/${lift.id}/reject`);
    expect(policy().version).toBe(2);
    expect(listProposals(t.deps.db).map((p) => p.status).sort()).toEqual(["approved", "rejected"]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "proposal.rejected" });
    const after = await page("/proposals");
    expect(after).toContain("Nothing is waiting for you.");
    expect(after).not.toContain('class="badge"');
  });
});

describe("an app's page", () => {
  it("shows its rule and history, and allows or blocks with a note", async () => {
    const { t, phone, page, send, at } = await family();
    const res = await send(at("/decide"), { block: "com.example.chat", note: "Strangers can message", back: "app" });
    expect(res.headers.get("location")).toBe(`${at("/apps/com.example.chat")}?saved=blocked`);
    let html = await page(at("/apps/com.example.chat"));
    expect(html).toContain("Blocked: hidden and suspended on the phone");
    expect(html).toContain("by Sam");
    expect(html).toContain("<blockquote>Strangers can message</blockquote>");
    t.advance(60_000);
    await send(at("/decide"), { allow: "com.example.chat", back: "app" });
    html = await page(at("/apps/com.example.chat"));
    expect(html).toContain("<h3>Earlier</h3>");
    expect(html).toContain("blocked by Sam");
    expect(getRules(t.deps.db, phone.deviceId).version).toBe(2);
  });
});

describe("the activity log", () => {
  it("says what changed, and who did it", async () => {
    const { t, phone, page, send, at } = await family();
    await send(at("/protect"));
    await send(at("/decide"), { block: "com.example.chat", note: "Strangers" });
    await newApp(t, phone.token, "com.example.game", "Block Party", null);
    await send(at("/requests/request-0001/answer"), { answer: "approved" });
    const html = await page("/activity");
    expect(html).toContain("turned protection on (Sam&#39;s phone)");
    expect(html).toContain("blocked Chatter Box (Sam&#39;s phone), noting: &quot;Strangers&quot;");
    expect(html).toContain("asked for Block Party");
    expect(html).toContain("approved the request for Block Party (Sam&#39;s phone)");
  });
});
