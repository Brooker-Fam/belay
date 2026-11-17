/**
 * What the kid asks for, from Belay's screen (docs/protocol.md, POST /api/v1/requests), and
 * how the parent pages and MCP list it. Parents answer in family/policy.ts (answerRequest),
 * since an answer is part of the policy the phone gets.
 *
 * Five kinds: an app (a new one waiting, or a blocked one), more time for a limit today
 * (Phase 3), the kid's answer to the family agreement (Phase 3), "I need help" (Phase 7: urgent,
 * maybe with where the phone was, if the kid chose to share it) and "Talk to my parent" (Phase 7).
 * A help request isn't answered: a parent marks it seen (family/kidside-changes.ts), and until then
 * it stays at the top. Any pending request can be withdrawn by the kid (sent again with
 * `withdrawn_at`); an answered one can't. The reason is the kid's own words and the label is the
 * app developer's: both are untrusted. They're stored as sent, less control and direction-changing
 * characters.
 */
import type { DB } from "../db.js";
import type { Request } from "../device/schemas.js";
import { cleanText } from "../text.js";
import { type FixView, FIX_COLUMNS, type FixRow, insertFix, toFix } from "./location/store.js";
import { REQUEST_WINDOW_MS } from "./policy.js";

export type RequestStatus = "pending" | "approved" | "declined" | "talk";
/** As stored: "superseded" when a newer request took its place; "withdrawn" when the kid withdrew it. Lists leave superseded ones out. */
export type StoredRequestStatus = RequestStatus | "superseded" | "withdrawn";
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
  /** When the kid withdrew it (the phone's clock), for "withdrawn". */
  withdrawnAt: number | null;
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
export type HelpView = RequestBase & {
  kind: "help";
  /** When a parent saw it, and who (null with seenAt: the server's CLI, or a parent since removed). */
  seenAt: number | null;
  seenBy: string | null;
  /** Where the phone was, when the kid chose to share it. */
  fix: FixView | null;
};
export type TalkView = RequestBase & { kind: "talk" };
export type RequestView = AppRequestView | MoreTimeView | AgreementAnswerView | HelpView | TalkView;

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
  withdrawn_at: number | null;
  seen_at: number | null;
  seen_by_name: string | null;
}

function toView(db: DB, r: RequestRow): RequestView {
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
    withdrawnAt: r.withdrawn_at,
  };
  switch (r.kind) {
    case "more_time":
      return { ...base, kind: "more_time", limitId: r.limit_id ?? "*", minutes: r.minutes ?? 0, package: r.package, label: r.app_label, givenMinutes: r.given_minutes };
    case "agreement":
      return { ...base, kind: "agreement", version: r.agreement_version ?? 0, answer: r.agreement_answer ?? "talk" };
    case "help":
      return { ...base, kind: "help", seenAt: r.seen_at, seenBy: r.seen_by_name, fix: helpFix(db, r.device_id, r.id) };
    case "talk":
      return { ...base, kind: "talk" };
    case "app":
      return { ...base, kind: "app", package: r.package ?? "", label: r.label ?? r.package ?? "" };
  }
}

/** The fix the kid shared with a help request, if they did. */
function helpFix(db: DB, deviceId: string, requestId: string): FixView | null {
  const row = db
    .prepare<[string, string], FixRow>(`SELECT ${FIX_COLUMNS} FROM fixes WHERE device_id = ? AND request_id = ? ORDER BY at DESC, rowid DESC LIMIT 1`)
    .get(deviceId, requestId);
  return row ? toFix(row) : null;
}

/** A help request that the parents haven't seen yet: it stays at the top, withdrawn or not. */
export const needsHelp = (r: RequestView): r is HelpView => r.kind === "help" && r.seenAt === null && (r.status === "pending" || r.status === "withdrawn");

/** In SQL, for `r`: a help request no parent has seen yet. */
const UNSEEN_HELP = "(r.kind = 'help' AND r.seen_at IS NULL AND r.status IN ('pending', 'withdrawn'))";

