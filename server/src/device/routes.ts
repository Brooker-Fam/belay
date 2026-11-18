/** The device API: what the agent on the phone calls (docs/protocol.md). No CORS, no cookies. */
import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { audit } from "../audit.js";
import { normalizeCode, sha256 } from "../crypto.js";
import type { Deps } from "../deps.js";
import { offeredFile } from "../family/agent.js";
import { saveCallRecords, withoutAlwaysAllowed } from "../family/calls/records.js";
import { markNotified, saveLocations } from "../family/location/fixes.js";
import { mobileDataCutoff, saveMobileDataDays } from "../family/mobiledata/store.js";
import { networkCutoff, privateDomainsOf, saveNetworkDays, withoutNeverKept } from "../family/network/store.js";
import { buildPolicy, changePolicy, neverBlockedOn, policyVersion } from "../family/policy.js";
import { receiveReport } from "../family/reports.js";
import { saveRequests, type SavedRequests } from "../family/requests.js";
import { recordAgreementAnswers } from "../family/screentime/changes.js";
import { phoneRow, phoneRules } from "../family/screentime/rules.js";
import { retentionCutoff, saveUsage } from "../family/screentime/usage.js";
import { bearerToken, checkJson, clientAddress, parseRange, readJson, readJsonBody, type Bindings } from "../http.js";
import { helpNotice, notifyParents, placeNotice, recoveryUsedNotice, requestsNotice, updateFailedNotice } from "../push.js";
import type { Verdict } from "../ratelimit.js";
import { getSettings } from "../settings.js";
import { formatDateTime, formatTime } from "../time.js";
import { applyEvents, applyInventory } from "./apps.js";
import { enroll } from "./enroll.js";
import {
  CallsRequest,
  CheckinRequest,
  EnrollRequest,
  EventsRequest,
  InventoryRequest,
  LIMITS,
  LocationsRequest,
  MobileDataRequest,
  NetworkRequest,
  PolicyQuery,
  RequestsRequest,
  UsageRequest,
  type Device,
} from "./schemas.js";

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
const isCalls = (method: string, path: string) => method === "POST" && path.endsWith("/calls");
const isNetwork = (method: string, path: string) => method === "POST" && path.endsWith("/network");

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
    const limiter = isPolicyPoll(c.req.method, c.req.path)
      ? limits.policyPerPhone
      : isDownload(c.req.path)
        ? limits.agentPerPhone
        : isCalls(c.req.method, c.req.path)
          ? limits.callsPerPhone
          : isNetwork(c.req.method, c.req.path)
            ? limits.networkPerPhone
            : limits.devicePerPhone;
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
    const phone = c.var.phone;
    saveFacts(phone, body.value.device, now);
    // App changes kept this hour, the phone's own and found in its lists: past that, a list still updates the apps.
    const result = applyInventory(db, phone.id, body.value, now, { budget: limits.appChangesPerPhone.remaining(phone.id) });
    if (result.backfilled) limits.appChangesPerPhone.hit(phone.id, result.backfilled);
    if (result.dropped) deps.log(`A phone's app list had ${result.dropped} more app change${result.dropped === 1 ? "" : "s"} than Belay keeps in an hour: the apps are up to date, the changes not kept.`);
    return c.json({ server_time: now, duplicate: result.duplicate, backfilled: result.backfilled });
  });

  /**
   * App events, applied in order. Past the hour's budget of new app changes (or for an app beyond
   * what a phone can have) an event is accepted but not kept, so the phone never holds back its
   * requests behind it: its next app list records what it changed, as found by snapshot.
   */
  app.post("/events", limit(LIMITS.eventsBytes), async (c) => {
    const body = await readJson(c, EventsRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const result = applyEvents(db, phone.id, body.value.events, now, { budget: limits.appChangesPerPhone.remaining(phone.id) });
    if (result.kept) limits.appChangesPerPhone.hit(phone.id, result.kept);
    const notKept = result.accepted - result.kept;
    if (notKept) deps.log(`A phone sent ${notKept} app change${notKept === 1 ? "" : "s"} past what Belay keeps: not kept (its next app list catches the apps up).`);
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
    const ctx = {
      db,
      now,
      changed: (id: string) => {
        deps.waiters.changed(id);
      },
    };
    const limitNames = new Map(phoneRules(db, phone.id).rules.limits.map((l) => [l.id, l.name]));
    const detail = (r: SavedRequests["created"][number]): Record<string, unknown> => {
      switch (r.kind) {
        case "app":
          return { package: r.package ?? undefined, label: r.label ?? undefined };
        case "more_time":
          return { kind: r.kind, limit: r.limitId === "*" ? "every limit" : (limitNames.get(r.limitId ?? "") ?? "a limit"), minutes: r.minutes, package: r.package ?? undefined };
        case "agreement":
          return { kind: r.kind, agreement_version: r.version, answer: r.answer };
        case "help":
          return { kind: r.kind, ...(r.shared ? { shared_location: true } : {}) };
        case "talk":
          return { kind: r.kind };
        case "contact":
          return { kind: r.kind, contact: r.contactName ?? undefined };
      }
    };
    const actor = { kind: "phone", deviceId: phone.id } as const;
    // New requests this hour, help aside: what's past the limit waits for the phone to send it again.
    const budget = limits.requestsPerPhone.remaining(phone.id);
    const save = (log: (action: string, detail?: Record<string, unknown>) => void): SavedRequests => {
      const s = saveRequests(db, phone.id, body.value.requests, now, { budget });
      for (const r of s.created) log("request.made", { ...detail(r), ...(r.again ? { again: true } : {}), ...(r.withdrawn ? { withdrawn: true } : {}) });
      for (const w of s.withdrawn) log("request.withdrawn", { kind: w.kind });
      return s;
    };
    // A request the kid withdraws leaves the policy's requests, so the phone gets a new version; a new
    // request doesn't need one (the phone has it).
    const saved = body.value.requests.some((r) => r.withdrawn_at != null)
      ? changePolicy(ctx, phone.id, actor, save).result
      : save((action, d) => {
          audit(db, now, actor, action, { detail: d });
        });
    if (saved.made) limits.requestsPerPhone.hit(phone.id, saved.made);
    // The kid's answers to the agreement: the policy's kid_agreed_at follows, in a new version.
    recordAgreementAnswers(ctx, phone.id, saved.agreement);
    // "I need help" is urgent: each one, at once, to every parent, apart from the other notices' limit.
    for (const h of saved.created.filter((r) => r.kind === "help")) {
      if (limits.helpNoticesPerPhone.hit(phone.id).ok) notifyParents(deps, helpNotice(phone.name, { reason: h.reason, shared: h.shared === true, withdrawn: h.withdrawn === true }));
    }
    for (const h of saved.helpUpdated) {
      if (limits.helpNoticesPerPhone.hit(phone.id).ok) notifyParents(deps, helpNotice(phone.name, { reason: h.reason, shared: h.shared, update: true }));
    }
    // A few notices an hour per phone at most: a burst of requests still shows on the parent page.
    // Asking again for what's already waiting isn't news, and nor is one withdrawn before it arrived.
    const fresh = saved.created.flatMap((r) => (r.kind !== "help" && !r.again && !r.withdrawn ? [{ ...r, kind: r.kind }] : []));
    if (fresh.length && limits.noticesPerPhone.hit(phone.id).ok) notifyParents(deps, requestsNotice(phone.name, fresh, (id) => limitNames.get(id) ?? null));
    if (saved.refused) return fail(429, "rate_limited", "Too many requests are waiting for a parent already", 3600);
    if (saved.limited) {
      const wait = limits.requestsPerPhone.check(phone.id);
      return fail(429, "rate_limited", "This phone made more new requests this hour than Belay takes: send the rest later", wait.ok ? 60 : wait.retryAfterSeconds);
    }
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 4: fixes and arrivals and departures, kept only as the phone's rules ask (family/location/
   * fixes.ts); the rest is dropped and still answered as accepted, so the phone stops sending it.
   * Idempotent by each item's id. A fix answering a check wakes the parent waiting on "Check now".
   * At most 600 new ones kept an hour per phone: past that, 429, and the phone sends them again.
   */
  app.post("/locations", limit(LIMITS.locationsBytes), async (c) => {
    const body = await readJson(c, LocationsRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    // New fixes and arrivals this hour: what's past the limit waits for the phone to send it again.
    const saved = saveLocations(db, phone.id, body.value, now, { budget: limits.locationsPerPhone.remaining(phone.id) });
    if (saved.stored) limits.locationsPerPhone.hit(phone.id, saved.stored);
    if (saved.stored > 0 || saved.answered.length > 0) deps.fixWaiters.arrived(phone.id);
    if (saved.dropped > 0) deps.log(`A phone sent ${saved.dropped} location item${saved.dropped === 1 ? "" : "s"} its rules didn't ask for: not kept.`);
    // Arrivals and departures a parent asked to hear about: at most one per place and direction each 10 minutes.
    const tz = getSettings(db).timezone;
    for (const e of saved.events) {
      if (!e.notify || !limits.placeNotices.hit(`${phone.id} ${e.placeId} ${e.kind}`).ok) continue;
      markNotified(db, phone.id, e.id, now);
      const late = now - e.at > 10 * 60_000 ? (now - e.at > 12 * 3_600_000 ? formatDateTime(e.at, tz) : formatTime(e.at, tz)) : null;
      notifyParents(deps, placeNotice(phone, e.placeName, e.kind, late));
    }
    if (saved.limited) {
      const wait = limits.locationsPerPhone.check(phone.id);
      return fail(429, "rate_limited", "This phone sent more new fixes this hour than Belay keeps: send the rest later", wait.ok ? 60 : wait.retryAfterSeconds);
    }
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 5: call records, kept only while the phone's rules record calls (family/calls/records.ts);
   * the rest is dropped and still answered as accepted, so the phone stops sending them. Idempotent
   * by each record's id. A record naming an emergency number, 988 or a private number is never
   * kept: it's taken out before the body is checked (911 isn't E.164), and the server's log says
   * only that it happened, never the number or the phone.
   */
  app.post("/calls", limit(LIMITS.callsBytes), async (c) => {
    const raw = await readJsonBody(c);
    if (!raw.ok) return fail(400, "invalid_request", raw.description);
    const { body, neverKept: taken } = withoutAlwaysAllowed(raw.value);
    const now = deps.now();
    const phone = c.var.phone;
    const empty = Array.isArray((body as { calls?: unknown }).calls) && (body as { calls: unknown[] }).calls.length === 0;
    const checked = empty && taken > 0 ? null : checkJson(CallsRequest, body);
    if (checked && !checked.ok) return fail(400, "invalid_request", checked.description);
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const saved = checked ? saveCallRecords(db, phone.id, checked.value.calls, now) : { accepted: 0, stored: 0, dropped: 0, neverKept: 0 };
    const neverKept = taken + saved.neverKept;
    if (neverKept > 0) {
      deps.log(`A phone sent ${neverKept === 1 ? "a call record" : `${neverKept} call records`} Belay never keeps (an emergency number, 988 or a private number): not kept. Belay on the phone shouldn't send them.`);
    }
    if (saved.dropped > 0) deps.log(`A phone sent ${saved.dropped} call record${saved.dropped === 1 ? "" : "s"} its rules didn't ask for: not kept.`);
    return c.json({ server_time: now, accepted: saved.accepted + taken });
  });

  /**
   * Phase 3, network logging: how many times each app looked up each domain, one local day per
   * entry (family/network/store.ts). Idempotent by day: a day sent again replaces the stored one.
   * Kept only while the phone's switch is on (a parent's choice); otherwise accepted, dropped and
   * counted, so the phone stops sending. The never-blocked apps' lookups are never kept, and nor
   * is an entry naming one of 988's websites or one of the phone's private websites: it's taken out
   * before the body is checked. For 988's, the server's log says only that it happened, never the
   * name or the phone; a private one goes without a word (a Belay from before private websites
   * sends them, and the log's time would say when). Rate limited per phone apart from its other calls.
   */
  app.post("/network", limit(LIMITS.networkBytes), async (c) => {
    const raw = await readJsonBody(c);
    if (!raw.ok) return fail(400, "invalid_request", raw.description);
    const phone = c.var.phone;
    const { body, crisis } = withoutNeverKept(raw.value, privateDomainsOf(db, phone.id));
    const checked = checkJson(NetworkRequest, body);
    if (!checked.ok) return fail(400, "invalid_request", checked.description);
    const now = deps.now();
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const never = neverBlockedOn(db, phone.id);
    const saved = saveNetworkDays(db, phone.id, checked.value.days, now, {
      keep: (pkg) => never(pkg) === null,
      oldest: networkCutoff(now, getSettings(db).networkDays),
    });
    if (crisis > 0) deps.log("A phone sent network activity naming 988's websites, which Belay never keeps: not kept. Belay on the phone shouldn't send it.");
    if (saved.dropped > 0) deps.log(`A phone sent ${saved.dropped} day${saved.dropped === 1 ? "" : "s"} of network activity its rules didn't ask for: not kept.`);
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 13: how much mobile data each app used, one local day per entry, with the day's Wi-Fi
   * total (family/mobiledata/store.ts). Idempotent by day: a day sent again replaces the stored one.
   * Kept only while the phone's switch is on (a parent's choice); otherwise accepted, dropped and
   * counted, so the phone stops sending. A never-blocked app's own line is never kept: its bytes go
   * with Android's own.
   */
  app.post("/mobile-data", limit(LIMITS.mobileDataBytes), async (c) => {
    const body = await readJson(c, MobileDataRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const never = neverBlockedOn(db, phone.id);
    const saved = saveMobileDataDays(db, phone.id, body.value.days, now, {
      never: (pkg) => never(pkg) !== null,
      oldest: mobileDataCutoff(now, getSettings(db).mobileDataDays),
    });
    if (saved.dropped > 0) deps.log(`A phone sent ${saved.dropped} day${saved.dropped === 1 ? "" : "s"} of mobile data use its rules didn't ask for: not kept.`);
    return c.json({ server_time: now, accepted: saved.accepted });
  });

  /**
   * Phase 3: what the phone counted, one local day per entry. Idempotent by (day, zone): a day
   * sent again replaces the stored one when its as_of is the same or newer. Kept only while the phone's
   * rules measure (a parent's choice); never-blocked apps' time is never kept, and nor is a day that
   * can't have been counted yet, one older than the family keeps, or a date in a fourth zone.
   */
  app.post("/usage", limit(LIMITS.usageBytes), async (c) => {
    const body = await readJson(c, UsageRequest);
    if (!body.ok) return fail(400, "invalid_request", body.description);
    const now = deps.now();
    const phone = c.var.phone;
    db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now, phone.id);
    const never = neverBlockedOn(db, phone.id);
    const saved = saveUsage(db, phone.id, body.value.days, now, {
      measure: phoneRow(db, phone.id).settings.measure,
      keep: (pkg) => never(pkg) === null,
      oldest: retentionCutoff(now, getSettings(db).usageMonths),
    });
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
