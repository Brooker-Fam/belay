/**
 * Phase 3's network logging, the server's side (docs/protocol.md, "POST /api/v1/network"): the
 * device token, 512 KB, at most 31 days of at most 5000 entries, strict fields and hostnames;
 * idempotent by day (a day sent again replaces the stored one); kept only while a parent has the
 * phone's switch on (otherwise accepted, dropped and counted); never the never-blocked apps'
 * lookups, never 988's websites (taken out before the body is checked, and the server's log names
 * neither the site nor the phone); kept as long as the family keeps it; rate limited per phone
 * apart from its other calls. The switch is a parent's alone, and in the policy and the activity
 * log. Made-up apps and names only.
 */
import { describe, expect, it } from "vitest";
import { Policy } from "../src/device/schemas.js";
import { stopCollecting, keptFor } from "../src/family/collection.js";
import { setNetworkLog } from "../src/family/network/changes.js";
import { CRISIS_988, isCrisis, networkDays, networkSettings } from "../src/family/network/store.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { cleanUp } from "../src/maintenance.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, signIn, testServer, T0 } from "./helpers.js";

const DAY = 86_400_000;
const TODAY = "2026-11-16";

const entry = (pkg: string, domain: string, lookups = 1) => ({ package: pkg, domain, lookups });
const day = (over: Record<string, unknown> = {}) => ({
  day: TODAY,
  zone: "America/New_York",
  as_of: T0,
  entries: [entry("com.example.chat", "example.com", 42), entry("com.example.blocks", "example.net", 3)],
  dropped: 0,
  ...over,
});

async function family(opts: { on?: boolean } = {}) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  if (opts.on) setNetworkLog(ctx(), phone.deviceId, true, parent);
  const network = (body: unknown, token = phone.token) => deviceCall(t, token, "network", body);
  const kept = () => networkDays(t.deps.db, phone.deviceId).map((d) => ({ day: d.day, entries: d.entries.map((e) => `${e.package} ${e.domain} ${e.lookups}`) }));
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, network, kept, policy };
}

