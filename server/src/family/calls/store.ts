/**
 * Phase 5: each phone's calls as the server keeps them (docs/protocol.md, "Calls rules"), and the
 * policy's `calls`, `contacts`, `private_numbers` and `blocked_numbers` built from them. Reads and
 * the lowest-level writes only: changes, with who may make them, are in changes.ts; what the
 * phone sends (POST /api/v1/calls) is in records.ts.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DB } from "../../db.js";
import type { Policy } from "../../device/schemas.js";

export type CallMode = "open" | "contacts";
export type CallAction = "reject" | "voicemail" | "ring";
export type Outgoing = "contacts" | "any";

/** What a parent chooses about calls, besides turning them on: the policy's `calls`. */
export interface CallRules {
  mode: CallMode;
  /** With mode `contacts`: callers who aren't contacts that may call. */
  unknown: CallAction;
  /** Callers with no caller id. */
  withheld: CallAction;
  outgoing: Outgoing;
  /** During Phase 3's bedtime and school schedules, only parents and always-allowed numbers ring. */
  quiet: boolean;
  /** The phone sends call records. A parent's choice alone, like turning calls on. */
  log: boolean;
}

/**
 * The rules a phone starts with when a parent first turns calls on: anyone may call and be called,
 * nothing recorded. Choosing "contacts only" sends others to voicemail unless a parent says else.
 */
export const DEFAULT_CALL_RULES: CallRules = { mode: "open", unknown: "voicemail", withheld: "voicemail", outgoing: "any", quiet: false, log: false };

export interface CallSettings extends CallRules {
  /** Belay is the phone app (the policy's `calls` is set). The rules are kept while it's off. */
  enabled: boolean;
  enabledAt: number | null;
  /** Call records the phone sent that weren't kept (not recording, or too many in a day). */
  dropped: number;
  droppedAt: number | null;
  changedAt: number;
}

interface SettingsRow {
  enabled: number;
  mode: CallMode;
  unknown: CallAction;
  withheld: CallAction;
  outgoing: Outgoing;
  quiet: number;
  log: number;
  enabled_at: number | null;
  dropped: number;
  dropped_at: number | null;
  changed_at: number;
}

/** The phone's call settings, or null when a parent never turned calls on. */
export function callSettings(db: DB, deviceId: string): CallSettings | null {
  const r = db.prepare<[string], SettingsRow>("SELECT * FROM call_settings WHERE device_id = ?").get(deviceId);
  if (!r) return null;
  return {
    enabled: r.enabled === 1,
    mode: r.mode,
    unknown: r.unknown,
    withheld: r.withheld,
    outgoing: r.outgoing,
    quiet: r.quiet === 1,
    log: r.log === 1,
    enabledAt: r.enabled_at,
    dropped: r.dropped,
    droppedAt: r.dropped_at,
    changedAt: r.changed_at,
  };
}

/** The rules alone, from settings (the defaults for a phone without any). */
export function rulesOf(s: CallSettings | null): CallRules {
  if (!s) return { ...DEFAULT_CALL_RULES };
  return { mode: s.mode, unknown: s.unknown, withheld: s.withheld, outgoing: s.outgoing, quiet: s.quiet, log: s.log };
}

/** Saves the rules and whether calls are on (the counts of dropped records are the phone's, kept as they are). */
export function saveCallSettings(db: DB, deviceId: string, s: CallRules & { enabled: boolean; enabledAt: number | null }, now: number): void {
  db.prepare(
    `INSERT INTO call_settings (device_id, enabled, mode, unknown, withheld, outgoing, quiet, log, enabled_at, changed_at)
     VALUES (@device_id, @enabled, @mode, @unknown, @withheld, @outgoing, @quiet, @log, @enabled_at, @now)
     ON CONFLICT (device_id) DO UPDATE SET enabled = excluded.enabled, mode = excluded.mode, unknown = excluded.unknown, withheld = excluded.withheld,
       outgoing = excluded.outgoing, quiet = excluded.quiet, log = excluded.log, enabled_at = excluded.enabled_at, changed_at = excluded.changed_at`,
  ).run({
    device_id: deviceId,
    enabled: s.enabled ? 1 : 0,
    mode: s.mode,
    unknown: s.unknown,
    withheld: s.withheld,
    outgoing: s.outgoing,
    quiet: s.quiet ? 1 : 0,
    log: s.log ? 1 : 0,
    enabled_at: s.enabledAt,
    now,
  });
}

