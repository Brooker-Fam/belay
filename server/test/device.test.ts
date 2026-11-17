import { describe, expect, it } from "vitest";
import { sha256 } from "../src/crypto.js";
import { createEnrollmentCode } from "../src/device/enroll.js";
import { revokeDevice } from "../src/family/devices.js";
import { device, deviceCall, enrollPhone, post, testServer } from "./helpers.js";

describe("enrollment", () => {
  it("gives a phone a 256-bit token and keeps only its hash", async () => {
    const t = testServer();
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    const res = await post(t, "/api/v1/enroll", { code, device: device() });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.device_name).toBe("Test phone");
    expect(body.server_time).toBe(t.now());
    expect(body.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const row = t.deps.db.prepare("SELECT token_hash, facts FROM devices").get() as { token_hash: string; facts: string };
    expect(row.token_hash).toBe(sha256(body.token as string));
    expect(JSON.stringify(t.deps.db.prepare("SELECT * FROM devices").all())).not.toContain(body.token as string);
    expect(JSON.stringify(t.deps.db.prepare("SELECT * FROM enrollment_codes").all())).not.toContain(code);
    expect((JSON.parse(row.facts) as { model: string }).model).toBe("Pixel 8");
  });

  it("accepts the code the way people type it", async () => {
    const t = testServer();
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    const typed = `${code.slice(0, 4).toLowerCase()}-${code.slice(4)} `;
    expect((await post(t, "/api/v1/enroll", { code: typed, device: device() })).status).toBe(200);
  });

  it("works once", async () => {
    const t = testServer();
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    expect((await post(t, "/api/v1/enroll", { code, device: device() })).status).toBe(200);
    const again = await post(t, "/api/v1/enroll", { code, device: device() });
    expect(again.status).toBe(400);
    expect(await again.json()).toMatchObject({ error: "invalid_code" });
  });

  it("expires after 30 minutes", async () => {
    const t = testServer();
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    t.advance(30 * 60_000);
    const res = await post(t, "/api/v1/enroll", { code, device: device() });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_code" });
  });

  it("slows down guessing from one address", async () => {
    const t = testServer();
    for (let i = 0; i < 10; i++) {
      const res = await post(t, "/api/v1/enroll", { code: "00000000", device: device() });
      expect(res.status).toBe(400);
    }
    const blocked = await post(t, "/api/v1/enroll", { code: "00000000", device: device() });
    expect(blocked.status).toBe(429);
    expect(await blocked.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);

    // Even the right code waits, from that address; another address is fine.
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    expect((await post(t, "/api/v1/enroll", { code, device: device() })).status).toBe(429);
    expect((await post(t, "/api/v1/enroll", { code, device: device() }, { "x-forwarded-for": "198.51.100.2" })).status).toBe(200);

    t.advance(15 * 60_000 + 1);
    expect((await post(t, "/api/v1/enroll", { code: "00000000", device: device() })).status).toBe(400);
  });

  it("slows down guessing from many addresses", async () => {
    const t = testServer();
    for (let i = 0; i < 100; i++) {
      await post(t, "/api/v1/enroll", { code: "00000000", device: device() }, { "x-forwarded-for": `198.51.100.${i}` });
    }
    const res = await post(t, "/api/v1/enroll", { code: "00000000", device: device() }, { "x-forwarded-for": "192.0.2.1" });
    expect(res.status).toBe(429);
  });

  it("rejects unknown fields, naming them", async () => {
    const t = testServer();
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    const res = await post(t, "/api/v1/enroll", { code, device: { ...device(), imei: "123" } });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; error_description: string };
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toContain('"imei"');
  });

  it("rejects a body that isn't JSON, or is too big", async () => {
    const t = testServer();
    expect((await post(t, "/api/v1/enroll", "{not json")).status).toBe(400);
    const big = await post(t, "/api/v1/enroll", { code: "x".repeat(20_000), device: device() });
    expect(big.status).toBe(413);
    expect(await big.json()).toMatchObject({ error: "too_large" });
    const form = await t.app.request("/api/v1/enroll", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" });
    expect(form.status).toBe(400);
  });

  it("keeps phone names unique when two codes were made with the same name", async () => {
    const t = testServer();
    const first = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    const second = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "Test phone", createdBy: null });
    await post(t, "/api/v1/enroll", { code: first.code, device: device() });
    const res = await post(t, "/api/v1/enroll", { code: second.code, device: device() });
    expect(await res.json()).toMatchObject({ device_name: "Test phone (2)" });
  });

  it("reconnects a phone under its old record, keeping its history", async () => {
    const t = testServer();
    const first = await enrollPhone(t, "Test phone");
    revokeDevice(t.deps.db, first.deviceId, t.now());
    const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: "ignored", createdBy: null, deviceId: first.deviceId });
    const res = await post(t, "/api/v1/enroll", { code, device: device() });
    const body = (await res.json()) as { device_id: string; device_name: string; token: string };
    expect(body.device_id).toBe(first.deviceId);
    expect(body.device_name).toBe("Test phone");
    expect((await deviceCall(t, first.token, "checkin", { status: device() })).status).toBe(401);
    expect((await deviceCall(t, body.token, "checkin", { status: device() })).status).toBe(200);
  });
});

describe("device auth", () => {
  it("answers 401 without a token, with a wrong one, and after a parent disconnects the phone", async () => {
    const t = testServer();
    const { token, deviceId } = await enrollPhone(t);
    const none = await post(t, "/api/v1/checkin", { status: device() });
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("invalid_token");
    expect(await none.json()).toMatchObject({ error: "invalid_token" });
    expect((await deviceCall(t, "x".repeat(43), "checkin", { status: device() })).status).toBe(401);

    expect((await deviceCall(t, token, "checkin", { status: device() })).status).toBe(200);
    revokeDevice(t.deps.db, deviceId, t.now());
    for (const path of ["checkin", "inventory", "events"]) {
      expect((await deviceCall(t, token, path, {})).status).toBe(401);
    }
  });

  it("checks in: stores the facts and answers with the empty Phase 1 policy", async () => {
    const t = testServer();
    const { token, deviceId } = await enrollPhone(t);
    t.advance(60_000);
    const res = await deviceCall(t, token, "checkin", { status: device({ battery_percent: 42 }) });
    expect(await res.json()).toEqual({ server_time: t.now(), policy: { version: 0 } });
    const row = t.deps.db.prepare("SELECT facts, last_checkin_at FROM devices WHERE id = ?").get(deviceId) as { facts: string; last_checkin_at: number };
    expect(row.last_checkin_at).toBe(t.now());
    expect((JSON.parse(row.facts) as { battery_percent: number }).battery_percent).toBe(42);
  });

  it("has no CORS on the device API", async () => {
    const t = testServer();
    const res = await t.app.request("/api/v1/checkin", { method: "OPTIONS", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });
});
