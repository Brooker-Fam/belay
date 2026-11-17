import type { DB } from "./db.js";

/** Who did something: a parent on the web, an AI client a parent connected, a phone, or the server. */
export type Actor =
  | { kind: "parent"; parentId: string }
  | { kind: "ai"; parentId: string; clientName: string }
  | { kind: "phone"; deviceId: string }
  | { kind: "server" };

export interface AuditEntry {
  id: number;
  at: number;
  actor: Actor["kind"];
  parentId: string | null;
  parentName: string | null;
  clientName: string | null;
  deviceId: string | null;
  deviceName: string | null;
  action: string;
  detail: Record<string, unknown> | null;
}

export function audit(
  db: DB,
  at: number,
  actor: Actor,
  action: string,
  extra: { deviceId?: string | null; detail?: Record<string, unknown> } = {},
): void {
  db.prepare(
    `INSERT INTO audit_log (at, actor, parent_id, client_name, device_id, action, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    at,
    actor.kind,
    actor.kind === "parent" || actor.kind === "ai" ? actor.parentId : null,
    actor.kind === "ai" ? actor.clientName : null,
    actor.kind === "phone" ? actor.deviceId : (extra.deviceId ?? null),
    action,
    extra.detail ? JSON.stringify(extra.detail) : null,
  );
}

interface Row {
  id: number;
  at: number;
  actor: Actor["kind"];
  parent_id: string | null;
  parent_name: string | null;
  client_name: string | null;
  device_id: string | null;
  device_name: string | null;
  action: string;
  detail: string | null;
}

export function listAudit(db: DB, opts: { before?: number; limit: number; includeReads: boolean }): AuditEntry[] {
  const rows = db
    .prepare<[number, number, number], Row>(
      `SELECT a.id, a.at, a.actor, a.parent_id, p.name AS parent_name, a.client_name, a.device_id, d.name AS device_name,
              a.action, a.detail
       FROM audit_log a
       LEFT JOIN parents p ON p.id = a.parent_id
       LEFT JOIN devices d ON d.id = a.device_id
       WHERE a.id < ? AND (? OR a.action NOT LIKE 'ai.read%')
       ORDER BY a.id DESC LIMIT ?`,
    )
    .all(opts.before ?? Number.MAX_SAFE_INTEGER, opts.includeReads ? 1 : 0, opts.limit);
  return rows.map((r) => ({
    id: r.id,
    at: r.at,
    actor: r.actor,
    parentId: r.parent_id,
    parentName: r.parent_name,
    clientName: r.client_name,
    deviceId: r.device_id,
    deviceName: r.device_name,
    action: r.action,
    detail: r.detail ? (JSON.parse(r.detail) as Record<string, unknown>) : null,
  }));
}
