/** The device API: what the agent on the phone calls (docs/protocol.md). No CORS, no cookies. */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { audit } from "../audit.js";
import { normalizeCode, sha256 } from "../crypto.js";
import type { Deps } from "../deps.js";
import { buildPolicy, policyVersion } from "../family/policy.js";
import { saveRequests } from "../family/requests.js";
import { bearerToken, clientAddress, readJson, type Bindings } from "../http.js";
import { notifyParents, requestNotice } from "../push.js";
import type { Verdict } from "../ratelimit.js";
import { applyEvents, applyInventory } from "./apps.js";
import { enroll } from "./enroll.js";
import { CheckinRequest, EnrollRequest, EventsRequest, InventoryRequest, LIMITS, PolicyQuery, RequestsRequest, type Device } from "./schemas.js";

interface PhoneRow {
  id: string;
  name: string;
}

type DeviceEnv = { Bindings: Bindings; Variables: { phone: PhoneRow } };

type ErrorCode = "invalid_request" | "invalid_code" | "invalid_token" | "not_found" | "too_large" | "rate_limited";

function fail(status: 400 | 401 | 404 | 413 | 429, error: ErrorCode, description: string, retryAfter?: number): Response {
  const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
  if (retryAfter !== undefined) headers.set("retry-after", String(retryAfter));
  if (status === 401) headers.set("www-authenticate", 'Bearer error="invalid_token"');
  return new Response(JSON.stringify({ error, error_description: description }), { status, headers });
}

function limit(maxSize: number) {
  return bodyLimit({
    maxSize,
    onError: () => fail(413, "too_large", `The body is larger than ${maxSize} bytes`),
  });
}

function blocked(...verdicts: Verdict[]): number | null {
  const waits = verdicts.flatMap((v) => (v.ok ? [] : [v.retryAfterSeconds]));
  return waits.length ? Math.max(...waits) : null;
}

const isPolicyPoll = (method: string, path: string) => method === "GET" && path.endsWith("/policy");

export function deviceRoutes(deps: Deps): Hono<DeviceEnv> {
  const { db, limits } = deps;
  const app = new Hono<DeviceEnv>();

  const saveFacts = (deviceId: string, device: Device, now: number) => {
    db.prepare("UPDATE devices SET facts = ?, facts_at = ?, last_seen_at = ? WHERE id = ?").run(JSON.stringify(device), now, now, deviceId);
  };

  app.post("/enroll", limit(LIMITS.enrollBytes), async (c) => {
    const client = clientAddress(c, deps.config.trustProxy);
    const wait = blocked(limits.enrollPerClient.check(client), limits.enrollGlobal.check("all"));
    if (wait !== null) return fail(429, "rate_limited", "Too many wrong codes. Wait, then try again.", wait);

    const body = await readJson(c, EnrollRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const code = normalizeCode(body.value.code);
    const enrolled = code ? enroll(db, code, body.value.device, now) : null;
    if (!enrolled) {
      limits.enrollPerClient.hit(client);
      limits.enrollGlobal.hit("all");
      return fail(400, "invalid_code", "That code is wrong, already used, or expired. Make a new one on the Add a phone page.");
    }
    audit(db, now, { kind: "phone", deviceId: enrolled.deviceId }, enrolled.reconnected ? "phone.reconnected" : "phone.enrolled", {
      detail: { model: body.value.device.model },
    });
    deps.log(`A phone ${enrolled.reconnected ? "reconnected" : "enrolled"}.`);
    c.header("Cache-Control", "no-store");
    return c.json({ device_id: enrolled.deviceId, device_name: enrolled.deviceName, token: enrolled.token, server_time: now });
  });

  // Everything else needs the device token.
  app.use("*", async (c, next) => {
    const token = bearerToken(c.req.header("authorization"));
    const phone = token
      ? db.prepare<[string], PhoneRow>("SELECT id, name FROM devices WHERE token_hash = ? AND revoked_at IS NULL").get(sha256(token))
      : undefined;
    if (!phone) return fail(401, "invalid_token", "This phone isn't connected to Belay. A parent can reconnect it from the parent page.");
    const limiter = isPolicyPoll(c.req.method, c.req.path) ? limits.policyPerPhone : limits.devicePerPhone;
    const verdict = limiter.hit(phone.id);
    if (!verdict.ok) return fail(429, "rate_limited", "Too many requests", verdict.retryAfterSeconds);
    c.set("phone", phone);
    return next();
  });

  app.post("/checkin", limit(LIMITS.checkinBytes), async (c) => {
    const body = await readJson(c, CheckinRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    saveFacts(c.var.phone.id, body.value.status, now);
    db.prepare("UPDATE devices SET last_checkin_at = ? WHERE id = ?").run(now, c.var.phone.id);
    return c.json({ server_time: now, policy: buildPolicy(db, c.var.phone.id, now) });
  });

  app.post("/inventory", limit(LIMITS.inventoryBytes), async (c) => {
    const body = await readJson(c, InventoryRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    saveFacts(c.var.phone.id, body.value.device, now);
    const result = applyInventory(db, c.var.phone.id, body.value, now);
    return c.json({ server_time: now, duplicate: result.duplicate, backfilled: result.backfilled });
  });

  app.post("/events", limit(LIMITS.eventsBytes), async (c) => {
    const body = await readJson(c, EventsRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, c.var.phone.id);
    const result = applyEvents(db, c.var.phone.id, body.value.events, now);
    return c.json({ server_time: now, accepted: result.accepted, duplicates: result.duplicates });
  });

  /**
   * The long-poll: answers at once when the phone's version isn't the server's, else holds
   * the request up to `wait` seconds for a change, then answers 204.
   */
  app.get("/policy", async (c) => {
    const query = PolicyQuery.safeParse(c.req.query());
    if (!query.success) {
      const issue = query.error.issues[0];
      const what = issue?.code === "unrecognized_keys" ? `unknown parameter ${issue.keys.map((k) => `"${k}"`).join(", ")}` : `${issue?.path.join(".") ?? "query"}: ${issue?.message ?? "invalid"}`;
      return fail(400, "invalid_request", what.slice(0, 300));
    }
    const have = query.data.have ?? -1;
    const wait = query.data.wait ?? 0;
    const phone = c.var.phone;
    const now = deps.now();
    db.prepare("UPDATE devices SET last_seen_at = ?, policy_have = ?, policy_asked_at = ? WHERE id = ?").run(now, have >= 0 ? have : null, now, phone.id);
    c.header("Cache-Control", "no-store");
    const answer = () => {
      const at = deps.now();
      return c.json({ server_time: at, policy: buildPolicy(db, phone.id, at) });
    };
    if (policyVersion(db, phone.id) !== have) return answer();
    if (wait > 0 && (await deps.waiters.wait(phone.id, have, wait * 1000, c.req.raw.signal))) return answer();
    return c.body(null, 204);
  });

  app.post("/requests", limit(LIMITS.requestsBytes), async (c) => {
    const body = await readJson(c, RequestsRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const saved = saveRequests(db, phone.id, body.value.requests, now);
    for (const r of saved.created) {
      audit(db, now, { kind: "phone", deviceId: phone.id }, "request.made", { detail: { package: r.package, label: r.label } });
    }
    if (saved.created.length) notifyParents(deps, requestNotice(phone.name, saved.created.map((r) => r.label)));
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  app.all("*", () => fail(404, "not_found", "No such endpoint"));
  return app;
}