// ── Contacts ─────────────────────────────────────────────────────────

/** What a contact is: what a parent edits, and what the policy sends (with its id). */
export interface ContactData {
  /** The family's words (or the kid's, from a request a parent approved), at most 60 characters. */
  name: string;
  /** E.164, 1 to 5, each one this contact's alone. */
  numbers: string[];
  calls: boolean;
  texts: boolean;
  /** Always rings, even at quiet times, and is on the kid's emergency card. */
  parent: boolean;
}

export interface Contact extends ContactData {
  id: string;
  /** The kid's request a parent approved to add it, if one did. */
  requestId: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ContactRow {
  id: string;
  name: string;
  calls: number;
  texts: number;
  parent: number;
  request_id: string | null;
  created_at: number;
  updated_at: number;
  numbers: string | null;
}

const CONTACT_SELECT = `SELECT c.id, c.name, c.calls, c.texts, c.parent, c.request_id, c.created_at, c.updated_at,
    (SELECT json_group_array(n.number ORDER BY n.position) FROM contact_numbers n WHERE n.device_id = c.device_id AND n.contact_id = c.id) AS numbers
  FROM contacts c`;

function toContact(r: ContactRow): Contact {
  let numbers: string[] = [];
  try {
    const parsed = JSON.parse(r.numbers ?? "[]") as unknown;
    if (Array.isArray(parsed)) numbers = parsed.filter((n): n is string => typeof n === "string");
  } catch {
    numbers = [];
  }
  return {
    id: r.id,
    name: r.name,
    numbers,
    calls: r.calls === 1,
    texts: r.texts === 1,
    parent: r.parent === 1,
    requestId: r.request_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/** The phone's contacts, by name. */
export function listContacts(db: DB, deviceId: string): Contact[] {
  return db.prepare<[string], ContactRow>(`${CONTACT_SELECT} WHERE c.device_id = ? ORDER BY c.name COLLATE NOCASE, c.created_at, c.id`).all(deviceId).map(toContact);
}

export function getContact(db: DB, deviceId: string, id: string): Contact | null {
  const row = db.prepare<[string, string], ContactRow>(`${CONTACT_SELECT} WHERE c.device_id = ? AND c.id = ?`).get(deviceId, id);
  return row ? toContact(row) : null;
}

/** The contact that has this number, if one does. */
export function contactWithNumber(db: DB, deviceId: string, number: string): Contact | null {
  const id = db.prepare<[string, string], { contact_id: string }>("SELECT contact_id FROM contact_numbers WHERE device_id = ? AND number = ?").get(deviceId, number)?.contact_id;
  return id === undefined ? null : getContact(db, deviceId, id);
}

/** A new contact's id: short, and a rule id the phone takes ("c-…"). */
export function newContactId(): string {
  return `c-${randomBytes(9).toString("base64url")}`;
}

/**
 * The id of a contact an AI app proposes adding: the same for the same phone, name and numbers, so
 * proposing the same contact again is the same proposal, not a second one.
 */
export function proposedContactId(deviceId: string, name: string, numbers: string[]): string {
  const key = `${deviceId}\n${name.trim().toLowerCase()}\n${[...numbers].sort().join(",")}`;
  return `c-${createHash("sha256").update(key).digest("base64url").slice(0, 12)}`;
}

/** Saves a contact as it is now (new or changed), its numbers in order. The caller has checked it. */
export function writeContact(db: DB, deviceId: string, id: string, data: ContactData, now: number, requestId: string | null = null): void {
  db.prepare(
    `INSERT INTO contacts (device_id, id, name, calls, texts, parent, request_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (device_id, id) DO UPDATE SET name = excluded.name, calls = excluded.calls, texts = excluded.texts, parent = excluded.parent, updated_at = excluded.updated_at`,
  ).run(deviceId, id, data.name, data.calls ? 1 : 0, data.texts ? 1 : 0, data.parent ? 1 : 0, requestId, now, now);
  db.prepare("DELETE FROM contact_numbers WHERE device_id = ? AND contact_id = ?").run(deviceId, id);
  const insert = db.prepare("INSERT INTO contact_numbers (device_id, contact_id, number, position) VALUES (?, ?, ?, ?)");
  data.numbers.forEach((number, position) => insert.run(deviceId, id, number, position));
}

export function deleteContact(db: DB, deviceId: string, id: string): boolean {
  return db.prepare("DELETE FROM contacts WHERE device_id = ? AND id = ?").run(deviceId, id).changes === 1;
}

/** A contact's data alone: what a change compares and the policy sends. */
export const dataOf = (c: ContactData): ContactData => ({ name: c.name, numbers: [...c.numbers], calls: c.calls, texts: c.texts, parent: c.parent });

// ── Private and blocked numbers ─────────────────────────────────────

export type NumberKind = "private" | "blocked";

export interface ListedNumber {
  number: string;
  addedAt: number;
  /** The parent who added it, or whose AI connection did; null: the server's CLI, or a parent since removed. */
  addedBy: string | null;
  /** The AI app that blocked it, if one did. */
  clientName: string | null;
}

/** The phone's private or blocked numbers, in order. */
export function listNumbers(db: DB, deviceId: string, kind: NumberKind): ListedNumber[] {
  return db
    .prepare<[string, NumberKind], { number: string; added_at: number; added_by: string | null; client_name: string | null }>(
      "SELECT n.number, n.added_at, p.name AS added_by, n.client_name FROM call_numbers n LEFT JOIN parents p ON p.id = n.added_by WHERE n.device_id = ? AND n.kind = ? ORDER BY n.number",
    )
    .all(deviceId, kind)
    .map((r) => ({ number: r.number, addedAt: r.added_at, addedBy: r.added_by, clientName: r.client_name }));
}

/** Just the numbers, in order: what the policy sends. */
export function numbersOf(db: DB, deviceId: string, kind: NumberKind): string[] {
  return db
    .prepare<[string, NumberKind], { number: string }>("SELECT number FROM call_numbers WHERE device_id = ? AND kind = ? ORDER BY number")
    .all(deviceId, kind)
    .map((r) => r.number);
}

export function hasNumber(db: DB, deviceId: string, kind: NumberKind, number: string): boolean {
  return !!db.prepare("SELECT 1 FROM call_numbers WHERE device_id = ? AND kind = ? AND number = ?").get(deviceId, kind, number);
}

export function insertNumber(db: DB, deviceId: string, kind: NumberKind, number: string, now: number, by: { parentId: string | null; clientName: string | null }): boolean {
  return (
    db
      .prepare("INSERT INTO call_numbers (device_id, kind, number, added_at, added_by, client_name) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (device_id, kind, number) DO NOTHING")
      .run(deviceId, kind, number, now, by.parentId, by.clientName).changes === 1
  );
}

export function deleteNumber(db: DB, deviceId: string, kind: NumberKind, number: string): boolean {
  return db.prepare("DELETE FROM call_numbers WHERE device_id = ? AND kind = ? AND number = ?").run(deviceId, kind, number).changes === 1;
}

// ── The policy ───────────────────────────────────────────────────────

/** The policy's `calls`: null until a parent turns calls on, and again once they turn them off. */
export function callsFor(db: DB, deviceId: string): Policy["calls"] {
  const s = callSettings(db, deviceId);
  if (!s?.enabled) return null;
  return { mode: s.mode, unknown: s.unknown, withheld: s.withheld, outgoing: s.outgoing, quiet: s.quiet, log: s.log };
}

/** The policy's `contacts`: every one, whether calls are on or not (`parent` ones are on the emergency card). */
export function contactsFor(db: DB, deviceId: string): Policy["contacts"] {
  return listContacts(db, deviceId).map((c) => ({ id: c.id, name: c.name, numbers: [...c.numbers], calls: c.calls, texts: c.texts, parent: c.parent }));
}
