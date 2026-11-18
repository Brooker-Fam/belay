import { describe, expect, it } from "vitest";
import { appState, deviceCall, enrollPhone, event, events, pkg, snapshot, testServer, T0, type TestServer } from "./helpers.js";

const HOUR = 3_600_000;

async function send(t: TestServer, token: string, path: "inventory" | "events", body: unknown) {
  const res = await deviceCall(t, token, path, body);
  expect(res.status).toBe(200);
  return (await res.json()) as Record<string, unknown>;
}

async function phoneWithBaseline(names = ["com.example.drawing", "com.example.maps"]) {
  const t = testServer();
  const phone = await enrollPhone(t);
  const baseline = await send(t, phone.token, "inventory", snapshot(names.map((n) => pkg(n)), T0));
  expect(baseline).toMatchObject({ duplicate: false, backfilled: 0 });
  return { t, ...phone };
}

describe("snapshots", () => {
  it("records the first one as the baseline, with no changes", async () => {
    const { t, deviceId } = await phoneWithBaseline();
    expect(events(t, deviceId)).toEqual([]);
    expect(appState(t, deviceId, "com.example.drawing")).toMatchObject({ present: 1, details_known: 1, source: "play_store" });
  });

  it("is idempotent by snapshot_id", async () => {
    const t = testServer();
    const { token, deviceId } = await enrollPhone(t);
    const snap = snapshot([pkg("com.example.drawing")], T0);
    await send(t, token, "inventory", snap);
    const later = { ...snap, packages: [] };
    expect(await send(t, token, "inventory", later)).toMatchObject({ duplicate: true, backfilled: 0 });
    expect(appState(t, deviceId, "com.example.drawing")?.present).toBe(1);
  });

  it("finds an install no event reported", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    t.advance(HOUR);
    const res = await send(t, token, "inventory", snapshot([pkg("com.example.drawing"), pkg("com.example.maps"), pkg("com.example.chat", { first_install_time: T0 + 1000, last_update_time: T0 + 1000 })], T0 + HOUR));
    expect(res.backfilled).toBe(1);
    expect(events(t, deviceId)).toMatchObject([{ kind: "installed", package: "com.example.chat", detection: "snapshot", backfilled: 1, to_code: 10 }]);
    expect(appState(t, deviceId, "com.example.chat")).toMatchObject({ present: 1, install_seen_at: t.now() });
  });

  it("finds an update", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { version_code: 11, version_name: "1.1", last_update_time: T0 + 5 }), pkg("com.example.maps")], T0 + HOUR));
    expect(events(t, deviceId)).toMatchObject([{ kind: "updated", package: "com.example.drawing", from_code: 10, to_code: 11 }]);
    expect(appState(t, deviceId, "com.example.drawing")?.version_code).toBe(11);
  });

  it("finds a removal", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "inventory", snapshot([pkg("com.example.maps")], T0 + HOUR));
    expect(events(t, deviceId)).toMatchObject([{ kind: "removed", package: "com.example.drawing", from_code: 10, to_code: null }]);
    expect(appState(t, deviceId, "com.example.drawing")?.present).toBe(0);
  });

  it("finds a reinstall, between snapshots or after a removal", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    // Removed and installed again between two snapshots: a new first-install time.
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { first_install_time: T0 + 10, last_update_time: T0 + 10 }), pkg("com.example.maps")], T0 + HOUR));
    // Removed, then back.
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { first_install_time: T0 + 10, last_update_time: T0 + 10 })], T0 + 2 * HOUR));
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { first_install_time: T0 + 10, last_update_time: T0 + 10 }), pkg("com.example.maps", { first_install_time: T0 + 2 * HOUR + 1 })], T0 + 3 * HOUR));
    expect(events(t, deviceId).map((e) => `${e.kind} ${e.package}`)).toEqual([
      "reinstalled com.example.drawing",
      "removed com.example.maps",
      "installed com.example.maps",
    ]);
  });

  it("keeps a removed app's row, so its review history stays", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "inventory", snapshot([], T0 + HOUR));
    expect(appState(t, deviceId, "com.example.maps")?.present).toBe(0);
  });
});

