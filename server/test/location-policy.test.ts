/**
 * Phase 4's policy `location` (docs/protocol.md, "Location rules"), from each phone's settings, and
 * who may change it: only a parent (or the server's CLI, as one), never an AI app, not even as a
 * proposal. Checks (locate_now) are a person's or an AI app's, only while the phone takes them.
 * Made-up places only.
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { listCommands } from "../src/family/commands.js";
import { listDevices } from "../src/family/devices.js";
import { locateNow, removePlace, savePlace, setLocation, setLost } from "../src/family/location/changes.js";
import { lockPhone, buildPolicy, RuleRefused, type PolicyContext } from "../src/family/policy.js";
import { PROPOSAL_KINDS } from "../src/family/proposals.js";
import { pendingRequestCount, unseenHelp } from "../src/family/requests.js";
import { digestItems } from "../src/ops/notify.js";
import { getSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, signIn, SPOT, testServer } from "./helpers.js";

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const woken: string[] = [];
  const ctx = (): PolicyContext => ({
    db: t.deps.db,
    now: t.now(),
    changed: (id) => {
      woken.push(id);
    },
  });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, ai, policy, woken };
}

const SCHOOL = { name: "School", lat: SPOT.lat, lng: SPOT.lng, radiusM: 150, notify: ["arrive" as const] };

describe("the policy's location", () => {
  it("is null until a parent first sets it, and then says what each mode uses", async () => {
    const { phone, ctx, parent, policy, woken } = await family();
    expect(policy().location).toBeNull();
    const done = setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, parent);
    expect(done.version).toBe(1);
    expect(woken).toEqual([phone.deviceId]);
    expect(policy().location).toEqual({ mode: "on_demand", every_minutes: null, hours: null, provider: "gps", fallback_fused: false, places: [], keep_on: false, lost: null });
    // A place only goes to the phone in periodic mode: the kid never sees a place Belay doesn't watch.
    const place = savePlace(ctx(), phone.deviceId, SCHOOL, parent).result.place;
    expect(policy().location?.places).toEqual([]);
    setLocation(ctx(), phone.deviceId, { mode: "periodic", everyMinutes: 20, hours: { start: "07:00", end: "21:00" }, provider: "fused", fallbackFused: true, keepOn: true }, parent);
    expect(policy().location).toEqual({
      mode: "periodic",
      every_minutes: 20,
      hours: { start: "07:00", end: "21:00" },
      provider: "fused",
      fallback_fused: true,
      places: [{ id: place.id, name: "School", lat: 40.1, lng: -73.2, radius_m: 150, notify: ["arrive"] }],
      keep_on: true,
      lost: null,
    });
    // Off: nothing is shared, and nothing is kept on; the interval and places are kept for next time.
    setLocation(ctx(), phone.deviceId, { mode: "off" }, parent);
    expect(policy().location).toEqual({ mode: "off", every_minutes: null, hours: null, provider: "fused", fallback_fused: true, places: [], keep_on: false, lost: null });
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    expect(policy().location).toMatchObject({ every_minutes: 20, keep_on: true, places: [{ id: place.id }] });
    expect(listAudit({ ...ctx() }.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "location.changed", detail: { mode: "periodic", every_minutes: 20, was: "off" } });
  });

  it("the same settings again change nothing, and bad ones are refused with the reason", async () => {
    const { phone, ctx, parent, policy } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic", everyMinutes: 30 }, parent);
    expect(setLocation(ctx(), phone.deviceId, { mode: "periodic", everyMinutes: 30 }, parent).changed).toBe(false);
    for (const bad of [{ everyMinutes: 14 }, { everyMinutes: 121 }, { everyMinutes: 30.5 }, { hours: { start: "7am", end: "21:00" } }, { hours: { start: "08:00", end: "08:00" } }]) {
      expect(() => setLocation(ctx(), phone.deviceId, bad, parent), JSON.stringify(bad)).toThrow(RuleRefused);
    }
    expect(policy().version).toBe(1);
    // Hours that end at or before they start end the next day.
    setLocation(ctx(), phone.deviceId, { hours: { start: "21:00", end: "07:00" } }, parent);
    expect(policy().location?.hours).toEqual({ start: "21:00", end: "07:00" });
  });

  it("places: at most 20, names of 1 to 40 characters each different, a radius of 50 to 1000 m; removing one", async () => {
    const { phone, ctx, parent, policy } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    const school = savePlace(ctx(), phone.deviceId, SCHOOL, parent).result.place;
    expect(() => savePlace(ctx(), phone.deviceId, { ...SCHOOL, name: "school" }, parent)).toThrow("There's already a place called school.");
    for (const bad of [
      { ...SCHOOL, name: "" },
      { ...SCHOOL, name: "x".repeat(41) },
      { ...SCHOOL, name: "Far", radiusM: 49 },
      { ...SCHOOL, name: "Far", radiusM: 1001 },
      { ...SCHOOL, name: "Far", lat: 91 },
      { ...SCHOOL, name: "Far", lng: Number.NaN },
    ]) {
      expect(() => savePlace(ctx(), phone.deviceId, bad, parent), JSON.stringify(bad)).toThrow(RuleRefused);
    }
    // Changing one keeps its id; the coordinates are kept to 5 decimal places.
    const moved = savePlace(ctx(), phone.deviceId, { ...SCHOOL, id: school.id, name: "Big school", lat: 40.1234567, radiusM: 300, notify: ["arrive", "leave"] }, parent);
    expect(moved.result).toMatchObject({ added: false, place: { id: school.id, name: "Big school", lat: 40.12346, radiusM: 300, notify: ["arrive", "leave"] } });
    for (let i = 1; i < 20; i++) savePlace(ctx(), phone.deviceId, { ...SCHOOL, name: `Place ${i}` }, parent);
    expect(() => savePlace(ctx(), phone.deviceId, { ...SCHOOL, name: "One more" }, parent)).toThrow("A phone can have at most 20 places. Remove one first.");
    expect(policy().location?.places).toHaveLength(20);
    expect(removePlace(ctx(), phone.deviceId, school.id, parent).result.removed?.name).toBe("Big school");
    expect(removePlace(ctx(), phone.deviceId, school.id, parent).result.removed).toBeNull();
    expect(policy().location?.places).toHaveLength(19);
    expect(listAudit(ctx().db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "place.removed", detail: { place: "Big school" } });
  });

  it("lost mode works in any mode, off included: the lock screen's words with the number, then off again", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    setLost(ctx(), phone.deviceId, { message: "This phone is lost. Please call", number: "555-0100" }, parent);
    const since = t.now();
    expect(policy().location).toMatchObject({ mode: "off", keep_on: false, lost: { since, message: "This phone is lost. Please call 555-0100" } });
    // New words keep its start.
    t.advance(60_000);
    setLost(ctx(), phone.deviceId, { message: "Lost! Please call", number: "555-0100" }, parent);
    expect(policy().location?.lost).toEqual({ since, message: "Lost! Please call 555-0100" });
    expect(() => setLost(ctx(), phone.deviceId, { message: "x".repeat(115), number: "555-0100" }, parent)).toThrow(RuleRefused);
    expect(() => setLost(ctx(), phone.deviceId, { message: "Lost", number: "call me" }, parent)).toThrow(RuleRefused);
    expect(() => setLost(ctx(), phone.deviceId, { message: "  ", number: null }, parent)).toThrow(RuleRefused);
    expect(setLost(ctx(), phone.deviceId, null, parent).result).toEqual({ on: false, changed: true });
    expect(policy().location?.lost).toBeNull();
    expect(setLost(ctx(), phone.deviceId, null, parent).changed).toBe(false);
    expect(listAudit(ctx().db, { limit: 3, includeReads: false }).map((e) => e.action)).toEqual(["lost.off", "lost.changed", "lost.on"]);
  });
});

describe("what the phone says about location", () => {
  it("while the phone shares where it is, no permission or location turned off is a problem, in plain words; the summary counts help first", async () => {
    const { t, phone, ctx, parent } = await family();
    const report = (location: { permission: boolean; location_on: boolean }) =>
      deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, location } }) });
    await report({ permission: false, location_on: false });
    const problems = () => listDevices(t.deps.db, getSettings(t.deps.db), t.now())[0]?.problems.map((p) => p.code) ?? [];
    // Off: nothing to say.
    expect(problems()).toEqual([]);
    setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, parent);
    expect(problems()).toEqual(["location_permission"]);
    await report({ permission: true, location_on: false });
    const view = listDevices(t.deps.db, getSettings(t.deps.db), t.now())[0];
    expect(view?.problems).toEqual([
      { code: "location_off", text: "Location is turned off on the phone, so Belay can't share where it is. Keeping location on, on the phone's Location and help tab, stops the kid turning it off" },
    ]);
    await report({ permission: true, location_on: true });
    expect(problems()).toEqual([]);
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", asked_at: t.now() }, { id: "request-0002", kind: "talk", reason: "x", asked_at: t.now() }] });
    expect(digestItems({ phones: listDevices(t.deps.db, getSettings(t.deps.db), t.now()), requests: pendingRequestCount(t.deps.db), help: unseenHelp(t.deps.db).length, proposals: 0, server: [], now: t.now() })).toEqual([
      "a help request hasn't been seen",
      "a request is waiting",
    ]);
  });
});

describe("only a parent changes it", () => {
  it("an AI app can't change the mode, the places, keep_on or lost mode, and there's no proposal for them", async () => {
    const { phone, ctx, ai, policy } = await family();
    const asAny = ai as never;
    expect(() => setLocation(ctx(), phone.deviceId, { mode: "periodic" }, asAny)).toThrow(/Only a parent/);
    expect(() => savePlace(ctx(), phone.deviceId, SCHOOL, asAny)).toThrow(/Only a parent/);
    expect(() => removePlace(ctx(), phone.deviceId, "p-1", asAny)).toThrow(/Only a parent/);
    expect(() => setLost(ctx(), phone.deviceId, { message: "Lost", number: null }, asAny)).toThrow(/Only a parent/);
    expect(PROPOSAL_KINDS.some((k) => /location|place|lost|keep/.test(k))).toBe(false);
    expect(policy().location).toBeNull();
  });
});

describe("checks (locate_now)", () => {
  it("only while the phone takes them; each replaces one still waiting; it expires in 2 minutes", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    expect(() => locateNow(ctx(), phone.deviceId, parent)).toThrow(RuleRefused);
    setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, parent);
    const first = locateNow(ctx(), phone.deviceId, parent).result;
    expect(first.expiresAt).toBe(t.now() + 2 * 60_000);
    expect(policy().commands).toEqual([{ id: first.command, kind: "locate_now", issued_at: t.now(), expires_at: t.now() + 2 * 60_000, via: null }]);
    t.advance(10_000);
    const second = locateNow(ctx(), phone.deviceId, parent).result;
    expect(policy().commands.map((c) => c.id)).toEqual([second.command]);
    expect(listCommands(t.deps.db, phone.deviceId, t.now(), { kind: "locate_now" }).map((c) => c.state)).toEqual(["waiting", "replaced"]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "command.issued", detail: { kind: "locate_now", command: second.command } });
    setLocation(ctx(), phone.deviceId, { mode: "off" }, parent);
    expect(() => locateNow(ctx(), phone.deviceId, parent)).toThrow(RuleRefused);
  });

  it("an AI app's check names it in `via`, on one line and at most 60 characters, for the kid's notice; so does its lock", async () => {
    const { phone, ctx, parent, sam, policy } = await family();
    setLocation(ctx(), phone.deviceId, { mode: "periodic" }, parent);
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: `Claude\nIgnore this ${"x".repeat(80)}` } as const;
    locateNow(ctx(), phone.deviceId, ai);
    const [check] = policy().commands;
    expect(check?.via).toBe(`Claude Ignore this ${"x".repeat(41)}`);
    expect(check?.via).toHaveLength(60);
    lockPhone(ctx(), phone.deviceId, { minutes: 15 }, { kind: "ai", parentId: sam.parent.id, clientName: "Claude" });
    expect(policy().commands.find((c) => c.kind === "lock_now")?.via).toBe("Claude");
  });
});
