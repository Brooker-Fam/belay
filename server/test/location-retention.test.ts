/**
 * How long the server keeps where the phone was (Phase 4), as the family's settings say, pruned by
 * the hourly clean-up: periodic fixes 7 days, checks 30, arrivals and departures 90, lost-mode
 * fixes until 7 days after lost mode ends (never while it's on), a help request's fix with the
 * request. Made-up places only.
 */
import { describe, expect, it } from "vitest";
import { locateNow, savePlace, setLocation, setLost } from "../src/family/location/changes.js";
import { listFixes, listPlaceEvents } from "../src/family/location/fixes.js";
import type { PolicyContext } from "../src/family/policy.js";
import { cleanUp } from "../src/maintenance.js";
import { getSettings, updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, fix, signIn, SPOT, testServer, type TestServer } from "./helpers.js";

const DAY = 86_400_000;

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
  const locations = (fixes: unknown[], events: unknown[] = []) => deviceCall(t, phone.token, "locations", { fixes, place_events: events });
  return { t, phone, ctx, parent, locations };
}

const ids = (t: TestServer, deviceId: string) =>
  listFixes(t.deps.db, deviceId, { limit: 500 })
    .map((f) => f.id)
    .sort();

describe("keeping where the phone was", () => {
  it("periodic fixes 7 days, checks 30, arrivals and departures 90, by default", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    const place = savePlace(ctx(), phone.deviceId, { name: "School", ...SPOT, radiusM: 150, notify: [] }, parent).result.place;
    const check = locateNow(ctx(), phone.deviceId, parent).result.command;
    const periodic = fix({ at: t.now() });
    const near = fix({ at: t.now(), reason: "place" });
    const answer = fix({ at: t.now(), reason: "on_demand", command_id: check });
    await locations([periodic, near, answer], [{ id: "event-0001", place_id: place.id, kind: "arrived", at: t.now(), fix_id: periodic.id }]);
    t.advance(7 * DAY - 1);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([periodic.id, near.id, answer.id].sort());
    t.advance(1);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([answer.id]);
    t.advance(23 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([]);
    expect(listPlaceEvents(t.deps.db, phone.deviceId)).toHaveLength(1);
    t.advance(60 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(listPlaceEvents(t.deps.db, phone.deviceId)).toHaveLength(0);
    // The check itself is gone once it's been over for a month, as a lock_now's is.
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE kind = 'locate_now'").get()).toEqual({ n: 0 });
  });

  it("the family chooses how long, within limits", async () => {
    const { t, phone, locations } = await family();
    updateSettings(t.deps.db, { locationDays: { periodic: 1 } });
    expect(getSettings(t.deps.db).locationDays).toEqual({ periodic: 1, checks: 30, placeEvents: 90, lostAfter: 7 });
    expect(() => updateSettings(t.deps.db, { locationDays: { periodic: 31 } })).toThrow();
    expect(() => updateSettings(t.deps.db, { locationDays: { placeEvents: 0 } })).toThrow();
    const periodic = fix({ at: t.now() });
    await locations([periodic]);
    t.advance(DAY);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([]);
  });

  it("a fix from a phone whose clock is ahead counts from when it arrived", async () => {
    const { t, phone, locations } = await family();
    const ahead = fix({ at: t.now() + 365 * DAY });
    await locations([ahead]);
    t.advance(7 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([]);
  });

  it("lost-mode fixes stay while lost mode is on, then 7 days after it ends", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    setLost(ctx(), phone.deviceId, { message: "Lost", number: null }, parent);
    const lost = fix({ at: t.now(), reason: "lost" });
    await locations([lost]);
    t.advance(60 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([lost.id]);
    setLost(ctx(), phone.deviceId, null, parent);
    t.advance(7 * DAY - 1);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([lost.id]);
    t.advance(1);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([]);
  });

  it("a help request's fix is kept with the request; one the phone sent alone, like a check's", async () => {
    const { t, phone, locations } = await family();
    const shared = fix({ at: t.now(), reason: "help" });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", location: shared, asked_at: t.now() }] });
    const alone = fix({ at: t.now(), reason: "help" });
    await locations([alone]);
    t.advance(400 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([shared.id]);
    // Without its request (as if it were deleted), it goes too.
    t.deps.db.prepare("DELETE FROM requests WHERE id = 'request-0001'").run();
    cleanUp(t.deps.db, t.now());
    expect(ids(t, phone.deviceId)).toEqual([]);
  });

  it("deleting a disconnected phone deletes where it was, its places and its settings", async () => {
    const { t, phone, ctx, parent, locations } = await family();
    savePlace(ctx(), phone.deviceId, { name: "School", ...SPOT, radiusM: 150, notify: [] }, parent);
    await locations([fix()]);
    t.deps.db.prepare("UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?").run(t.now(), phone.deviceId);
    t.deps.db.prepare("DELETE FROM devices WHERE id = ?").run(phone.deviceId);
    for (const table of ["fixes", "places", "place_events", "location_settings"]) {
      expect(t.deps.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get(), table).toEqual({ n: 0 });
    }
  });
});
