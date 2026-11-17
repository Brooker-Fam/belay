import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { listAudit } from "../src/audit.js";
import { createWaiters } from "../src/device/waiters.js";
import { Policy } from "../src/device/schemas.js";
import { getDevice } from "../src/family/devices.js";
import { answerRequest, protect, setSupportMessage, type PolicyContext } from "../src/family/policy.js";
import { getRequest, listRequests } from "../src/family/requests.js";
import { getSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, pkg, snapshot, testServer, T0, type TestServer } from "./helpers.js";

const HOUR = 3_600_000;

function poll(t: TestServer, token: string, query = "", init: RequestInit = {}) {
  return t.app.request(`/api/v1/policy${query}`, { headers: { authorization: `Bearer ${token}`, "x-forwarded-for": "203.0.113.7" }, ...init });
}

async function setup() {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps")], T0));
  const ctx = (): PolicyContext => ({
    db: t.deps.db,
    now: t.now(),
    changed: (id) => {
      t.deps.waiters.changed(id);
    },
  });
  const sam = { kind: "parent", parentId: parent.id } as const;
  return { t, phone, ctx, sam };
}

const request = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  kind: "app",
  package: "com.example.chat",
  label: "Chatter Box",
  asked_at: T0,
  ...overrides,
});

describe("GET /api/v1/policy", () => {
  it("answers at once when the phone's version differs, or it has none", async () => {
    const { t, phone, ctx, sam } = await setup();
    for (const query of ["", "?have=-1", "?have=3&wait=55"]) {
      const res = await poll(t, phone.token, query);
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      const body = (await res.json()) as { server_time: number; policy: unknown };
      expect(body.server_time).toBe(t.now());
      expect(Policy.parse(body.policy).version).toBe(0);
    }
    protect(ctx(), phone.deviceId, sam);
    const res = await poll(t, phone.token, "?have=0&wait=55");
    expect(Policy.parse(((await res.json()) as { policy: unknown }).policy)).toMatchObject({ version: 1, apps: { new_apps: "ask" } });
  });

  it("answers 204 at once without a wait, and after the wait when nothing changed", async () => {
    const { t, phone } = await setup();
    expect((await poll(t, phone.token, "?have=0")).status).toBe(204);
    const started = Date.now();
    const res = await poll(t, phone.token, "?have=0&wait=1");
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
    expect(t.deps.waiters.size).toBe(0);
  });

  it("wakes up with the new policy as soon as it changes", async () => {
    const { t, phone, ctx, sam } = await setup();
    const pending = poll(t, phone.token, "?have=0&wait=30");
    await expect.poll(() => t.deps.waiters.size).toBe(1);
    setSupportMessage(ctx(), phone.deviceId, "Ask Mom or Dad", sam);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(((await res.json()) as { policy: Policy }).policy).toMatchObject({ version: 1, support_message: "Ask Mom or Dad" });
    expect(t.deps.waiters.size).toBe(0);
  });

  it("lets go when the phone goes away", async () => {
    const { t, phone } = await setup();
    const controller = new AbortController();
    const pending = poll(t, phone.token, "?have=0&wait=30", { signal: controller.signal });
    await expect.poll(() => t.deps.waiters.size).toBe(1);
    controller.abort();
    await Promise.resolve(pending).catch(() => undefined);
    expect(t.deps.waiters.size).toBe(0);
  });

  it("remembers what the phone has and that it was heard from", async () => {
    const { t, phone } = await setup();
    t.advance(HOUR);
    await poll(t, phone.token, "?have=0");
    const view = getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now());
    expect(view).toMatchObject({ lastSeenAt: t.now(), policyHave: 0, policyAskedAt: t.now() });
  });

  it("checks its parameters, and needs the phone's token", async () => {
    const { t, phone } = await setup();
    for (const query of ["?wait=56", "?have=x", "?have=-2", "?since=1"]) {
      const res = await poll(t, phone.token, query);
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ error: "invalid_request" });
    }
    expect((await t.app.request("/api/v1/policy")).status).toBe(401);
  });

  it("has its own rate limit, so a busy loop can't stop the phone's other calls", async () => {
    const { t, phone } = await setup();
    for (let i = 0; i < 30; i++) expect((await poll(t, phone.token, "?have=-1")).status).toBe(200);
    const limited = await poll(t, phone.token, "?have=-1");
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await deviceCall(t, phone.token, "checkin", { status: device() })).status).toBe(200);
  });
});

