/**
 * Phase 7's requests (docs/protocol.md, "The kid's side"): "I need help" (urgent: a push to every
 * parent at once, at the top until a parent sees it, seen in the policy's help_seen), "Talk to my
 * parent", and withdrawing a pending request; and the policy's ai_reads and parent_numbers. Made-up
 * names and places only.
 */
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { changeFamilySettings, markHelpSeen, putPhoneParentNumber, setPhoneParentNumbers } from "../src/family/kidside-changes.js";
import { answerRequest, buildPolicy, RuleRefused, type PolicyContext } from "../src/family/policy.js";
import { getRequest, listRequests, pendingRequestCount, unseenHelp } from "../src/family/requests.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { browserFor, deviceCall, enrollPhone, fix, signIn, testServer, type TestServer } from "./helpers.js";

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const browser = browserFor(t, sam.parent.id, () => fetch.mock.calls);
  return { t, sam, phone, ctx, parent, fetch, policy, browser };
}

const send = (t: TestServer, token: string, ...requests: Record<string, unknown>[]) => deviceCall(t, token, "requests", { requests });
const help = (t: TestServer, id: string, over: Record<string, unknown> = {}) => ({ id, kind: "help", asked_at: t.now(), ...over });
const talk = (t: TestServer, id: string, reason: string, over: Record<string, unknown> = {}) => ({ id, kind: "talk", reason, asked_at: t.now(), ...over });

