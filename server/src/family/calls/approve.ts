/**
 * Phase 5: a parent approves the kid's "Please add this contact" (family/policy.ts, answerRequest,
 * in the same transaction as the answer). The name is the kid's words unless the parent wrote
 * their own; the number is the kid's, E.164; calls and texts are the parent's choice. A number
 * that's already a contact's adds no one: the request is approved and names that contact. A
 * blocked number is unblocked, as when a parent adds any contact. No AI app answers a request.
 */
import type { DB } from "../../db.js";
import { parentNumbersFor } from "../kidside.js";
import { classifyCallsChange } from "./classify.js";
import { type By, settle, sideOf, sideProblem, writeSide } from "./patch.js";
import { contactWithNumber, newContactId } from "./store.js";
import { callChangeSentence } from "./words.js";

export interface RequestedContact {
  requestId: string;
  name: string;
  number: string;
  calls: boolean;
  texts: boolean;
}

export interface ApprovedContact {
  contactId: string;
  name: string;
  /** The number was a contact's already: nothing was added. */
  existing: boolean;
  unblocked: string[];
  /** What changed, in words, for the activity log. */
  changes: string[];
}

/** Adds the contact the kid asked for, or says why not (in words, for the caller to refuse with). */
export function addRequestedContact(db: DB, deviceId: string, input: RequestedContact, now: number, by: By): ApprovedContact | { problem: string } {
  const existing = contactWithNumber(db, deviceId, input.number);
  if (existing) return { contactId: existing.id, name: existing.name, existing: true, unblocked: [], changes: [] };
  const current = sideOf(db, deviceId);
  const id = newContactId();
  const { side, unblocked } = settle(current, {
    ...current,
    contacts: [...current.contacts, { id, name: input.name, numbers: [input.number], calls: input.calls, texts: input.texts, parent: false }],
  });
  const problem = sideProblem(current, side, { emergencyCard: parentNumbersFor(db, deviceId).map((p) => p.number) });
  if (problem) return { problem };
  writeSide(db, deviceId, current, side, now, by, (contactId) => (contactId === id ? input.requestId : null));
  const name = side.contacts.find((c) => c.id === id)?.name ?? input.name;
  return { contactId: id, name, existing: false, unblocked, changes: classifyCallsChange(current, side).changes.map(callChangeSentence) };
}
