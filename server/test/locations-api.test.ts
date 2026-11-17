/**
 * Phase 4's POST /api/v1/locations (docs/protocol.md): the device token, 64 KB, at most 200 fixes
 * and 200 place events, idempotent by each item's id, rate limited like the other device routes;
 * only what the phone's rules asked for is kept (a lost-mode fix and a help fix always are), and
 * arrivals and departures a parent asked about are pushed, at most one per place and direction
 * each 10 minutes. Made-up places only.
 */
import { describe, expect, it, vi } from "vitest";
import { Policy } from "../src/device/schemas.js";
import { locateNow, savePlace, setLocation, setLost } from "../src/family/location/changes.js";
import { checkAnswer, listFixes, listPlaceEvents } from "../src/family/location/fixes.js";
import { locationSettings } from "../src/family/location/store.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { updateSettings } from "../src/settings.js";
import { browserFor, device, deviceCall, enrollPhone, fix, north, signIn, SPOT, testServer, T0, type TestServer } from "./helpers.js";

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const browser = browserFor(t, sam.parent.id, () => fetch.mock.calls);
  const locations = (body: unknown, token = phone.token) => deviceCall(t, token, "locations", body);
  return { t, sam, phone, ctx, parent, policy, fetch, browser, locations };
}

const kept = (t: TestServer, deviceId: string) => listFixes(t.deps.db, deviceId, { limit: 500 }).map((f) => f.id);