describe("I need help", () => {
  it("pushes to every parent at once, urgently; then again when the kid adds words or where the phone is", async () => {
    const { t, phone, fetch, browser } = await family();
    // A second parent's browser hears it too.
    const pat = await signIn(t, "pat", "Pat");
    const other = browserFor(t, pat.parent.id, () => fetch.mock.calls);
    const res = await send(t, phone.token, help(t, "request-0001"));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1 });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    const first = { title: "Belay: help", body: "Alex's phone needs help.", url: "/requests#help", urgent: true, urgency: "high" };
    expect(browser.notices()).toEqual([first]);
    expect(other.notices()).toEqual([first]);
    // The same request again, with the kid's words and where the phone is: the parents hear the words.
    await send(t, phone.token, help(t, "request-0001", { reason: "I'm lost‮ near the station", location: fix({ reason: "help" }) }));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(4);
    });
    expect(browser.notices()[1]).toEqual({
      title: "Belay: more about the help request",
      body: 'Alex\'s phone needs help: "I\'m lost near the station". They shared where the phone is.',
      url: "/requests#help",
      urgent: true,
      urgency: "high",
    });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({
      kind: "help",
      status: "pending",
      reason: "I'm lost near the station",
      seenAt: null,
      fix: { reason: "help", lat: 40.1, lng: -73.2 },
    });
    expect(listAudit(t.deps.db, { limit: 5, includeReads: false }).map((e) => [e.actor, e.action, e.detail?.kind])).toContainEqual(["phone", "request.made", "help"]);
  });

  it("says what the kid wrote, end-to-end encrypted, and stays at the top, counted as waiting, until a parent sees it", async () => {
    const { t, phone, ctx, parent, policy, browser } = await family();
    await send(t, phone.token, { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() });
    t.advance(60_000);
    await send(t, phone.token, help(t, "request-0002", { reason: "Please call me" }));
    await vi.waitFor(() => {
      expect(browser.notices().map((n) => n.body)).toContain('Alex\'s phone needs help: "Please call me".');
    });
    t.advance(60_000);
    await send(t, phone.token, talk(t, "request-0003", "My curfew"));
    expect(listRequests(t.deps.db, { deviceId: phone.deviceId }).map((r) => r.id)).toEqual(["request-0002", "request-0003", "request-0001"]);
    expect(pendingRequestCount(t.deps.db)).toBe(3);
    expect(unseenHelp(t.deps.db).map((r) => r.id)).toEqual(["request-0002"]);
    expect(policy().requests.find((r) => r.id === "request-0002")).toEqual({ id: "request-0002", status: "pending", note: null, answered_at: null, answered_by: null, minutes: null });
    expect(policy().help_seen).toEqual([]);

    // A parent sees it: the policy says so, in a new version, and it leaves the top.
    const before = policy().version;
    t.advance(30_000);
    const seen = markHelpSeen(ctx(), phone.deviceId, "request-0002", parent, "On my way");
    expect(seen.result).toEqual({ already: false, seenAt: t.now() });
    expect(seen.version).toBe(before + 1);
    expect(policy().help_seen).toEqual([{ request_id: "request-0002", at: t.now(), by: "Sam" }]);
    expect(policy().requests.find((r) => r.id === "request-0002")).toEqual({ id: "request-0002", status: "approved", note: "On my way", answered_at: t.now(), answered_by: "Sam", minutes: null });
    expect(unseenHelp(t.deps.db)).toEqual([]);
    expect(pendingRequestCount(t.deps.db)).toBe(2);
    expect(listRequests(t.deps.db, { deviceId: phone.deviceId }).map((r) => r.id)).toEqual(["request-0003", "request-0001", "request-0002"]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "request.seen", detail: { kind: "help", note: "On my way" } });
    // Seen again: nothing changes. Answering it isn't how it's done.
    expect(markHelpSeen(ctx(), phone.deviceId, "request-0002", parent)).toMatchObject({ changed: false, result: { already: true } });
    expect(() => answerRequest(ctx(), phone.deviceId, "request-0002", "approved", parent, null)).toThrow(RuleRefused);
    expect(markHelpSeen(ctx(), phone.deviceId, "request-0001", parent).result).toBeNull();
    // help_seen covers the last 30 days.
    t.advance(31 * 86_400_000);
    expect(policy().help_seen).toEqual([]);
  });

  it("is never refused for the other kinds' caps, and its own notices don't use up theirs", async () => {
    const { t, phone, fetch } = await family();
    // Six notices an hour about one phone: app requests use them up.
    for (let i = 0; i < 7; i++) await send(t, phone.token, { id: `request-a${String(i).padStart(4, "0")}`, kind: "app", package: `com.example.app${i}`, label: `App ${i}`, asked_at: t.now() });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(6);
    });
    await send(t, phone.token, help(t, "request-0001"));
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(7);
    });
  });

  it("takes the fix the kid shared even with location off, kept with the request; sent again, a newer one takes its place, as a new reason does", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    expect(policy().location).toBeNull();
    const fixOf = (id: string) => {
      const r = getRequest(t.deps.db, phone.deviceId, id);
      return r?.kind === "help" ? r.fix : undefined;
    };
    const count = () => t.deps.db.prepare("SELECT COUNT(*) AS n FROM fixes").get();
    // The phone sends the request at once, then again with the words and the fix (the same id).
    await send(t, phone.token, help(t, "request-0001"));
    expect(fixOf("request-0001")).toBeNull();
    const shared = fix({ reason: "help", lat: 40.123456789, lng: -72.987654321 });
    await send(t, phone.token, help(t, "request-0001", { reason: "Lost", location: shared }));
    expect(fixOf("request-0001")).toMatchObject({ id: shared.id, lat: 40.12346, lng: -72.98765, reason: "help", requestId: "request-0001" });
    // The same one again changes nothing, and nor does a resend without one.
    await send(t, phone.token, help(t, "request-0001", { location: shared }));
    await send(t, phone.token, help(t, "request-0001"));
    expect(fixOf("request-0001")?.id).toBe(shared.id);
    // A newer one takes its place: the older isn't kept.
    const newer = fix({ reason: "help", lat: 40.2, lng: -72.9 });
    await send(t, phone.token, help(t, "request-0001", { location: newer }));
    expect(fixOf("request-0001")).toMatchObject({ id: newer.id, lat: 40.2, lng: -72.9 });
    expect(count()).toEqual({ n: 1 });
    // A fix id the phone already used for another kind of fix never takes its place.
    await deviceCall(t, phone.token, "locations", { fixes: [fix({ id: "fix-elsewhere", reason: "lost" })], place_events: [] });
    await send(t, phone.token, help(t, "request-0001", { location: fix({ id: "fix-elsewhere", reason: "help" }) }));
    expect(fixOf("request-0001")?.id).toBe(newer.id);
    // Once a parent has seen it, it's answered: a resend changes nothing.
    markHelpSeen(ctx(), phone.deviceId, "request-0001", parent);
    await send(t, phone.token, help(t, "request-0001", { location: fix({ reason: "help", lat: 1, lng: 1 }) }));
    expect(fixOf("request-0001")?.id).toBe(newer.id);
    expect(count()).toEqual({ n: 2 });
  });

  it("caps help no parent has seen at 100 a phone", async () => {
    const { t, phone } = await family();
    const batch = (from: number) => Array.from({ length: 50 }, (_, i) => help(t, `request-${String(from + i).padStart(4, "0")}`));
    expect((await send(t, phone.token, ...batch(0))).status).toBe(200);
    expect((await send(t, phone.token, ...batch(50))).status).toBe(200);
    expect((await send(t, phone.token, help(t, "request-0999"))).status).toBe(429);
    expect(unseenHelp(t.deps.db)).toHaveLength(100);
  });
});

