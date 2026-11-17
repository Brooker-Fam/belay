/**
 * What the kid asks for, from Belay's screen (docs/protocol.md, POST /api/v1/requests), and
 * how the parent pages and MCP list it. Parents answer in family/policy.ts (answerRequest),
 * since an answer is part of the policy the phone gets.
 *
 * Three kinds: an app (a new one waiting, or a blocked one), more time for a limit today
 * (Phase 3), and the kid's answer to the family agreement (Phase 3). The reason is the kid's own
 * words and the label is the app developer's: both are untrusted. They're stored as sent, less
 * control and direction-changing characters.
 */
import type { DB } from "../db.js";
import type { Request } from "../device/schemas.js";
import { cleanText } from "../text.js";
import { REQUEST_WINDOW_MS } from "./policy.js";

export type RequestStatus = "pending" | "approved" | "declined" | "talk";
/** As stored: "superseded" when a newer request took its place. Lists leave those out. */
export type StoredRequestStatus = RequestStatus | "superseded";
export type RequestKind = Request["kind"];

interface RequestBase {
  deviceId: string;
  deviceName: string;
  id: string;
  reason: string | null;
  /** The phone's clock. */
  askedAt: number;
  receivedAt: number;
  updatedAt: number;
  /** Lists never hold "superseded" ones; getRequest can. */
  status: StoredRequestStatus;
  note: string | null;
  answeredBy: string | null;
  answeredAt: number | null;
}

export type AppRequestView = RequestBase & { kind: "app"; package: string; label: string };
export type MoreTimeView = RequestBase & {
  kind: "more_time";
  /** The limit's id, or "*" for every limit. */
  limitId: string;
  /** What the kid asked for. */
  minutes: number;
  /** The app the kid was in, if the phone said, and its name on the phone (untrusted). */
  package: string | null;
  label: string | null;
  /** What a parent gave, when approved. */
  givenMinutes: number | null;
};
export type AgreementAnswerView = RequestBase & { kind: "agreement"; version: number; answer: "agree" | "talk" };
export type RequestView = AppRequestView | MoreTimeView | AgreementAnswerView;

interface RequestRow {
  device_id: string;
  device_name: string;
  id: string;
  kind: RequestKind;
  package: string | null;
  label: string | null;
  app_label: string | null;
  reason: string | null;
  limit_id: string | null;
  minutes: number | null;
  given_minutes: number | null;
  agreement_version: number | null;
  agreement_answer: "agree" | "talk" | null;
  asked_at: number;
  received_at: number;
  updated_at: number;
  status: StoredRequestStatus;
  note: string | null;
  answered_by_name: string | null;
  answered_at: number | null;
}

function toView(r: RequestRow): RequestView {
  const base: RequestBase = {
    deviceId: r.device_id,
    deviceName: r.device_name,
    id: r.id,
    reason: r.reason,
    askedAt: r.asked_at,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    status: r.status,
    note: r.note,
    answeredBy: r.answered_by_name,
    answeredAt: r.answered_at,
  };
  switch (r.kind) {
    case "more_time":
      return { ...base, kind: "more_time", limitId: r.limit_id ?? "*", minutes: r.minutes ?? 0, package: r.package, label: r.app_label, givenMinutes: r.given_minutes };
    case "agreement":
      return { ...base, kind: "agreement", version: r.agreement_version ?? 0, answer: r.agreement_answer ?? "talk" };
    case "app":
      return { ...base, kind: "app", package: r.package ?? "", label: r.label ?? r.package ?? "" };
  }
}

export interface SavedRequests {
  /** Every request the server now has from this call, new or not: the phone can stop sending them. */
  accepted: number;
  /**
   * The ones that are new; `again` when one for the same app (or the same limit, or the
   * agreement) was waiting already, and this one took its place.
   */
  created: { id: string; kind: RequestKind; package: string | null; label: string | null; again: boolean; limitId?: string; minutes?: number; reason: string | null; answer?: "agree" | "talk"; version?: number }[];
  /** The kid's answers to the agreement in this call, for the agreement's version (family/screentime/changes.ts). */
  agreement: { version: number; answer: "agree" | "talk"; at: number }[];
  /** New ones not kept, because the phone already has too many waiting. */
  refused: number;
}

/** A phone can't have more than this many requests for apps waiting for a parent, one per app: a flood is refused. */
export const MAX_PENDING_REQUESTS = 200;
/** Nor more than this many "more time" requests waiting: one per limit, and there are at most 50 limits and "*". */
export const MAX_PENDING_MORE_TIME = 60;