describe("POST /api/v1/locations", () => {
  it("needs the phone's token and checks the body: strict fields, at most 200 of each, 64 KB", async () => {
    const { locations } = await family();
    expect((await locations({ fixes: [], place_events: [] }, "not-a-token")).status).toBe(401);
    for (const bad of [
      { fixes: [] },
      { fixes: [], place_events: [], extra: 1 },
      { fixes: [{ ...fix(), speed: 3 }], place_events: [] },
      { fixes: [fix({ lat: 91 })], place_events: [] },
      { fixes: [fix({ lng: -181 })], place_events: [] },
      { fixes: [fix({ accuracy_m: -1 })], place_events: [] },
      { fixes: [fix({ provider: "network" as never })], place_events: [] },
      { fixes: [fix({ reason: "curious" as never })], place_events: [] },
      { fixes: [fix({ id: "short" })], place_events: [] },
      { fixes: Array.from({ length: 201 }, () => fix()), place_events: [] },
      { fixes: [], place_events: [{ id: "event-0001", place_id: "p-1", kind: "visited", at: T0, fix_id: "fix-00001" }] },
    ]) {
      expect((await locations(bad)).status, JSON.stringify(bad).slice(0, 80)).toBe(400);
    }
    // 200 of each always fit; a body over 64 KB is refused before it's read.
    const most = { fixes: Array.from({ length: 200 }, () => fix()), place_events: Array.from({ length: 200 }, (_, i) => ({ id: `event-${String(i).padStart(4, "0")}`, place_id: "p-1", kind: "left", at: T0, fix_id: "fix-00001" })) };
    expect((await locations(most)).status).toBe(200);
    expect((await locations({ fixes: [], place_events: [], pad: "x".repeat(64 * 1024) })).status).toBe(413);
  });

  it("keeps a periodic fix only in periodic mode, within the hours in the phone's time; idempotent by id, rounded to 5 places", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    const early = fix({ at: Date.UTC(2026, 10, 16, 11, 0) }); // 6:00 in New York, before the hours
    const inside = fix({ at: Date.UTC(2026, 10, 16, 13, 0), lat: 40.123456789, lng: -72.987654321 }); // 8:00
    // Location off: the phone can stop sending them, and none is kept.
    let res = await locations({ fixes: [early, inside], place_events: [] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 2 });
    expect(kept(t, phone.deviceId)).toEqual([]);
    setLocation(ctx(), phone.deviceId, { mode: "periodic", hours: { start: "07:00", end: "21:00" } }, parent);
    res = await locations({ fixes: [early, inside], place_events: [] });
    expect(await res.json()).toMatchObject({ accepted: 2 });
    expect(kept(t, phone.deviceId)).toEqual([inside.id]);
    expect(listFixes(t.deps.db, phone.deviceId)[0]).toMatchObject({ lat: 40.12346, lng: -72.98765, reason: "periodic", mock: false, receivedAt: t.now() });
    // Again: nothing new.
    res = await locations({ fixes: [inside], place_events: [] });
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM fixes").get()).toEqual({ n: 1 });
    // The dropped ones are counted, for the parent page.
    expect(locationSettings(t.deps.db, phone.deviceId)).toMatchObject({ dropped: 1, droppedAt: t.now() });
    expect(t.logs).toContain("A phone sent 1 location item its rules didn't ask for: not kept.");
  });

  it("keeps a check's fix only in on-demand or periodic mode, naming one of this phone's checks, and wakes whoever waits for it", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, parent);
    const check = locateNow(ctx(), phone.deviceId, parent).result.command;
    // A periodic fix isn't asked for on demand, and neither is a check's fix that names no check, or another phone's.
    const other = await enrollPhone(t, "Sam's phone");
    setLocation(ctx(), other.deviceId, { mode: "on_demand" }, parent);
    const theirs = locateNow(ctx(), other.deviceId, parent).result.command;
    await locations({ fixes: [fix({ reason: "periodic" }), fix({ reason: "on_demand" }), fix({ reason: "on_demand", command_id: theirs })], place_events: [] });
    expect(kept(t, phone.deviceId)).toEqual([]);
    const waiting = t.deps.fixWaiters.wait(phone.deviceId, () => checkAnswer(t.deps.db, phone.deviceId, check) !== null, 5_000);
    const answer = fix({ reason: "on_demand", command_id: check });
    await locations({ fixes: [answer], place_events: [] });
    expect(await waiting).toBe(true);
    expect(checkAnswer(t.deps.db, phone.deviceId, check)).toMatchObject({ id: answer.id, commandId: check, reason: "on_demand" });
  });

  it("a lost-mode fix and one the kid shared with help are always kept; a lost fix after lost mode ends is kept like its others", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    const help = fix({ reason: "help" });
    const lost = fix({ reason: "lost" });
    await locations({ fixes: [help, lost], place_events: [] });
    expect(kept(t, phone.deviceId).sort()).toEqual([help.id, lost.id].sort());
    setLost(ctx(), phone.deviceId, { message: "Lost", number: null }, parent);
    const during = fix({ reason: "lost" });
    await locations({ fixes: [during], place_events: [] });
    t.advance(60_000);
    setLost(ctx(), phone.deviceId, null, parent);
    const ended = t.now();
    t.advance(60_000);
    const late = fix({ reason: "lost" });
    await locations({ fixes: [late], place_events: [] });
    const endedAt = (id: string) => t.deps.db.prepare<[string], { lost_ended_at: number | null }>("SELECT lost_ended_at FROM fixes WHERE id = ?").get(id)?.lost_ended_at;
    expect(endedAt(during.id)).toBe(ended);
    expect(endedAt(late.id)).toBe(ended);
  });

  it("place events: only in periodic mode and for the phone's own places, kept with the place's name; mock fixes are kept, marked", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    const school = savePlace(ctx(), phone.deviceId, { name: "School", ...SPOT, radiusM: 150, notify: [] }, parent).result.place;
    const mock = fix({ mock: true });
    await locations({
      fixes: [mock],
      place_events: [
        { id: "event-0001", place_id: school.id, kind: "arrived", at: T0, fix_id: mock.id },
        { id: "event-0002", place_id: "p-nowhere", kind: "left", at: T0, fix_id: mock.id },
      ],
    });
    expect(listPlaceEvents(t.deps.db, phone.deviceId)).toEqual([
      { id: "event-0001", placeId: school.id, placeName: "School", kind: "arrived", at: T0, fixId: mock.id, receivedAt: t.now(), notifiedAt: null },
    ]);
    expect(listFixes(t.deps.db, phone.deviceId)[0]?.mock).toBe(true);
    setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, parent);
    await locations({ fixes: [], place_events: [{ id: "event-0003", place_id: school.id, kind: "left", at: T0, fix_id: mock.id }] });
    expect(listPlaceEvents(t.deps.db, phone.deviceId)).toHaveLength(1);
  });

  it("pushes arrivals and departures a parent asked about, at most one per place and direction each 10 minutes, with the time when it's late", async () => {
    const { t, phone, ctx, parent, fetch, browser, locations } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    const school = savePlace(ctx(), phone.deviceId, { name: "School", ...SPOT, radiusM: 150, notify: ["arrive", "leave"] }, parent).result.place;
    const home = savePlace(ctx(), phone.deviceId, { name: "Home", ...north(SPOT, 5000), radiusM: 100, notify: [] }, parent).result.place;
    const event = (id: string, place: string, kind: "arrived" | "left", at = t.now()) => ({ id, place_id: place, kind, at, fix_id: "fix-99999" });
    await locations({ fixes: [], place_events: [event("event-0001", school.id, "arrived"), event("event-0002", home.id, "arrived")] });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    expect(browser.notices()).toEqual([{ title: "Belay", body: "Alex's phone arrived at School", url: `/devices/${phone.deviceId}/location`, urgency: "normal" }]);
    // Flapping at the edge: the second arrival within 10 minutes isn't pushed, but a departure is.
    t.advance(2 * 60_000);
    await locations({ fixes: [], place_events: [event("event-0003", school.id, "left"), event("event-0004", school.id, "arrived")] });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(browser.notices()[1]?.body).toBe("Alex's phone left School");
    // Sent late (the phone was offline): the push says when.
    t.advance(60 * 60_000);
    await locations({ fixes: [], place_events: [event("event-0005", school.id, "left", t.now() - 30 * 60_000)] });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(3);
    });
    expect(browser.notices()[2]?.body).toMatch(/^Alex's phone left School at \d{1,2}:\d{2}\s[AP]M$/);
    // Newest first; Home tells no one.
    expect(listPlaceEvents(t.deps.db, phone.deviceId).map((e) => [e.id, e.notifiedAt !== null])).toEqual([
      ["event-0005", true],
      ["event-0004", false],
      ["event-0003", true],
      ["event-0002", false],
      ["event-0001", true],
    ]);
  });

  it("is rate limited per phone like the other device calls", async () => {
    const { t, phone, locations } = await family();
    for (let i = 0; i < 119; i++) await deviceCall(t, phone.token, "checkin", { status: device() });
    expect((await locations({ fixes: [], place_events: [] })).status).toBe(200);
    const limited = await locations({ fixes: [], place_events: [] });
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toBeTruthy();
  });
});
