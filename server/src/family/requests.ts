/**
 * What the kid asks for, from Belay's screen (docs/protocol.md, POST /api/v1/requests), and
 * how the parent pages and MCP list it. Parents answer in family/policy.ts (answerRequest),
 * since an answer is part of the policy the phone gets.
 *
 * The reason is the kid's own words and the label is the app developer's: both are
 * untrusted. They're stored as sent, less control and direction-changing characters.
 */
import type { DB } from "../db.js";
import type { Request } from "../device/schemas.js";
import { cleanText } from "../text.js";
import { REQUEST_WINDOW_MS } from "./policy.js";

export type RequestStatus = "pending" | "approved" | "declined" | "talk";
/** As stored: "superseded" when a newer request for the same app took its place. Lists leave those out. */
export type StoredRequestStatus = RequestStatus | "superseded";

export interface RequestView {
  deviceId: string;
  deviceName: string;
  id: string;
  kind: "app";
  package: string;
  label: string;
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

interface RequestRow {
  device_id: string;
  device_name: string;
  id: string;
  kind: "app";
  package: string;
  label: string;
  reason: string | null;
  asked_at: number;
  received_at: number;
  updated_at: number;
  status: StoredRequestStatus;
  note: string | null;
  answered_by_name: string | null;
  answered_at: number | null;
}

function toView(r: RequestRow): RequestView {
  return {
    deviceId: r.device_id,
    deviceName: r.device_name,
    id: r.id,
    kind: r.kind,
    package: r.package,
    label: r.label,
    reason: r.reason,
    askedAt: r.asked_at,
    receivedAt: r.received_at,
    updatedAt: r.updated_at,
    status: r.status,
    note: r.note,
    answeredBy: r.answered_by_name,
    answeredAt: r.answered_at,
  };
}

export interface SavedRequests {
  /** Every request the server now has from this call, new or not: the phone can stop sending them. */
  accepted: number;
  /** The ones that are new; `again` when one for the same app was waiting already, and this one took its place. */
  created: { id: string; package: string; label: string; again: boolean }[];
  /** New ones not kept, because the phone already has MAX_PENDING_REQUESTS waiting. */
  refused: number;
}

/** A phone can't have more than this many requests waiting for a parent, one per app: a flood is refused. */
export const MAX_PENDING_REQUESTS = 200;

/**
 * Saves the kid's requests. Idempotent by id: sending one again updates its reason while it's
 * still pending (a resend without a reason keeps the one there is), and changes nothing else.
 * A new request for an app that has one waiting takes its place (the phone asks again after
 * an app is installed again): the old one is "superseded", leaves the policy's answers, and
 * stops counting, so the limit counts apps.
 */
export function saveRequests(db: DB, deviceId: string, requests: Request[], now: number): SavedRequests {
  return db.transaction((): SavedRequests => {
    const created: SavedRequests["created"] = [];
    let refused = 0;
    let pending = pendingRequestCount(db, deviceId);
    const find = db.prepare<[string, string], { status: StoredRequestStatus; reason: string | null }>("SELECT status, reason FROM requests WHERE device_id = ? AND id = ?");
    const waiting = db.prepare<[string, string], { id: string; reason: string | null }>(
      "SELECT id, reason FROM requests WHERE device_id = ? AND package = ? AND status = 'pending' ORDER BY received_at DESC, rowid DESC",
    );
    for (const r of requests) {
      const reason = r.reason ? cleanText(r.reason, 500) || null : null;
      const existing = find.get(deviceId, r.id);
      const older = existing ? [] : waiting.all(deviceId, r.package);
      if (!existing && !older.length && pending >= MAX_PENDING_REQUESTS) {
        refused++;
      } else if (!existing) {
        if (older.length) {
          db.prepare("UPDATE requests SET status = 'superseded', superseded_by = ? WHERE device_id = ? AND package = ? AND status = 'pending'").run(r.id, deviceId, r.package);
          pending -= older.length;
        }
        pending++;
        const label = cleanText(r.label, 200) || r.package;
        // The kid's words from the request it replaces stay with it, until they write new ones.
        const words = reason ?? older.find((o) => o.reason !== null)?.reason ?? null;
        db.prepare(
          `INSERT INTO requests (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(deviceId, r.id, r.kind, r.package, label, words, r.asked_at, now, now);
        created.push({ id: r.id, package: r.package, label, again: older.length > 0 });
      } else if (existing.status === "pending" && reason !== null && reason !== existing.reason) {
        db.prepare("UPDATE requests SET reason = ?, updated_at = ? WHERE device_id = ? AND id = ?").run(reason, now, deviceId, r.id);
      }
    }
    return { accepted: requests.length - refused, created, refused };
  })();
}

const SELECT = `SELECT r.device_id, d.name AS device_name, r.id, r.kind, r.package, r.label, r.reason, r.asked_at, r.received_at, r.updated_at,
    r.status, r.note, p.name AS answered_by_name, r.answered_at
  FROM requests r JOIN devices d ON d.id = r.device_id LEFT JOIN parents p ON p.id = r.answered_by`;

export interface RequestFilter {
  deviceId?: string;
  package?: string;
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
    where.push("r.package = ?");
    args.push(filter.package);
  }
  if (filter.status) {
    where.push("r.status = ?");
    args.push(filter.status);
  } else {
    // Replaced by a newer request for the same app: that one is listed instead.
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

/** The kid's requests of the last 30 days and any still pending, as the policy covers them. */
export function recentRequests(db: DB, now: number, filter: Omit<RequestFilter, "recentSince"> = {}): RequestView[] {
  return listRequests(db, { ...filter, recentSince: now - REQUEST_WINDOW_MS });
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