export interface SavedRequests {
  /** Every request the server now has from this call, new or not: the phone can stop sending them. */
  accepted: number;
  /**
   * The ones that are new; `again` when one for the same app (or the same limit, or the
   * agreement) was waiting already, and this one took its place; `withdrawn` when it arrived
   * already withdrawn.
   */
  created: {
    id: string;
    kind: RequestKind;
    package: string | null;
    label: string | null;
    again: boolean;
    limitId?: string;
    minutes?: number;
    reason: string | null;
    answer?: "agree" | "talk";
    version?: number;
    withdrawn?: boolean;
    /** help: whether the kid shared where the phone was. */
    shared?: boolean;
  }[];
  /** Pending requests the kid withdrew in this call. */
  withdrawn: { id: string; kind: RequestKind }[];
  /** Help requests not seen yet that the kid added words or where the phone was to, in this call: the parents hear again. */
  helpUpdated: { id: string; reason: string | null; shared: boolean }[];
  /** The kid's answers to the agreement in this call, for the agreement's version (family/screentime/changes.ts). */
  agreement: { version: number; answer: "agree" | "talk"; at: number }[];
  /** New ones not kept, because the phone already has too many waiting. */
  refused: number;
}

/** A phone can't have more than this many requests for apps waiting for a parent, one per app: a flood is refused. */
export const MAX_PENDING_REQUESTS = 200;
/** Nor more than this many "more time" requests waiting: one per limit, and there are at most 50 limits and "*". */
export const MAX_PENDING_MORE_TIME = 60;
/** Nor more than this many help requests that no parent has seen, or talk requests waiting: each is its own. */
export const MAX_UNSEEN_HELP = 100;
export const MAX_PENDING_TALK = 60;

/**
 * Saves the kid's requests. Idempotent by id: sending one again updates its reason while it's
 * still pending, and a help request's shared fix the same way (a resend without either keeps the
 * one there is), and changes nothing else; sent again with `withdrawn_at`, a pending one is
 * withdrawn (an answered one stays as it is). A new request that asks what a waiting one asks
 * takes its place: for the same app (the phone asks again after an app is installed again), for
 * the same limit, or about the agreement. The old one is "superseded", leaves the policy's
 * answers, and stops counting, so the limits count apps and limits. Help and talk requests never
 * take another's place: each is its own. The kid's "I agree" needs no parent: it's recorded as
 * answered at once, and a parent sees it on the Requests page; "I want to talk about it" waits for
 * a parent.
 */