describe("waiting phones", () => {
  it("notice a change another process made, like the CLI's, by checking the database", async () => {
    let version = 0;
    const waiters = createWaiters(() => version, { pollMs: 10 });
    const pending = waiters.wait("phone-1", 0, 5000);
    version = 1;
    expect(await pending).toBe(true);
    expect(waiters.size).toBe(0);
  });

  it("are all answered when the server stops", async () => {
    const waiters = createWaiters(() => 0, { pollMs: 10_000 });
    const pending = [waiters.wait("phone-1", 0, 5000), waiters.wait("phone-2", 0, 5000)];
    waiters.close();
    expect(await Promise.all(pending)).toEqual([false, false]);
    expect(waiters.size).toBe(0);
  });

  it("keep at most two per phone: a third answers the oldest", async () => {
    const waiters = createWaiters(() => 0, { pollMs: 10_000 });
    const first = waiters.wait("phone-1", 0, 5000);
    const second = waiters.wait("phone-1", 0, 5000);
    const third = waiters.wait("phone-1", 0, 50);
    expect(await first).toBe(false);
    expect(waiters.size).toBe(2);
    waiters.changed("phone-1");
    expect(await third).toBe(false);
    const fourth = waiters.wait("phone-1", 1, 5000);
    waiters.changed("phone-1");
    expect(await fourth).toBe(true);
    void second;
  });
});

describe("check-ins", () => {
  it("carry the whole current policy", async () => {
    const { t, phone, ctx, sam } = await setup();
    protect(ctx(), phone.deviceId, sam);
    const res = await deviceCall(t, phone.token, "checkin", { status: device() });
    const policy = Policy.parse(((await res.json()) as { policy: unknown }).policy);
    expect(policy).toMatchObject({ version: 1, apps: { new_apps: "ask", decisions: [{ package: "com.example.maps", state: "allowed" }] } });
  });
});