/**
 * Saves the kid's requests. Idempotent by id: sending one again updates its reason while it's
 * still pending (a resend without a reason keeps the one there is), and changes nothing else.
 * A new request that asks what a waiting one asks takes its place: for the same app (the phone
 * asks again after an app is installed again), for the same limit, or about the agreement. The
 * old one is "superseded", leaves the policy's answers, and stops counting, so the limits count
 * apps and limits. The kid's "I agree" needs no parent: it's recorded as answered at once, and a
 * parent sees it on the Requests page; "I want to talk about it" waits for a parent.
 */
export function saveRequests(db: DB, deviceId: string, requests: Request[], now: number): SavedRequests {
  return db.transaction((): SavedRequests => {
    const created: SavedRequests["created"] = [];
    const agreement: SavedRequests["agreement"] = [];
    let refused = 0;
    const pendingOf = db.prepare<[string, RequestKind], { n: number }>("SELECT COUNT(*) AS n FROM requests WHERE device_id = ? AND kind = ? AND status = 'pending'");
    const pending: Record<RequestKind, number> = {
      app: pendingOf.get(deviceId, "app")?.n ?? 0,
      more_time: pendingOf.get(deviceId, "more_time")?.n ?? 0,
      agreement: pendingOf.get(deviceId, "agreement")?.n ?? 0,
    };
    const cap: Record<RequestKind, number> = { app: MAX_PENDING_REQUESTS, more_time: MAX_PENDING_MORE_TIME, agreement: MAX_PENDING_REQUESTS };
    const find = db.prepare<[string, string], { status: StoredRequestStatus; reason: string | null; kind: RequestKind }>("SELECT status, reason, kind FROM requests WHERE device_id = ? AND id = ?");
    const waiting = {
      app: db.prepare<[string, string], { id: string; reason: string | null }>(
        "SELECT id, reason FROM requests WHERE device_id = ? AND kind = 'app' AND package = ? AND status = 'pending' ORDER BY received_at DESC, rowid DESC",
      ),
      more_time: db.prepare<[string, string], { id: string; reason: string | null }>(
        "SELECT id, reason FROM requests WHERE device_id = ? AND kind = 'more_time' AND limit_id = ? AND status = 'pending' ORDER BY received_at DESC, rowid DESC",
      ),
      agreement: db.prepare<[string], { id: string; reason: string | null }>(
        "SELECT id, reason FROM requests WHERE device_id = ? AND kind = 'agreement' AND status = 'pending' ORDER BY received_at DESC, rowid DESC",
      ),
    };
    const supersede = db.prepare("UPDATE requests SET status = 'superseded', superseded_by = ? WHERE device_id = ? AND id = ?");
    for (const r of requests) {
      const reason = r.reason ? cleanText(r.reason, 500) || null : null;
      const existing = find.get(deviceId, r.id);
      if (existing) {
        // The same id: only a waiting request's reason changes.
        if (existing.kind === r.kind && existing.status === "pending" && reason !== null && reason !== existing.reason) {
          db.prepare("UPDATE requests SET reason = ?, updated_at = ? WHERE device_id = ? AND id = ?").run(reason, now, deviceId, r.id);
        }
        continue;
      }
      const older =
        r.kind === "app" ? waiting.app.all(deviceId, r.package) : r.kind === "more_time" ? waiting.more_time.all(deviceId, r.limit_id) : waiting.agreement.all(deviceId);
      // "I agree" isn't waiting for anyone, so it never counts toward the cap.
      const waits = !(r.kind === "agreement" && r.answer === "agree");
      if (waits && !older.length && pending[r.kind] >= cap[r.kind]) {
        refused++;
        continue;
      }
      for (const o of older) supersede.run(r.id, deviceId, o.id);
      pending[r.kind] += (waits ? 1 : 0) - older.length;
      // The kid's words from the request it replaces stay with it, until they write new ones.
      const words = reason ?? (r.kind === "agreement" ? null : (older.find((o) => o.reason !== null)?.reason ?? null));
      const at = Math.min(r.asked_at, now);
      if (r.kind === "app") {
        const label = cleanText(r.label, 200) || r.package;
        db.prepare(
          `INSERT INTO requests (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status)
           VALUES (?, ?, 'app', ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(deviceId, r.id, r.package, label, words, r.asked_at, now, now);
        created.push({ id: r.id, kind: "app", package: r.package, label, again: older.length > 0, reason: words });
      } else if (r.kind === "more_time") {
        db.prepare(
          `INSERT INTO requests (device_id, id, kind, package, reason, limit_id, minutes, asked_at, received_at, updated_at, status)
           VALUES (?, ?, 'more_time', ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(deviceId, r.id, r.package ?? null, words, r.limit_id, r.minutes, r.asked_at, now, now);
        created.push({ id: r.id, kind: "more_time", package: r.package ?? null, label: null, again: older.length > 0, limitId: r.limit_id, minutes: r.minutes, reason: words });
      } else {
        // "I agree" is answered as it arrives: nothing waits for a parent.
        db.prepare(
          `INSERT INTO requests (device_id, id, kind, reason, agreement_version, agreement_answer, asked_at, received_at, updated_at, status, answered_at)
           VALUES (?, ?, 'agreement', ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(deviceId, r.id, words, r.version, r.answer, r.asked_at, now, now, r.answer === "agree" ? "approved" : "pending", r.answer === "agree" ? now : null);
        created.push({ id: r.id, kind: "agreement", package: null, label: null, again: older.length > 0, answer: r.answer, version: r.version, reason: words });
        agreement.push({ version: r.version, answer: r.answer, at });
      }
    }
    return { accepted: requests.length - refused, created, agreement, refused };
  })();
}

const SELECT = `SELECT r.device_id, d.name AS device_name, r.id, r.kind, r.package, r.label,
    COALESCE(r.label, (SELECT a.label FROM apps a WHERE a.device_id = r.device_id AND a.package = r.package)) AS app_label,
    r.reason, r.limit_id, r.minutes, r.given_minutes, r.agreement_version, r.agreement_answer, r.asked_at, r.received_at, r.updated_at,
    r.status, r.note, p.name AS answered_by_name, r.answered_at
  FROM requests r JOIN devices d ON d.id = r.device_id LEFT JOIN parents p ON p.id = r.answered_by`;

export interface RequestFilter {
  deviceId?: string;
  /** Only app requests for this app. */
  package?: string;
  kind?: RequestKind;
  status?: RequestStatus;
  /** Only those still pending, or received or answered since then. */
  recentSince?: number;
  limit?: number;
}

/** Pending first, then newest first. */
export function listRequests(db: DB, filter: RequestFilter = {}): RequestView[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (filter.deviceId) {
    where.push("r.device_id = ?");
    args.push(filter.deviceId);
  }
  if (filter.package) {
    where.push("r.kind = 'app' AND r.package = ?");
    args.push(filter.package);
  }
  if (filter.kind) {
    where.push("r.kind = ?");
    args.push(filter.kind);
  }
  if (filter.status) {
    where.push("r.status = ?");
    args.push(filter.status);
  } else {
    // Replaced by a newer request: that one is listed instead.
    where.push("r.status != 'superseded'");
  }
  if (filter.recentSince !== undefined) {
    where.push("(r.status = 'pending' OR r.received_at >= ? OR r.answered_at >= ?)");
    args.push(filter.recentSince, filter.recentSince);
  }
  return db
    .prepare<(string | number)[], RequestRow>(
      `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY r.status = 'pending' DESC, r.received_at DESC, r.rowid DESC LIMIT ?`,
    )
    .all(...args, filter.limit ?? 200)
    .map(toView);
}

const isApp = (r: RequestView): r is AppRequestView => r.kind === "app";

/** App requests only: for an app's page, and a phone's app list. */
export function listAppRequests(db: DB, filter: Omit<RequestFilter, "kind"> = {}): AppRequestView[] {
  return listRequests(db, { ...filter, kind: "app" }).filter(isApp);
}

/** The kid's requests of the last 30 days and any still pending, as the policy covers them. */
export function recentRequests(db: DB, now: number, filter: Omit<RequestFilter, "recentSince"> = {}): RequestView[] {
  return listRequests(db, { ...filter, recentSince: now - REQUEST_WINDOW_MS });
}

export function recentAppRequests(db: DB, now: number, filter: Omit<RequestFilter, "recentSince" | "kind"> = {}): AppRequestView[] {
  return recentRequests(db, now, { ...filter, kind: "app" }).filter(isApp);
}

export function getRequest(db: DB, deviceId: string, id: string): RequestView | null {
  const row = db.prepare<[string, string], RequestRow>(`${SELECT} WHERE r.device_id = ? AND r.id = ?`).get(deviceId, id);
  return row ? toView(row) : null;
}

/** Requests waiting for a parent, on every phone or one. */
export function pendingRequestCount(db: DB, deviceId?: string): number {
  const row = deviceId
    ? db.prepare<[string], { n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending' AND device_id = ?").get(deviceId)
    : db.prepare<[], { n: number }>("SELECT COUNT(*) AS n FROM requests WHERE status = 'pending'").get();
  return row?.n ?? 0;
}

export const STATUS_WORDS: Record<StoredRequestStatus, string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  talk: "Let's talk",
  superseded: "Asked again",
};
