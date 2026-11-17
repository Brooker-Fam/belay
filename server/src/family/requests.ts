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
import { REQUEST_WINDOW_MS } from "./policy.js";

export type RequestStatus = "pending" | "approved" | "declined" | "talk";

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
  status: RequestStatus;
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
  status: RequestStatus;
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

/** Removes control characters (except new lines) and the ones that reorder text. */
export function cleanText(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u{0}-\u{9}\u{b}-\u{1f}\u{7f}-\u{9f}\u{200b}-\u{200f}\u{202a}-\u{202e}\u{2066}-\u{2069}]/gu, "").trim().slice(0, max);
}

export interface SavedRequests {
  /** Every request the server now has from this call, new or not: the phone can stop sending them. */
  accepted: number;
  /** The ones that are new. */
  created: { id: string; package: string; label: string }[];
}

/**
 * Saves the kid's requests. Idempotent by id: sending one again updates its reason while it's
 * still pending (a resend without a reason keeps the one there is), and changes nothing else.
 */
export function saveRequests(db: DB, deviceId: string, requests: Request[], now: number): SavedRequests {
  return db.transaction((): SavedRequests => {
    const created: SavedRequests["created"] = [];
    const find = db.prepare<[string, string], { status: RequestStatus; reason: string | null }>("SELECT status, reason FROM requests WHERE device_id = ? AND id = ?");
    for (const r of requests) {
      const reason = r.reason ? cleanText(r.reason, 500) || null : null;
      const existing = find.get(deviceId, r.id);
      if (!existing) {
        const label = cleanText(r.label, 200) || r.package;
        db.prepare(
          `INSERT INTO requests (device_id, id, kind, package, label, reason, asked_at, received_at, updated_at, status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        ).run(deviceId, r.id, r.kind, r.package, label, reason, r.asked_at, now, now);
        created.push({ id: r.id, package: r.package, label });
      } else if (existing.status === "pending" && reason !== null && reason !== existing.reason) {
        db.prepare("UPDATE requests SET reason = ?, updated_at = ? WHERE device_id = ? AND id = ?").run(reason, now, deviceId, r.id);
      }
    }
    return { accepted: requests.length, created };
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

export const STATUS_WORDS: Record<RequestStatus, string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  talk: "Let's talk",
};