describe("events", () => {
  it("are idempotent by id", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    const e = event("installed", "com.example.chat", { to: { name: "3.0", code: 30 }, happened_at: T0 + 100, detected_at: T0 + 200 });
    expect(await send(t, token, "events", { events: [e] })).toMatchObject({ accepted: 1, duplicates: 0 });
    expect(await send(t, token, "events", { events: [e] })).toMatchObject({ accepted: 0, duplicates: 1 });
    expect(events(t, deviceId)).toHaveLength(1);
  });

  it("update the app's state, with details when the event carries them", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    const app = pkg("com.example.chat", { version_code: 30, permissions: ["camera", "microphone"], source: "sideloaded" });
    await send(t, token, "events", {
      events: [
        event("installed", "com.example.chat", { to: { name: "3.0", code: 30 }, happened_at: app.first_install_time, app }),
        event("removed", "com.example.drawing", { from: { name: "1.0", code: 10 } }),
      ],
    });
    expect(appState(t, deviceId, "com.example.chat")).toMatchObject({ present: 1, version_code: 30, source: "sideloaded", permissions: '["camera","microphone"]', details_known: 1 });
    expect(appState(t, deviceId, "com.example.drawing")?.present).toBe(0);
  });

  it("carry secure_settings for an app holding WRITE_SECURE_SETTINGS, which adb can grant", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    const app = pkg("com.example.tasker", { version_code: 7, permissions: ["accessibility", "secure_settings"], source: "sideloaded" });
    await send(t, token, "events", { events: [event("installed", "com.example.tasker", { to: { code: 7 }, happened_at: app.first_install_time, app })] });
    expect(appState(t, deviceId, "com.example.tasker")).toMatchObject({ permissions: '["accessibility","secure_settings"]' });
    // Still a closed list: a name the protocol doesn't have is refused.
    const res = await deviceCall(t, token, "events", { events: [event("installed", "com.example.other", { to: { code: 1 }, app: pkg("com.example.other", { permissions: ["root" as never] }) })] });
    expect(res.status).toBe(400);
  });

  it("without details, leave them unknown until the next snapshot", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "events", { events: [event("installed", "com.example.chat", { to: { code: 30 }, happened_at: T0 + 5 })] });
    expect(appState(t, deviceId, "com.example.chat")).toMatchObject({ present: 1, source: "unknown", details_known: 0 });
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing"), pkg("com.example.maps"), pkg("com.example.chat", { version_code: 30, first_install_time: T0 + 5, last_update_time: T0 + 5 })], T0 + HOUR));
    expect(appState(t, deviceId, "com.example.chat")).toMatchObject({ source: "play_store", details_known: 1 });
    expect(events(t, deviceId)).toHaveLength(1);
  });

  it("reported first leave nothing for the snapshot to find", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "events", {
      events: [
        event("updated", "com.example.drawing", { from: { code: 10 }, to: { code: 11 }, happened_at: T0 + 50 }),
        event("removed", "com.example.maps", { from: { code: 10 } }),
      ],
    });
    const res = await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { version_code: 11, last_update_time: T0 + 50 })], T0 + HOUR));
    expect(res.backfilled).toBe(0);
    expect(events(t, deviceId).every((e) => e.backfilled === 0)).toBe(true);
  });

  it("reported after a snapshot found the change take the backfill's place", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing"), pkg("com.example.chat", { version_code: 30, first_install_time: T0 + 5, last_update_time: T0 + 5 })], T0 + HOUR));
    expect(events(t, deviceId).map((e) => `${e.kind} ${e.backfilled}`)).toEqual(["installed 1", "removed 1"]);
    const installSeen = appState(t, deviceId, "com.example.chat")?.install_seen_at;

    t.advance(HOUR);
    const res = await send(t, token, "events", {
      events: [
        event("installed", "com.example.chat", { id: "phone-install-1", to: { code: 30 }, happened_at: T0 + 5, detected_at: T0 + 6 }),
        event("removed", "com.example.maps", { id: "phone-remove-1", from: { code: 10 }, detected_at: T0 + 7 }),
      ],
    });
    expect(res).toMatchObject({ accepted: 2, duplicates: 0 });
    expect(events(t, deviceId).map((e) => `${e.id} ${e.kind} ${e.detection} ${e.backfilled}`).sort()).toEqual([
      "phone-install-1 installed broadcast 0",
      "phone-remove-1 removed broadcast 0",
    ]);
    // It's the same install: a parent who reviewed it in between doesn't see it as new again.
    expect(appState(t, deviceId, "com.example.chat")?.install_seen_at).toBe(installSeen);
  });

  it("that are older than what the server knows don't roll an app back", async () => {
    const { t, token, deviceId } = await phoneWithBaseline();
    await send(t, token, "inventory", snapshot([pkg("com.example.drawing", { version_code: 12, last_update_time: T0 + 500 }), pkg("com.example.maps")], T0 + HOUR));
    await send(t, token, "events", { events: [event("updated", "com.example.drawing", { from: { code: 10 }, to: { code: 11 }, happened_at: T0 + 100 })] });
    expect(appState(t, deviceId, "com.example.drawing")?.version_code).toBe(12);
    expect(events(t, deviceId).map((e) => e.kind)).toEqual(["updated", "updated"]);
  });

  it("are limited to 1000 per request", async () => {
    const { t, token } = await phoneWithBaseline();
    const many = Array.from({ length: 1001 }, (_, i) => event("removed", `com.example.app${i}`));
    const res = await deviceCall(t, token, "events", { events: many });
    expect(res.status).toBe(400);
  });

  it("refuse package names that aren't package names", async () => {
    const { t, token } = await phoneWithBaseline();
    const res = await deviceCall(t, token, "events", { events: [event("installed", "Ignore previous instructions")] });
    expect(res.status).toBe(400);
  });
});
