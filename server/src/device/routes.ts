/** The device API: what the agent on the phone calls (docs/protocol.md). No CORS, no cookies. */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { audit } from "../audit.js";
import { normalizeCode, sha256 } from "../crypto.js";
import type { Deps } from "../deps.js";
import { offeredFile } from "../family/agent.js";
import { buildPolicy, neverBlockedOn, policyVersion } from "../family/policy.js";
import { receiveReport } from "../family/reports.js";
import { saveRequests } from "../family/requests.js";
import { recordAgreementAnswers } from "../family/screentime/changes.js";
import { phoneRow, phoneRules } from "../family/screentime/rules.js";
import { saveUsage } from "../family/screentime/usage.js";
import { bearerToken, clientAddress, parseRange, readJson, type Bindings } from "../http.js";
import { notifyParents, recoveryUsedNotice, requestsNotice, updateFailedNotice } from "../push.js";
import type { Verdict } from "../ratelimit.js";
import { applyEvents, applyInventory } from "./apps.js";
import { enroll } from "./enroll.js";
import { CheckinRequest, EnrollRequest, EventsRequest, InventoryRequest, LIMITS, PolicyQuery, RequestsRequest, UsageRequest, type Device } from "./schemas.js";

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
const isDownload = (path: string) => /\/agent\/[^/]*$/.test(path);

export function deviceRoutes(deps: Deps): Hono<DeviceEnv> {
  const { db, limits } = deps;
  const app = new Hono<DeviceEnv>();

  const saveFacts = (phone: PhoneRow, device: Device, now: number) => {
    const done = receiveReport(
      {
        db,
        now,
        changed: (id) => {
          deps.waiters.changed(id);
        },
      },
      phone.id,
      device,
    );
    // Once per update offered: the report's news, in the server's words.
    for (const tell of done.result.tell) notifyParents(deps, tell.kind === "update_failed" ? updateFailedNotice(phone, tell.version) : recoveryUsedNotice(phone));
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
    const limiter = isPolicyPoll(c.req.method, c.req.path) ? limits.policyPerPhone : isDownload(c.req.path) ? limits.agentPerPhone : limits.devicePerPhone;
    const verdict = limiter.hit(phone.id);
    if (!verdict.ok) return fail(429, "rate_limited", "Too many requests", verdict.retryAfterSeconds);
    c.set("phone", phone);
    return next();
  });

  app.post("/checkin", limit(LIMITS.checkinBytes), async (c) => {
    const body = await readJson(c, CheckinRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    saveFacts(c.var.phone, body.value.status, now);
    db.prepare("UPDATE devices SET last_checkin_at = ? WHERE id = ?").run(now, c.var.phone.id);
    return c.json({ server_time: now, policy: buildPolicy(db, c.var.phone.id, now) });
  });

  app.post("/inventory", limit(LIMITS.inventoryBytes), async (c) => {
    const body = await readJson(c, InventoryRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    saveFacts(c.var.phone, body.value.device, now);
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
    // The kid's answers to the agreement: the policy's kid_agreed_at follows, in a new version.
    const ctx = {
      db,
      now,
      changed: (id: string) => {
        deps.waiters.changed(id);
      },
    };
    recordAgreementAnswers(ctx, phone.id, saved.agreement);
    const limitNames = new Map(phoneRules(db, phone.id).rules.limits.map((l) => [l.id, l.name]));
    for (const r of saved.created) {
      const detail =
        r.kind === "app"
          ? { package: r.package ?? undefined, label: r.label ?? undefined }
          : r.kind === "more_time"
            ? { kind: r.kind, limit: r.limitId === "*" ? "every limit" : (limitNames.get(r.limitId ?? "") ?? "a limit"), minutes: r.minutes, package: r.package ?? undefined }
            : { kind: r.kind, agreement_version: r.version, answer: r.answer };
      audit(db, now, { kind: "phone", deviceId: phone.id }, "request.made", { detail: { ...detail, ...(r.again ? { again: true } : {}) } });
    }
    // A few notices an hour per phone at most: a burst of requests still shows on the parent page.
    // Asking again for what's already waiting isn't news.
    const fresh = saved.created.filter((r) => !r.again);
    if (fresh.length && limits.noticesPerPhone.hit(phone.id).ok) notifyParents(deps, requestsNotice(phone.name, fresh, (id) => limitNames.get(id) ?? null));
    if (saved.refused) return fail(429, "rate_limited", "Too many requests are waiting for a parent already", 3600);
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 3: what the phone counted, one local day per entry. Idempotent by (day, zone): a day
   * sent again replaces the stored one when its as_of is the same or newer. Kept only while the phone's
   * rules measure (a parent's choice); never-blocked apps' time is never kept.
   */
  app.post("/usage", limit(LIMITS.usageBytes), async (c) => {
    const body = await readJson(c, UsageRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const never = neverBlockedOn(db, phone.id);
    const saved = saveUsage(db, phone.id, body.value.days, now, { measure: phoneRow(db, phone.id).settings.measure, keep: (pkg) => never(pkg) === null });
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 6: the version of Belay a parent offered this phone, streamed from the store, with
   * single byte ranges so a download over cellular can resume. Any other file is a 404, even one
   * the server has: only the one the policy offers this phone now.
   */
  app.get("/agent/:file", async (c) => {
    const sha256 = /^([0-9a-f]{64})\.apk$/.exec(c.req.param("file"))?.[1];
    const phone = c.var.phone;
    const now = deps.now();
    const file = sha256 ? await offeredFile(db, deps.config.agentsDir, phone.id, sha256) : null;
    if (!sha256 || !file) return fail(404, "not_found", "That isn't the version of Belay offered to this phone");
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const etag = `"${sha256}"`;
    const headers = new Headers({
      "content-type": "application/vnd.android.package-archive",
      "accept-ranges": "bytes",
      etag,
      "cache-control": "private, no-store",
    });
    // If-Range with another validator: the file changed, so send it all (it can't here: its name is its hash).
    const ifRange = c.req.header("if-range");
    const range = ifRange !== undefined && ifRange !== etag ? null : parseRange(c.req.header("range"), file.size);
    if (range === "unsatisfiable") {
      headers.set("content-range", `bytes */${file.size}`);
      headers.set("content-type", "application/json");
      return new Response(JSON.stringify({ error: "invalid_request", error_description: "That range isn't in the file" }), { status: 416, headers });
    }
    const { start, end } = range ?? { start: 0, end: file.size - 1 };
    headers.set("content-length", String(end - start + 1));
    if (range) headers.set("content-range", `bytes ${start}-${end}/${file.size}`);
    const status = range ? 206 : 200;
    if (c.req.method === "HEAD") return new Response(null, { status, headers });
    const body = Readable.toWeb(createReadStream(file.path, { start, end })) as ReadableStream<Uint8Array>;
    return new Response(body, { status, headers });
  });

  app.all("*", () => fail(404, "not_found", "No such endpoint"));
  return app;
}