describe("POST /api/v1/network", () => {
  it("needs the phone's token and checks the body: strict fields, 1 to 31 days of at most 5000 entries, hostnames, 512 KB", async () => {
    const { network } = await family({ on: true });
    expect((await network({ days: [day()] }, "not-a-token")).status).toBe(401);
    for (const bad of [
      {},
      { days: [] },
      { days: [day()], extra: 1 },
      { days: [{ ...day(), urls: [] }] },
      { days: [day({ day: "Monday" })] },
      { days: [day({ dropped: -1 })] },
      { days: [day({ entries: [{ ...entry("com.example.chat", "example.com"), ip: "192.0.2.1" }] })] },
      { days: [day({ entries: [entry("com.example.chat", "example.com", 0)] })] },
      { days: [day({ entries: [entry("not a package", "example.com")] })] },
      { days: [day({ entries: [entry("android.uid.system:1000", "example.com")] })] },
      { days: [day({ entries: [entry("com.example.chat", "Example.com")] })] },
      { days: [day({ entries: [entry("com.example.chat", "example.com.")] })] },
      { days: [day({ entries: [entry("com.example.chat", "192.0.2.10")] })] },
      { days: [day({ entries: [entry("com.example.chat", "localhost")] })] },
      { days: [day({ entries: [entry("com.example.chat", "under_score.example")] })] },
      { days: [day({ entries: [entry("com.example.chat", "Bücher.example")] })] },
      { days: [day({ entries: [entry("com.example.chat", `${"a".repeat(64)}.example`)] })] },
      { days: [day({ entries: Array.from({ length: 5001 }, (_, i) => entry("com.example.chat", `site${i}.example`)) })] },
      { days: Array.from({ length: 32 }, (_, i) => day({ day: `2026-10-${String(i + 1).padStart(2, "0")}` })) },
    ]) {
      const res = await network(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 100)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    // The error names the field, never what was in it.
    const res = await network({ days: [day({ entries: [entry("com.example.chat", "secret-name.EXAMPLE")] })] });
    expect(await res.text()).not.toContain("secret");
    expect((await network({ days: [day({ entries: Array.from({ length: 5000 }, (_, i) => entry("com.example.chat", `site${i}.example`)) })] })).status).toBe(200);
    expect((await network({ days: [day()], pad: "x".repeat(512 * 1024) })).status).toBe(413);
  });

  it("keeps days only while a parent has the phone's switch on; otherwise accepts, drops and counts them", async () => {
    const { t, phone, ctx, parent, network, kept } = await family();
    let res = await network({ days: [day()] });
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(kept()).toEqual([]);
    setNetworkLog(ctx(), phone.deviceId, true, parent);
    res = await network({ days: [day()] });
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(kept()).toEqual([{ day: TODAY, entries: ["com.example.chat example.com 42", "com.example.blocks example.net 3"] }]);
    // Off again: what's kept stays (until the retention, or Stop collecting); new days are dropped and counted.
    setNetworkLog(ctx(), phone.deviceId, false, parent);
    res = await network({ days: [day({ day: "2026-11-15" }), day()] });
    expect(await res.json()).toMatchObject({ accepted: 2 });
    expect(kept()).toHaveLength(1);
    expect(networkSettings(t.deps.db, phone.deviceId)).toMatchObject({ enabled: false, dropped: 2, droppedAt: t.now() });
    expect(t.logs).toContain("A phone sent 2 days of network activity its rules didn't ask for: not kept.");
  });

  it("is idempotent by day: a day sent again replaces the stored one, entries and all", async () => {
    const { t, phone, network, kept } = await family({ on: true });
    await network({ days: [day(), day({ day: "2026-11-15", entries: [entry("com.example.chat", "example.org")] })] });
    await network({ days: [day({ as_of: T0 + 60_000, zone: "America/Chicago", entries: [entry("com.example.chat", "example.com", 50)], dropped: 7 })] });
    await network({ days: [day({ as_of: T0 + 60_000, zone: "America/Chicago", entries: [entry("com.example.chat", "example.com", 50)], dropped: 7 })] });
    expect(kept()).toEqual([
      { day: TODAY, entries: ["com.example.chat example.com 50"] },
      { day: "2026-11-15", entries: ["com.example.chat example.org 1"] },
    ]);
    expect(networkDays(t.deps.db, phone.deviceId)[0]).toMatchObject({ zone: "America/Chicago", asOf: T0 + 60_000, dropped: 7, receivedAt: t.now() });
  });

  it("never keeps the apps the phone never blocks, by name or as the phone reported them", async () => {
    const { t, phone, network, kept } = await family({ on: true });
    // The phone's own report names its texting app.
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, never_blocked: ["com.example.texts"] } }) });
    await network({
      days: [
        day({
          entries: [
            entry("com.google.android.dialer", "example.com"),
            entry("family.brooker.belay", "belay.example.org"),
            entry("com.example.texts", "example.net"),
            entry("com.example.chat", "example.com", 2),
          ],
        }),
      ],
    });
    expect(kept()).toEqual([{ day: TODAY, entries: ["com.example.chat example.com 2"] }]);
  });

  it("never keeps 988's websites: taken out before the body is checked, counted for no one, and the log says only that it happened", async () => {
    const { t, phone, network, kept } = await family({ on: true });
    const res = await network({
      days: [
        day({
          entries: [
            entry("com.example.chat", "example.com", 2),
            entry("com.example.chat", "988lifeline.org"),
            entry("com.example.chat", "chat.988lifeline.org"),
            entry("com.example.browser", "988.ca", 4),
            // Not a valid hostname, and naming 988: taken out first, so the rest of its day still counts.
            { package: "com.example.browser", domain: "Chat.988Lifeline.ORG.", lookups: 1, whatever: true },
          ],
        }),
      ],
    });
    expect(res.status).toBe(200);
    expect(kept()).toEqual([{ day: TODAY, entries: ["com.example.chat example.com 2"] }]);
    const line = t.logs.find((l) => l.includes("988")) ?? "";
    expect(line).toBe("A phone sent network activity naming 988's websites, which Belay never keeps: not kept. Belay on the phone shouldn't send it.");
    for (const n of ["lifeline", "988.ca", "com.example.browser", "Alex"]) expect(t.logs.join("\n"), n).not.toContain(n);
    expect(networkSettings(t.deps.db, phone.deviceId)?.dropped).toBe(0);
    expect(CRISIS_988).toEqual(["988lifeline.org", "988lineadevida.org", "suicidepreventionlifeline.org", "988.ca", "veteranscrisisline.net"]);
    expect(isCrisis("www.veteranscrisisline.net")).toBe(true);
    expect(isCrisis("my988lifeline.org")).toBe(false);
  });

  it("drops a day that isn't a real date, one the phone can't have counted yet, and one older than the family keeps", async () => {
    const { network, kept } = await family({ on: true });
    const res = await network({ days: [day({ day: "2026-02-30" }), day({ day: "2026-11-19" }), day({ day: "2026-10-01" }), day()] });
    expect(await res.json()).toMatchObject({ accepted: 4 });
    expect(kept().map((d) => d.day)).toEqual([TODAY]);
  });

  it("keeps network activity as long as the family does (30 days by default), then the hourly clean-up deletes it", async () => {
    const { t, network, kept } = await family({ on: true });
    expect(getSettings(t.deps.db).networkDays).toBe(30);
    await network({ days: [day({ day: "2026-10-17" }), day({ day: "2026-11-10" }), day()] });
    expect(kept()).toHaveLength(3);
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual([TODAY, "2026-11-10", "2026-10-17"]);
    t.advance(DAY);
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual([TODAY, "2026-11-10"]);
    updateSettings(t.deps.db, { networkDays: 3 });
    cleanUp(t.deps.db, t.now());
    expect(kept().map((d) => d.day)).toEqual([TODAY]);
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM network_lookups").get()).toEqual({ n: 2 });
    expect(() => updateSettings(t.deps.db, { networkDays: 0 })).toThrow();
    expect(() => updateSettings(t.deps.db, { networkDays: 91 })).toThrow();
  });

  it("is rate limited per phone, apart from the phone's other calls", async () => {
    const { t, phone, network } = await family({ on: true });
    for (let i = 0; i < 30; i++) expect((await network({ days: [day()] })).status).toBe(200);
    const res = await network({ days: [day()] });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await deviceCall(t, phone.token, "events", { events: [] })).status).toBe(200);
    t.advance(61_000);
    expect((await network({ days: [day()] })).status).toBe(200);
  });
});