export function saveRequests(db: DB, deviceId: string, requests: Request[], now: number): SavedRequests {
  return db.transaction((): SavedRequests => {
    const created: SavedRequests["created"] = [];
    const withdrawn: SavedRequests["withdrawn"] = [];
    const helpUpdated: SavedRequests["helpUpdated"] = [];
    const agreement: SavedRequests["agreement"] = [];
    let refused = 0;
    const pendingOf = db.prepare<[string, RequestKind], { n: number }>("SELECT COUNT(*) AS n FROM requests WHERE device_id = ? AND kind = ? AND status = 'pending'");
    const unseenHelp = db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM requests r WHERE r.device_id = ? AND ${UNSEEN_HELP}`);
    const pending: Record<RequestKind, number> = {
      app: pendingOf.get(deviceId, "app")?.n ?? 0,
      more_time: pendingOf.get(deviceId, "more_time")?.n ?? 0,
      agreement: pendingOf.get(deviceId, "agreement")?.n ?? 0,
      help: unseenHelp.get(deviceId)?.n ?? 0,
      talk: pendingOf.get(deviceId, "talk")?.n ?? 0,
    };
    const cap: Record<RequestKind, number> = {
      app: MAX_PENDING_REQUESTS,
      more_time: MAX_PENDING_MORE_TIME,
      agreement: MAX_PENDING_REQUESTS,
      help: MAX_UNSEEN_HELP,
      talk: MAX_PENDING_TALK,
    };
    const find = db.prepare<[string, string], { status: StoredRequestStatus; reason: string | null; kind: RequestKind; seen_at: number | null }>(
      "SELECT status, reason, kind, seen_at FROM requests WHERE device_id = ? AND id = ?",
    );
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
    const linked = db.prepare<[string, string, string], { n: number }>("SELECT COUNT(*) AS n FROM fixes WHERE device_id = ? AND id = ? AND request_id = ?");
    /**
     * A help request's shared fix, kept with the request (and linked if the phone sent the same fix
     * by itself). Sent again with another, the newer takes its place, as a new reason does; the
     * same one again changes nothing. Whether the request has a new fix now.
     */
    const shareFix = (requestId: string, r: Request): boolean => {
      if (r.kind !== "help" || !r.location) return false;
      const fixId = r.location.id;
      if ((linked.get(deviceId, fixId, requestId)?.n ?? 0) > 0) return false;
      insertFix(db, deviceId, r.location, now, { reason: "help", commandId: null, requestId });
      db.prepare("UPDATE fixes SET request_id = ? WHERE device_id = ? AND id = ? AND reason = 'help' AND request_id IS NULL").run(requestId, deviceId, fixId);
      // Only once the newer one is the request's: a fix id the phone used for something else never takes its place.
      if ((linked.get(deviceId, fixId, requestId)?.n ?? 0) === 0) return false;
      db.prepare("DELETE FROM fixes WHERE device_id = ? AND request_id = ? AND id != ?").run(deviceId, requestId, fixId);
      return true;
    };
    for (const r of requests) {
      const reason = r.reason ? cleanText(r.reason, 500) || null : null;
      const existing = find.get(deviceId, r.id);
      if (existing) {
        if (existing.kind !== r.kind || existing.status !== "pending") continue;
        if (r.withdrawn_at != null) {
          // Withdrawn while it waited: it leaves the policy's requests. An unseen help request stays at the top for the parents.
          db.prepare("UPDATE requests SET status = 'withdrawn', withdrawn_at = ?, updated_at = ? WHERE device_id = ? AND id = ?").run(r.withdrawn_at, now, deviceId, r.id);
          pending[r.kind] -= r.kind === "help" ? 0 : 1;
          withdrawn.push({ id: r.id, kind: r.kind });
          continue;
        }
        // The same id: only a waiting request's reason changes, and a help request may gain the fix the kid shares.
        const newWords = reason !== null && reason !== existing.reason;
        if (newWords) db.prepare("UPDATE requests SET reason = ?, updated_at = ? WHERE device_id = ? AND id = ?").run(reason, now, deviceId, r.id);
        const shared = shareFix(r.id, r);
        if (r.kind === "help" && existing.seen_at === null && (newWords || shared)) helpUpdated.push({ id: r.id, reason: newWords ? reason : existing.reason, shared });
        continue;
      }
      const at = Math.min(r.asked_at, now);
      if (r.withdrawn_at != null) {
        // Made and withdrawn before it reached the server: kept, as withdrawn, so the parents can see it; it takes no one's place.
        insertNew(db, deviceId, r, reason, now, { status: "withdrawn", withdrawnAt: r.withdrawn_at });
        const shared = shareFix(r.id, r);
        created.push({ id: r.id, kind: r.kind, package: "package" in r ? (r.package ?? null) : null, label: r.kind === "app" ? cleanText(r.label, 200) || r.package : null, again: false, reason, withdrawn: true, shared });
        continue;
      }
      const older =
        r.kind === "app"
          ? waiting.app.all(deviceId, r.package)
          : r.kind === "more_time"
            ? waiting.more_time.all(deviceId, r.limit_id)
            : r.kind === "agreement"
              ? waiting.agreement.all(deviceId)
              : [];
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
      insertNew(db, deviceId, r, words, now, { status: r.kind === "agreement" && r.answer === "agree" ? "approved" : "pending" });
      if (r.kind === "app") {
        created.push({ id: r.id, kind: "app", package: r.package, label: cleanText(r.label, 200) || r.package, again: older.length > 0, reason: words });
      } else if (r.kind === "more_time") {
        created.push({ id: r.id, kind: "more_time", package: r.package ?? null, label: null, again: older.length > 0, limitId: r.limit_id, minutes: r.minutes, reason: words });
      } else if (r.kind === "agreement") {
        created.push({ id: r.id, kind: "agreement", package: null, label: null, again: older.length > 0, answer: r.answer, version: r.version, reason: words });
        agreement.push({ version: r.version, answer: r.answer, at });
      } else if (r.kind === "help") {
        created.push({ id: r.id, kind: "help", package: null, label: null, again: false, reason: words, shared: shareFix(r.id, r) });
      } else {
        created.push({ id: r.id, kind: "talk", package: null, label: null, again: false, reason: words });
      }
    }
    return { accepted: requests.length - refused, created, withdrawn, helpUpdated, agreement, refused };
  })();
}

/** One new request's row. "I agree" is answered as it arrives: nothing waits for a parent. */
function insertNew(db: DB, deviceId: string, r: Request, reason: string | null, now: number, opts: { status: StoredRequestStatus; withdrawnAt?: number }): void {
  const answeredAt = opts.status === "approved" ? now : null;
  const row = {
    device_id: deviceId,
    id: r.id,
    kind: r.kind,
    package: r.kind === "app" || r.kind === "more_time" ? (r.package ?? null) : null,
    label: r.kind === "app" ? cleanText(r.label, 200) || r.package : null,
    reason,
    limit_id: r.kind === "more_time" ? r.limit_id : null,
    minutes: r.kind === "more_time" ? r.minutes : null,
    agreement_version: r.kind === "agreement" ? r.version : null,
    agreement_answer: r.kind === "agreement" ? r.answer : null,
    asked_at: r.asked_at,
    now,
    status: opts.status,
    answered_at: answeredAt,
    withdrawn_at: opts.withdrawnAt ?? null,
  };
  db.prepare(
    `INSERT INTO requests (device_id, id, kind, package, label, reason, limit_id, minutes, agreement_version, agreement_answer, asked_at, received_at, updated_at, status, answered_at, withdrawn_at)
     VALUES (@device_id, @id, @kind, @package, @label, @reason, @limit_id, @minutes, @agreement_version, @agreement_answer, @asked_at, @now, @now, @status, @answered_at, @withdrawn_at)`,
  ).run(row);
}

const SELECT = `SELECT r.device_id, d.name AS device_name, r.id, r.kind, r.package, r.label,
    COALESCE(r.label, (SELECT a.label FROM apps a WHERE a.device_id = r.device_id AND a.package = r.package)) AS app_label,
    r.reason, r.limit_id, r.minutes, r.given_minutes, r.agreement_version, r.agreement_answer, r.asked_at, r.received_at, r.updated_at,
    r.status, r.note, p.name AS answered_by_name, r.answered_at, r.withdrawn_at, r.seen_at, s.name AS seen_by_name
  FROM requests r JOIN devices d ON d.id = r.device_id LEFT JOIN parents p ON p.id = r.answered_by LEFT JOIN parents s ON s.id = r.seen_by`;

export interface RequestFilter {
  deviceId?: string;
  /** Only app requests for this app. */
  package?: string;
  kind?: RequestKind;
  status?: StoredRequestStatus;
  /** Only those still pending (or help no parent has seen), or received or answered since then. */
  recentSince?: number;
  limit?: number;
}

/** Help no parent has seen first, then pending, then newest first. */
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
    where.push(`(r.status = 'pending' OR ${UNSEEN_HELP} OR r.received_at >= ? OR r.answered_at >= ? OR r.seen_at >= ?)`);
    args.push(filter.recentSince, filter.recentSince, filter.recentSince);
  }
  return db
    .prepare<(string | number)[], RequestRow>(
      `${SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY ${UNSEEN_HELP} DESC, r.status = 'pending' DESC, r.received_at DESC, r.rowid DESC LIMIT ?`,
    )
    .all(...args, filter.limit ?? 200)
    .map((row) => toView(db, row));
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

/** Help requests no parent has seen yet, on every phone or one, newest first. */
export function unseenHelp(db: DB, deviceId?: string): HelpView[] {
  return db
    .prepare<(string | number)[], RequestRow>(`${SELECT} WHERE ${UNSEEN_HELP} ${deviceId ? "AND r.device_id = ?" : ""} ORDER BY r.received_at DESC, r.rowid DESC LIMIT 100`)
    .all(...(deviceId ? [deviceId] : []))
    .map((row) => toView(db, row))
    .filter(needsHelp);
}

export function getRequest(db: DB, deviceId: string, id: string): RequestView | null {
  const row = db.prepare<[string, string], RequestRow>(`${SELECT} WHERE r.device_id = ? AND r.id = ?`).get(deviceId, id);
  return row ? toView(db, row) : null;
}

/** Requests waiting for a parent, on every phone or one: pending ones, and help no parent has seen. */
export function pendingRequestCount(db: DB, deviceId?: string): number {
  const waiting = `(r.status = 'pending' OR ${UNSEEN_HELP})`;
  const row = deviceId
    ? db.prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM requests r WHERE ${waiting} AND r.device_id = ?`).get(deviceId)
    : db.prepare<[], { n: number }>(`SELECT COUNT(*) AS n FROM requests r WHERE ${waiting}`).get();
  return row?.n ?? 0;
}

export const STATUS_WORDS: Record<StoredRequestStatus, string> = {
  pending: "Waiting for you",
  approved: "Approved",
  declined: "Declined",
  talk: "Let's talk",
  superseded: "Asked again",
  withdrawn: "Withdrawn",
};

/** A help request's state, in words, for the parent pages. */
export function helpWords(r: HelpView): string {
  if (r.seenAt !== null) return "Seen";
  return r.status === "withdrawn" ? "Withdrawn, not seen yet" : "Not seen yet";
}
