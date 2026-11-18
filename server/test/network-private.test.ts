/**
 * The family's private websites (Phase 3, network logging): domains Belay never keeps a lookup of on
 * a phone, or of a name under one, like 988's websites, such as a helpline's or a counselor's site.
 * The policy's `network_log.private_domains` (registrable domains, checked like a network entry's
 * domain, at most 100, sent whether logging is on or off); what a parent types cleaned to the
 * registrable domain; a parent's alone, in the activity log with a count and never a name; making
 * one private deletes what the server kept of it, and the server drops any that arrive anyway,
 * without a word in its log. An AI app can't read the list or change it, not even as a proposal.
 * Made-up apps and names only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { LIMITS, Policy } from "../src/device/schemas.js";
import { keptFor, stopCollecting } from "../src/family/collection.js";
import { setNetworkLog, setPrivateWebsite } from "../src/family/network/changes.js";
import { registrable, typedWebsite } from "../src/family/network/domains.js";
import { isPrivateWebsite, listPrivateWebsites, networkDays, neverKept, privateDomainsOf } from "../src/family/network/store.js";
import { buildPolicy, RuleRefused, type PolicyContext } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, get, postForm, signIn, testServer, T0 } from "./helpers.js";

const TODAY = "2026-11-16";

const entry = (pkg: string, domain: string, lookups = 1) => ({ package: pkg, domain, lookups });
const day = (entries: unknown[], over: Record<string, unknown> = {}) => ({ day: TODAY, zone: "America/New_York", as_of: T0, entries, dropped: 0, ...over });

async function family(opts: { on?: boolean } = {}) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  if (opts.on) setNetworkLog(ctx(), phone.deviceId, true, parent);
  const network = (days: unknown[], token = phone.token) => deviceCall(t, token, "network", { days });
  const kept = (deviceId = phone.deviceId) => networkDays(t.deps.db, deviceId).flatMap((d) => d.entries.map((e) => `${d.day} ${e.package} ${e.domain} ${e.lookups}`));
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const make = (domain: string, on = true, who: typeof parent | { kind: "server" } = parent) => setPrivateWebsite(ctx(), phone.deviceId, domain, on, who);
  return { t, sam, phone, ctx, parent, ai, network, kept, policy, make };
}

describe("what a parent types becomes the registrable domain the phone keeps", () => {
  it("a name or a link, in any case, in Punycode, without www or the page", () => {
    for (const [typed, domain] of [
      ["example.org", "example.org"],
      ["  Example.ORG.  ", "example.org"],
      ["www.example.org", "example.org"],
      ["https://www.Example.org/help?with=1#top", "example.org"],
      ["help.example.org/chat", "example.org"],
      ["*.example.net", "example.net"],
      ["chat.example.co.uk", "example.co.uk"],
      ["http://user@example.com.au:8443/", "example.com.au"],
      ["Bücher.example", "xn--bcher-kva.example"],
      ["counselor.example.io", "example.io"],
    ] as const) {
      expect(typedWebsite(typed), typed).toEqual({ domain });
    }
  });

  it("refuses what isn't a website's name, names that never leave the phone or home, and 988's websites, saying why", () => {
    for (const bad of ["", "   ", "example", "exa mple.org", "under_score.example.org", "192.0.2.10", "[2001:db8::1]", "-example.org", "a..example.org", "x".repeat(2001)]) {
      expect(typedWebsite(bad), bad).toHaveProperty("problem");
    }
    expect(typedWebsite("example")).toEqual({ problem: "That isn't a website's name: type one like example.org, or paste the website's address." });
    expect(typedWebsite("printer.local")).toEqual({ problem: "Belay never notes names on the phone itself or the home network, so there's no need to add one." });
    expect(typedWebsite("localhost")).toHaveProperty("problem");
    for (const crisis of ["988lifeline.org", "https://chat.988lifeline.org/", "www.988.ca", "VeteransCrisisLine.net"]) {
      expect(typedWebsite(crisis), crisis).toEqual({ problem: "Belay never notes 988's websites anyway, so there's no need to add one." });
    }
  });

  it("keeps a name's registrable part as the phone does (core's Domains.registrable)", () => {
    for (const [host, kept] of [
      ["chat-7.cdn.example.com", "example.com"],
      ["news.example.co.uk", "example.co.uk"],
      ["static.example.com.au", "example.com.au"],
      ["a.b.example.ne.jp", "example.ne.jp"],
      ["www.example.co", "example.co"],
      ["t.co", "t.co"],
      ["someone.example.io", "example.io"],
      ["co.uk", "co.uk"],
      ["co.example.com", "example.com"],
    ] as const) {
      expect(registrable(host), host).toBe(kept);
    }
  });

  it("matches a private website, and the names under it, and nothing else", () => {
    const list = ["example.org"];
    for (const name of ["example.org", "www.example.org", "Chat.Example.ORG."]) expect(isPrivateWebsite(name, list), name).toBe(true);
    for (const name of ["myexample.org", "example.org.example.com", "example.com"]) expect(isPrivateWebsite(name, list), name).toBe(false);
    expect(neverKept("988.ca", [])).toBe(true);
    expect(neverKept("www.example.org", list)).toBe(true);
    expect(neverKept("example.net", list)).toBe(false);
  });
});

describe("the policy's network_log.private_domains", () => {
  it("is empty by default, sorted, sent whether logging is on or off, and each change is a new version", async () => {
    const { t, phone, ctx, parent, policy, make } = await family();
    expect(policy()).toMatchObject({ version: 0, network_log: { enabled: false, private_domains: [] } });
    const added = make("https://www.example.org/help");
    expect(added).toMatchObject({ changed: true, version: 1, result: { domain: "example.org", already: false } });
    make("example.net", true, { kind: "server" });
    expect(policy()).toMatchObject({ version: 2, network_log: { enabled: false, private_domains: ["example.net", "example.org"] } });
    // The same one again changes nothing.
    expect(make("EXAMPLE.org")).toMatchObject({ changed: false, version: 2, result: { domain: "example.org", already: true } });
    setNetworkLog(ctx(), phone.deviceId, true, parent);
    expect(policy().network_log).toEqual({ enabled: true, private_domains: ["example.net", "example.org"] });
    expect(make("example.net", false)).toMatchObject({ changed: true, version: 4, result: { domain: "example.net", already: false } });
    expect(make("example.net", false)).toMatchObject({ changed: false, result: { already: true } });
    // Taking off something that could never be private changes nothing either.
    expect(make("not a name", false)).toMatchObject({ changed: false, result: { already: true } });
    expect(policy().network_log.private_domains).toEqual(["example.org"]);
    expect(listPrivateWebsites(t.deps.db, phone.deviceId)).toEqual([{ domain: "example.org", addedAt: T0, addedBy: "Sam" }]);
  });

  it("is checked like a network entry's domain, at most 100", async () => {
    const { t, phone } = await family();
    const sent = buildPolicy(t.deps.db, phone.deviceId, t.now());
    const withList = (private_domains: unknown) => ({ ...sent, network_log: { enabled: true, private_domains } });
    expect(Policy.parse(withList(["example.org", "xn--bcher-kva.example"])).network_log.private_domains).toEqual(["example.org", "xn--bcher-kva.example"]);
    expect(Policy.parse(withList(Array.from({ length: 100 }, (_, i) => `site${i}.example`))).network_log.private_domains).toHaveLength(100);
    for (const bad of [["Example.org"], ["example.org."], ["192.0.2.10"], ["localhost"], ["under_score.example"], [""], Array.from({ length: 101 }, (_, i) => `site${i}.example`)]) {
      expect(Policy.safeParse(withList(bad)).success, bad.slice(0, 2).join(" ")).toBe(false);
    }
    expect(Policy.safeParse({ ...sent, network_log: { enabled: true } }).success).toBe(false);
    expect(LIMITS.maxPrivateDomains).toBe(100);
  });

  it("refuses a name that isn't a website's, 988's websites, and a 101st, changing nothing", async () => {
    const { phone, t, policy, make } = await family();
    expect(() => make("example")).toThrow(RuleRefused);
    expect(() => make("988lifeline.org")).toThrow("Belay never notes 988's websites anyway, so there's no need to add one.");
    const insert = t.deps.db.prepare("INSERT INTO network_private_domains (device_id, domain, added_at) VALUES (?, ?, ?)");
    for (let i = 0; i < LIMITS.maxPrivateDomains; i++) insert.run(phone.deviceId, `site${i}.example`, T0);
    const version = policy().version;
    expect(() => make("one-more.example")).toThrow("A phone can have at most 100 private websites.");
    expect(privateDomainsOf(t.deps.db, phone.deviceId)).toHaveLength(100);
    expect(policy().version).toBe(version);
    // Taking one off still works.
    expect(make("site0.example", false).changed).toBe(true);
  });
});

describe("what the server keeps", () => {
  it("making a website private deletes what the server kept of it, and of the names under it, and nothing else", async () => {
    const { t, phone, network, kept, make } = await family({ on: true });
    const other = await enrollPhone(t, "Sam's tablet");
    setNetworkLog({ db: t.deps.db, now: t.now() }, other.deviceId, true, { kind: "server" });
    const sent = [
      entry("com.example.chat", "example.org", 9),
      entry("com.example.chat", "chat.example.org", 2),
      entry("com.example.browser", "example.org", 1),
      entry("com.example.chat", "myexample.org", 3),
      entry("com.example.chat", "example.org.example.com", 4),
      entry("com.example.chat", "example.com", 5),
    ];
    await network([day(sent), day(sent, { day: "2026-11-15" })]);
    await network([day(sent)], other.token);
    make("example.org");
    const left = ["com.example.chat example.com 5", "com.example.chat example.org.example.com 4", "com.example.chat myexample.org 3"];
    expect(kept()).toEqual([...left.map((e) => `${TODAY} ${e}`), ...left.map((e) => `2026-11-15 ${e}`)]);
    // Another phone's private websites are its own.
    expect(kept(other.deviceId)).toHaveLength(6);
    // The days themselves stay, with what else was looked up.
    expect(networkDays(t.deps.db, phone.deviceId).map((d) => d.day)).toEqual([TODAY, "2026-11-15"]);
  });

  it("drops a private website that arrives anyway, in any form, before the body is checked, without a word in its log", async () => {
    const { t, network, kept, make } = await family({ on: true });
    make("example.org");
    const res = await network([
      day([
        entry("com.example.chat", "example.com", 2),
        entry("com.example.chat", "example.org", 7),
        entry("com.example.chat", "cdn.example.org", 1),
        // Not a valid hostname, and private: taken out first, so the rest of its day still counts.
        { package: "com.example.browser", domain: "WWW.Example.ORG.", lookups: 1, whatever: true },
      ]),
    ]);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(kept()).toEqual([`${TODAY} com.example.chat example.com 2`]);
    // An older Belay sends them as a matter of course: the log's time would say when one was used.
    expect(t.logs.join("\n")).not.toMatch(/example\.org|private|never keeps/i);
    // 988's websites still say that a phone sent one (Belay on the phone has a bug), never which.
    await network([day([entry("com.example.chat", "example.com", 3), entry("com.example.chat", "988lifeline.org")])]);
    expect(t.logs.filter((l) => l.includes("988"))).toEqual(["A phone sent network activity naming 988's websites, which Belay never keeps: not kept. Belay on the phone shouldn't send it."]);
    expect(kept()).toEqual([`${TODAY} com.example.chat example.com 3`]);
  });

  it("notes the next lookups again once a parent takes the website off", async () => {
    const { network, kept, make } = await family({ on: true });
    make("example.org");
    await network([day([entry("com.example.chat", "example.org", 2)])]);
    expect(kept()).toEqual([]);
    make("example.org", false);
    await network([day([entry("com.example.chat", "example.org", 3)])]);
    expect(kept()).toEqual([`${TODAY} com.example.chat example.org 3`]);
  });

  it("stop collecting keeps the private websites: they're the phone's rules", async () => {
    const { t, phone, ctx, parent, network, make, policy } = await family({ on: true });
    make("example.org");
    await network([day([entry("com.example.chat", "example.com", 2)])]);
    const before = keptFor(t.deps.db, phone.deviceId, "network", t.now());
    expect(before.stays).toEqual(["The private websites, which network logging never notes: they're this phone's rules."]);
    expect(JSON.stringify(before)).not.toContain("example.org");
    stopCollecting(ctx(), phone.deviceId, "network", parent, before.fingerprint);
    expect(policy().network_log).toEqual({ enabled: false, private_domains: ["example.org"] });
  });
});

describe("who chooses the private websites", () => {
  it("only a parent (or the CLI acting as one): never an AI app, either way", async () => {
    const { t, phone, ai, policy, make } = await family();
    make("example.org");
    for (const on of [true, false]) {
      expect(() => setPrivateWebsite({ db: t.deps.db, now: t.now() }, phone.deviceId, "example.net", on, ai as never)).toThrow(/^Only a parent chooses the private websites/);
      expect(() => setPrivateWebsite({ db: t.deps.db, now: t.now() }, phone.deviceId, "example.org", on, ai as never)).toThrow(/^Only a parent/);
    }
    expect(policy().network_log.private_domains).toEqual(["example.org"]);
    expect(listAudit(t.deps.db, { limit: 10, includeReads: true }).filter((e) => e.actor === "ai")).toEqual([]);
  });

  it("is in the activity log with a count, never a name", async () => {
    const { t, sam, phone, make } = await family();
    make("https://www.example.org/help");
    make("example.net", true, { kind: "server" });
    make("example.org", false);
    const entries = listAudit(t.deps.db, { limit: 10, includeReads: true }).filter((e) => e.action.startsWith("network."));
    expect(entries.map((e) => [e.actor, e.action, e.detail])).toEqual([
      ["parent", "network.private_removed", { count: 1, version: 3 }],
      ["server", "network.private_added", { count: 1, version: 2 }],
      ["parent", "network.private_added", { count: 1, version: 1 }],
    ]);
    expect(entries.every((e) => e.deviceId === phone.deviceId)).toBe(true);
    const rows = JSON.stringify(t.deps.db.prepare("SELECT * FROM audit_log").all());
    expect(rows).not.toMatch(/example\.(org|net)/);
    const html = await (await get(t, "/activity", sam.cookie)).text();
    expect(html).toContain("made a website private: network logging never notes it (Alex&#39;s phone)");
    expect(html).toContain("took a website off the private websites (Alex&#39;s phone)");
    expect(html).not.toMatch(/example\.(org|net)/);
  });
});

describe("the private websites on the parent page", () => {
  async function pages(opts: { on?: boolean } = {}) {
    const f = await family(opts);
    const base = `/devices/${f.phone.deviceId}`;
    const form = (path: string, fields: Record<string, string>, csrf = true) => postForm(f.t, path, { ...(csrf ? { _csrf: f.sam.csrf } : {}), ...fields }, { cookie: f.sam.cookie });
    const page = async (path: string) => {
      const res = await get(f.t, path, f.sam.cookie);
      return { status: res.status, html: await res.text() };
    };
    return { ...f, base, form, page };
  }

  it("are under network logging's switch, on or off, with what they do and who sees them", async () => {
    const { base, page } = await pages();
    const { html } = await page(base);
    expect(html.indexOf("<h4>Private websites</h4>")).toBeGreaterThan(html.indexOf('<h3 id="network-logging">Network logging</h3>'));
    expect(html).toContain('<div class="card" id="private-websites">');
    expect(html).toContain("Belay never notes these websites, or any name under them, like 988&#39;s: a helpline&#39;s or a counselor&#39;s site");
    expect(html).toContain("the kid&#39;s phone says some websites are never noted, without naming them (tell the kid yourself if they should know)");
    expect(html).toContain("AI apps don&#39;t see them, or whether there are any");
    expect(html).toContain("so www.example.org/help makes all of example.org private");
    expect(html).toContain(`action="${base}/network/private"`);
    expect(html).toContain("never 988&#39;s websites or this phone&#39;s private websites");
  });

  it("a parent adds one as typed, and it's kept as its registrable domain; then removes it", async () => {
    const { t, base, form, page, policy } = await pages({ on: true });
    const res = await form(`${base}/network/private`, { website: "https://www.Example.org/help" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`${base}?saved=private_website#private-websites`);
    expect(policy().network_log.private_domains).toEqual(["example.org"]);
    let { html } = await page(`${base}?saved=private_website`);
    expect(html).toContain("Saved: Belay never notes that website, or any name under it, and the server deleted what it kept of it.");
    expect(html).toContain('<strong class="pkg">example.org</strong>');
    expect(html).toContain(" by Sam");
    expect(html).toContain(`action="${base}/network/private/remove"`);
    expect(html).not.toContain('<p class="muted">None.</p>');
    // The Network tab says how many, and where to change them.
    ({ html } = await page(`${base}/network`));
    expect(html).toContain("1 private website is never noted here, with the");
    expect(html).toContain(`href="${base}#private-websites"`);
    const removed = await form(`${base}/network/private/remove`, { domain: "example.org" });
    expect(removed.headers.get("location")).toBe(`${base}?saved=private_website_removed#private-websites`);
    expect(policy().network_log.private_domains).toEqual([]);
    ({ html } = await page(`${base}?saved=private_website_removed`));
    expect(html).toContain("Taken off the private websites: while network logging is on, the phone notes it again.");
    expect(listAudit(t.deps.db, { limit: 2, includeReads: false }).map((e) => [e.actor, e.action])).toEqual([
      ["parent", "network.private_removed"],
      ["parent", "network.private_added"],
    ]);
  });

  it("need a parent signed in and the CSRF token", async () => {
    const { t, base, form, policy } = await pages();
    expect((await form(`${base}/network/private`, { website: "example.org" }, false)).status).toBe(403);
    expect((await postForm(t, `${base}/network/private`, { website: "example.org" })).status).toBe(401);
    expect((await form(`${base}/network/private/remove`, { domain: "example.org" }, false)).status).toBe(403);
    expect(policy().network_log.private_domains).toEqual([]);
  });

  it("a website Belay refuses shows the phone's page with why, and nothing is saved", async () => {
    const { base, form, policy } = await pages();
    for (const [website, why] of [
      ["988lifeline.org", "Belay never notes 988&#39;s websites anyway, so there&#39;s no need to add one."],
      ["example", "That isn&#39;t a website&#39;s name: type one like example.org"],
      ["", "Type a website&#39;s name, like example.org."],
    ] as const) {
      const res = await form(`${base}/network/private`, { website });
      expect(res.status, website).toBe(400);
      const html = await res.text();
      expect(html, website).toContain(why);
      expect(html).toContain("<h4>Private websites</h4>");
    }
    expect(policy().network_log.private_domains).toEqual([]);
  });

  it("at 100, the form to add one goes; on a disconnected phone, both forms do", async () => {
    const { t, phone, base, page, make } = await pages();
    make("example.org");
    const insert = t.deps.db.prepare("INSERT INTO network_private_domains (device_id, domain, added_at) VALUES (?, ?, ?)");
    for (let i = 1; i < LIMITS.maxPrivateDomains; i++) insert.run(phone.deviceId, `site${i}.example`, T0);
    let { html } = await page(base);
    expect(html).not.toContain(`action="${base}/network/private"`);
    expect(html).toContain(`action="${base}/network/private/remove"`);
    t.deps.db.prepare("UPDATE devices SET revoked_at = ? WHERE id = ?").run(t.now(), phone.deviceId);
    ({ html } = await page(base));
    expect(html).toContain('<strong class="pkg">example.org</strong>');
    expect(html).not.toContain(`action="${base}/network/private/remove"`);
  });
});