describe("the network logging switch", () => {
  it("is the policy's network_log, off by default, and every change is a new version in the activity log", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    expect(policy()).toMatchObject({ version: 0, network_log: { enabled: false, private_domains: [] } });
    const on = setNetworkLog(ctx(), phone.deviceId, true, parent);
    expect(on).toMatchObject({ changed: true, result: { already: false } });
    expect(policy()).toMatchObject({ version: on.version, network_log: { enabled: true } });
    expect(setNetworkLog(ctx(), phone.deviceId, true, parent)).toMatchObject({ changed: false, result: { already: true } });
    t.advance(1000);
    setNetworkLog(ctx(), phone.deviceId, false, { kind: "server" });
    expect(policy().network_log).toEqual({ enabled: false, private_domains: [] });
    const log = t.deps.db.prepare("SELECT action, actor FROM audit_log WHERE action LIKE 'network.%' ORDER BY id").all();
    expect(log).toEqual([
      { action: "network.on", actor: "parent" },
      { action: "network.off", actor: "server" },
    ]);
    expect(networkSettings(t.deps.db, phone.deviceId)).toMatchObject({ enabled: false, enabledAt: T0 });
  });

  it("is never an AI app's to change, either way", async () => {
    const { phone, ctx, sam } = await family();
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
    expect(() => setNetworkLog(ctx(), phone.deviceId, true, ai as never)).toThrow(/Only a parent/);
    expect(() => setNetworkLog(ctx(), phone.deviceId, false, ai as never)).toThrow(/Only a parent/);
  });

  it("stop collecting deletes the phone's network activity and turns logging off, in the activity log", async () => {
    const { t, phone, ctx, parent, network, kept, policy } = await family({ on: true });
    await network({ days: [day(), day({ day: "2026-11-15" })] });
    const kept0 = keptFor(t.deps.db, phone.deviceId, "network", t.now());
    expect(kept0).toMatchObject({
      title: "Websites and services apps look up",
      goes: ["2 days of network activity: which websites and online services each app looked up, and how many times"],
      stopping: "Network logging turns off: the phone stops noting which websites and services its apps look up.",
      anything: true,
    });
    const done = stopCollecting(ctx(), phone.deviceId, "network", parent, kept0.fingerprint);
    expect(done.result.deleted).toEqual({ network_days: 2 });
    expect(kept()).toEqual([]);
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM network_lookups").get()).toEqual({ n: 0 });
    expect(policy().network_log).toEqual({ enabled: false, private_domains: [] });
    expect(keptFor(t.deps.db, phone.deviceId, "network", t.now())).toMatchObject({ goes: [], anything: false });
    const actions = t.deps.db.prepare<[], { action: string }>("SELECT action FROM audit_log ORDER BY id").all().map((r) => r.action);
    expect(actions.slice(-2)).toEqual(["network.off", "collection.stopped"]);
  });
});