describe("Talk to my parent", () => {
  it("is a normal request: it waits, the parents hear the kid's words, and a parent answers it", async () => {
    const { t, phone, ctx, parent, policy, browser } = await family();
    await send(t, phone.token, talk(t, "request-0001", "Getting a game"));
    await vi.waitFor(() => {
      expect(browser.notices()[0]).toMatchObject({ body: 'Alex\'s phone: the kid would like to talk: "Getting a game"', url: "/requests#request-request-0001", urgency: "normal" });
    });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ kind: "talk", status: "pending", reason: "Getting a game" });
    const done = answerRequest(ctx(), phone.deviceId, "request-0001", "talk", parent, "After dinner");
    expect(done.result).toMatchObject({ kind: "talk" });
    expect(policy().requests).toEqual([{ id: "request-0001", status: "talk", note: "After dinner", answered_at: t.now(), answered_by: "Sam", minutes: null }]);
  });

  it("needs words, and takes only its own fields", async () => {
    const { t, phone } = await family();
    for (const bad of [
      { id: "request-0001", kind: "talk", asked_at: 1 },
      { id: "request-0001", kind: "talk", reason: "", asked_at: 1 },
      { id: "request-0001", kind: "talk", reason: "x".repeat(501), asked_at: 1 },
      { id: "request-0001", kind: "talk", reason: "x", location: fix(), asked_at: 1 },
      { id: "request-0001", kind: "help", reason: "x", package: "com.example.chat", asked_at: 1 },
      { id: "request-0001", kind: "help", location: { ...fix(), extra: 1 }, asked_at: 1 },
      { id: "request-0001", kind: "help", withdrawn_at: -1, asked_at: 1 },
    ]) {
      expect((await send(t, phone.token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect(listRequests(t.deps.db)).toEqual([]);
  });
});

describe("withdrawing", () => {
  it("a pending request sent again with withdrawn_at leaves the policy's requests, in a new version, and is in the activity log", async () => {
    const { t, phone, policy } = await family();
    await send(t, phone.token, { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() });
    await send(t, phone.token, { id: "request-0002", kind: "more_time", limit_id: "l-games", minutes: 15, asked_at: t.now() });
    const before = policy();
    expect(before.requests.map((r) => r.id)).toEqual(["request-0002", "request-0001"]);
    t.advance(60_000);
    const res = await send(t, phone.token, { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() - 60_000, withdrawn_at: t.now() });
    expect(res.status).toBe(200);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "withdrawn", withdrawnAt: t.now() });
    const after = policy();
    expect(after.version).toBe(before.version + 1);
    expect(after.requests.map((r) => r.id)).toEqual(["request-0002"]);
    expect(pendingRequestCount(t.deps.db)).toBe(1);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "phone", action: "request.withdrawn", detail: { kind: "app" } });
    // It can't be answered now, and sending it again changes nothing.
    expect(() => answerRequest({ db: t.deps.db, now: t.now() }, phone.deviceId, "request-0001", "approved", { kind: "server" }, null)).toThrow(RuleRefused);
    await send(t, phone.token, { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", reason: "Please", asked_at: t.now() });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "withdrawn", reason: null });
  });

  it("an answered request can't be withdrawn", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    await send(t, phone.token, talk(t, "request-0001", "My curfew"));
    answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, "OK");
    await send(t, phone.token, talk(t, "request-0001", "My curfew", { withdrawn_at: t.now() }));
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "approved", withdrawnAt: null });
    expect(policy().requests).toHaveLength(1);
  });

  it("a help request withdrawn before a parent saw it stays at the top until one does", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    await send(t, phone.token, help(t, "request-0001", { reason: "Never mind" }));
    await send(t, phone.token, help(t, "request-0001", { withdrawn_at: t.now() }));
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "withdrawn", seenAt: null });
    expect(policy().requests).toEqual([]);
    expect(unseenHelp(t.deps.db).map((r) => r.id)).toEqual(["request-0001"]);
    expect(pendingRequestCount(t.deps.db)).toBe(1);
    markHelpSeen(ctx(), phone.deviceId, "request-0001", parent);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "withdrawn", seenAt: t.now() });
    expect(policy().help_seen).toEqual([{ request_id: "request-0001", at: t.now(), by: "Sam" }]);
    expect(pendingRequestCount(t.deps.db)).toBe(0);
  });

  it("one made and withdrawn before it reached the server is kept as withdrawn, takes no one's place, and isn't news", async () => {
    const { t, phone, fetch } = await family();
    await send(t, phone.token, { id: "request-0001", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await send(t, phone.token, { id: "request-0002", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now(), withdrawn_at: t.now() });
    await new Promise((r) => setTimeout(r, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(listRequests(t.deps.db, { deviceId: phone.deviceId }).map((r) => [r.id, r.status])).toEqual([
      ["request-0001", "pending"],
      ["request-0002", "withdrawn"],
    ]);
  });
});

describe("the policy's ai_reads and parent_numbers", () => {
  it("ai_reads lists the AI scopes that are on; changing them gives every phone a new version at once", async () => {
    const { t, phone, policy, parent } = await family();
    const second = await enrollPhone(t, "Sam's phone");
    expect(policy().ai_reads).toEqual(["apps", "device_status", "requests", "screen_time", "agreement", "mobile_data"]);
    const changed: string[] = [];
    const done = changeFamilySettings(
      {
        db: t.deps.db,
        now: t.now(),
        changed: (id) => {
          changed.push(id);
        },
      },
      { aiScopes: { location: true, screen_time: false } },
      parent,
    );
    expect(done.phonesChanged).toBe(2);
    expect(changed.sort()).toEqual([phone.deviceId, second.deviceId].sort());
    expect(policy()).toMatchObject({ version: 1, ai_reads: ["apps", "device_status", "requests", "agreement", "location", "mobile_data"] });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "settings.changed", detail: { phones_changed: 2 } });
    // Nothing a phone sees changed: no new version.
    expect(changeFamilySettings({ db: t.deps.db, now: t.now() }, { silentHours: 6 }, parent).phonesChanged).toBe(0);
  });

  it("parent_numbers: the family's from Settings, or the phone's own; at most 4, E.164", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    expect(policy().parent_numbers).toEqual([]);
    changeFamilySettings(ctx(), { parentNumbers: [{ name: " Mom ", number: "+1 (555) 555-0100" }] }, parent);
    expect(policy()).toMatchObject({ version: 1, parent_numbers: [{ name: "Mom", number: "+15555550100" }] });
    // The phone's own list starts from the family's.
    putPhoneParentNumber(ctx(), phone.deviceId, { name: "Dad", number: "+15555550101" }, parent);
    expect(policy().parent_numbers).toEqual([
      { name: "Mom", number: "+15555550100" },
      { name: "Dad", number: "+15555550101" },
    ]);
    // The family's changing no longer touches this phone.
    changeFamilySettings(ctx(), { parentNumbers: [] }, parent);
    expect(policy().parent_numbers).toHaveLength(2);
    expect(() => putPhoneParentNumber(ctx(), phone.deviceId, { name: "Gran", number: "555-0102" }, parent)).toThrow(RuleRefused);
    expect(() => setPhoneParentNumbers(ctx(), phone.deviceId, Array.from({ length: 5 }, (_, i) => ({ name: `P${i}`, number: `+1555555010${i}` })), parent)).toThrow(RuleRefused);
    expect(() => changeFamilySettings(ctx(), { parentNumbers: [{ name: "", number: "+15555550100" }] }, parent)).toThrow(RuleRefused);
    setPhoneParentNumbers(ctx(), phone.deviceId, null, parent);
    expect(policy().parent_numbers).toEqual([]);
    expect(getSettings(t.deps.db).parentNumbers).toEqual([]);
    // A number stored wrong (by hand) never reaches the phone.
    updateSettings(t.deps.db, { parentNumbers: [{ name: "Mom", number: "+15555550100" }] });
    t.deps.db.prepare("UPDATE settings SET value = ? WHERE key = 'parent_numbers'").run(JSON.stringify([{ name: "Mom", number: "call me" }, { name: "Dad", number: "+15555550101" }]));
    expect(policy().parent_numbers).toEqual([{ name: "Dad", number: "+15555550101" }]);
  });
});