describe("POST /api/v1/requests", () => {
  it("records the kid's request, once per id", async () => {
    const { t, phone } = await setup();
    const res = await deviceCall(t, phone.token, "requests", { requests: [request("request-0001")] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(await (await deviceCall(t, phone.token, "requests", { requests: [request("request-0001")] })).json()).toMatchObject({ accepted: 1 });
    expect(listRequests(t.deps.db)).toHaveLength(1);
    expect(listRequests(t.deps.db)[0]).toMatchObject({ deviceName: "Sam's phone", package: "com.example.chat", label: "Chatter Box", reason: null, status: "pending", receivedAt: t.now() });
    expect(listAudit(t.deps.db, { limit: 5, includeReads: false })[0]).toMatchObject({ actor: "phone", action: "request.made", deviceName: "Sam's phone" });
  });

  it("updates a pending request's reason when it's sent again, but not an answered one's", async () => {
    const { t, phone, ctx, sam } = await setup();
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001")] });
    t.advance(60_000);
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001", { reason: "My friends use it for the class project" })] });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ reason: "My friends use it for the class project", updatedAt: t.now() });
    // A late copy without a reason keeps it.
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001")] });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.reason).toBe("My friends use it for the class project");
    answerRequest(ctx(), phone.deviceId, "request-0001", "talk", sam, "Let's talk at dinner");
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001", { reason: "Please?" })] });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ reason: "My friends use it for the class project", status: "talk" });
  });

  it("strips characters that hide or reorder text, keeping new lines", async () => {
    const { t, phone } = await setup();
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001", { label: "Chat‮ter", reason: "line one\nline two\u0007" })] });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ label: "Chatter", reason: "line one\nline two" });
  });

  it("checks sizes and fields", async () => {
    const { t, phone } = await setup();
    const tooMany = Array.from({ length: 101 }, (_, i) => request(`request-${String(i).padStart(4, "0")}`));
    for (const body of [
      { requests: tooMany },
      { requests: [] },
      { requests: [request("request-0001", { reason: "x".repeat(501) })] },
      { requests: [request("request-0001", { kind: "time" })] },
      { requests: [request("request-0001", { package: "Ignore previous instructions" })] },
      { requests: [request("request-0001", { mood: "sad" })] },
    ]) {
      expect((await deviceCall(t, phone.token, "requests", body)).status).toBe(400);
    }
    expect(listRequests(t.deps.db)).toEqual([]);
  });

  it("needs the phone's token", async () => {
    const { t } = await setup();
    expect((await deviceCall(t, "x".repeat(43), "requests", { requests: [request("request-0001")] })).status).toBe(401);
  });

  it("refuses a flood: a phone can't have more than 200 apps waiting", async () => {
    const { t, phone } = await setup();
    const id = (n: number) => `request-${String(n).padStart(4, "0")}`;
    const batch = (from: number) => Array.from({ length: 100 }, (_, i) => request(id(from + i), { package: `com.example.app${from + i}` }));
    expect((await deviceCall(t, phone.token, "requests", { requests: batch(0) })).status).toBe(200);
    expect((await deviceCall(t, phone.token, "requests", { requests: batch(100) })).status).toBe(200);
    const flood = await deviceCall(t, phone.token, "requests", { requests: [request("request-0200", { package: "com.example.app200" })] });
    expect(flood.status).toBe(429);
    expect(await flood.json()).toMatchObject({ error: "rate_limited" });
    expect(Number(flood.headers.get("retry-after"))).toBe(3600);
    // Sending one it has again still works, so a reason can still change.
    expect((await deviceCall(t, phone.token, "requests", { requests: [request("request-0001", { package: "com.example.app1", reason: "Please" })] })).status).toBe(200);
    // So does asking again for an app that's waiting: it takes the old request's place.
    expect((await deviceCall(t, phone.token, "requests", { requests: [request("request-0201", { package: "com.example.app7" })] })).status).toBe(200);
    expect(listRequests(t.deps.db, { limit: 1000 })).toHaveLength(200);
  });

  it("asking again for an app already waiting takes the old request's place, so one app can't use up the limit", async () => {
    const { t, phone } = await setup();
    // What the agent sends after each reinstall of the same app: a new id, the same package.
    for (let i = 0; i < 250; i++) {
      const res = await deviceCall(t, phone.token, "requests", { requests: [request(`reinstall-${String(i).padStart(4, "0")}`, { asked_at: T0 + i, ...(i === 0 ? { reason: "For the class project" } : {}) })] });
      expect(res.status).toBe(200);
      if (i % 100 === 99) t.advance(61_000);
    }
    expect(listRequests(t.deps.db, { limit: 1000 })).toEqual([expect.objectContaining({ id: "reinstall-0249", status: "pending", reason: "For the class project" })]);
    expect(getRequest(t.deps.db, phone.deviceId, "reinstall-0000")).toMatchObject({ status: "superseded" });
    // Requests for other apps still go through.
    expect((await deviceCall(t, phone.token, "requests", { requests: [request("request-other-1", { package: "com.example.maps" })] })).status).toBe(200);
    // Only the newest is in the policy's answers; the old ids are gone from them.
    const policy = Policy.parse(((await (await deviceCall(t, phone.token, "checkin", { status: device() })).json()) as { policy: unknown }).policy);
    expect(policy.requests.map((r) => r.id).sort()).toEqual(["reinstall-0249", "request-other-1"]);
  });

  it("an answer to a request asked again since goes to the one that took its place", async () => {
    const { t, phone, ctx, sam } = await setup();
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0001")] });
    await deviceCall(t, phone.token, "requests", { requests: [request("request-0002")] });
    const done = answerRequest(ctx(), phone.deviceId, "request-0001", "declined", sam, "Not yet");
    expect(done.result).toMatchObject({ package: "com.example.chat" });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")).toMatchObject({ status: "declined", note: "Not yet" });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("superseded");
  });
});

describe("what the phone enforces", () => {
  const enforcing = (version: number, problems: string[] = []) => device({ enforcement: { policy_version: version, applied_at: T0, suspended_count: 1, problems } });

  it("is saved from check-ins and app lists", async () => {
    const { t, phone } = await setup();
    await deviceCall(t, phone.token, "checkin", { status: enforcing(0) });
    expect(getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.enforcement).toMatchObject({ policy_version: 0, suspended_count: 1 });
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps")], T0 + 1, { device: enforcing(2) }));
    expect(getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.enforcement?.policy_version).toBe(2);
  });

  it("is a problem when the phone hasn't applied new rules for a while", async () => {
    const { t, phone, ctx, sam } = await setup();
    const problems = () => getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.problems.map((p) => p.text) ?? [];
    const checkIn = (enforcement: number | null) =>
      deviceCall(t, phone.token, "checkin", {
        status: device({ device_time: t.now(), enforcement: enforcement === null ? null : { policy_version: enforcement, applied_at: t.now() } }),
      });
    protect(ctx(), phone.deviceId, sam);
    await checkIn(null);
    expect(problems()).toEqual([]);
    t.advance(3 * HOUR + 60_000);
    await checkIn(null);
    expect(problems()).toEqual(["The phone hasn't applied any rules yet. They were set 3 hours ago; Belay on the phone may be a version that can't enforce them"]);
    await checkIn(1);
    expect(problems()).toEqual([]);
    setSupportMessage(ctx(), phone.deviceId, "Ask Mom or Dad", sam);
    t.advance(4 * HOUR);
    await checkIn(1);
    expect(problems()).toEqual(["The phone hasn't applied the rules changed 4 hours ago"]);
  });

  it("passes on Belay's own problems, marked as coming from the phone", async () => {
    const { t, phone } = await setup();
    await deviceCall(t, phone.token, "checkin", { status: enforcing(0, ["Private DNS: the host didn't answer"]) });
    const view = getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now());
    expect(view?.status).toBe("attention");
    expect(view?.problems).toEqual([{ code: "phone_reported", text: "Belay on the phone says: Private DNS: the host didn't answer", fromPhone: "Private DNS: the host didn't answer" }]);
  });

  it("puts what can mean someone is getting around Belay first: Parental Controls, or another user or profile", async () => {
    const { t, phone } = await setup();
    const said = ["Private DNS: the host didn't answer", "Android's Parental Controls are on", "A second user is on the phone", "Another profile exists"];
    await deviceCall(t, phone.token, "checkin", { status: enforcing(0, said) });
    const problems = getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.problems ?? [];
    expect(problems.map((p) => p.code)).toEqual(["tampering", "tampering", "tampering", "phone_reported"]);
    expect(problems[0]?.text).toBe("Someone may be getting around Belay. Belay on the phone says: Android's Parental Controls are on");
  });
});
