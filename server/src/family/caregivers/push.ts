/**
 * Phase 12: notices to a caregiver's own browsers (Web Push, end-to-end encrypted, as a parent's:
 * push.ts). Only one kind goes to them: the kid's "I need help", from a phone their access covers,
 * while it lasts, if a parent let them get it. Their browsers are kept apart from the parents'
 * (`caregiver_push`, never `push_subscriptions`), so no parent's notice can reach a caregiver, and
 * they go when access ends.
 */
import { newId } from "../../crypto.js";
import type { DB } from "../../db.js";
import type { Deps } from "../../deps.js";
import { type Notice, type SendResult, type SubscriptionInput, pushTo } from "../../push.js";
import { helpCaregivers } from "./store.js";

export interface CareBrowser {
  id: string;
  caregiverId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  /** "Safari on iPhone". */
  name: string;
  createdAt: number;
  lastSentAt: number | null;
}

interface Row {
  id: string;
  caregiver_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  created_at: number;
  last_sent_at: number | null;
}

const toBrowser = (r: Row): CareBrowser => ({
  id: r.id,
  caregiverId: r.caregiver_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  name: r.name,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
});

/** A caregiver keeps at most this many browsers: their newest. */
const MAX_PER_CAREGIVER = 5;

/** Saves a browser for a caregiver (once per endpoint), keeping their newest 5. The caller checked it (push.ts's subscriptionProblem). */
export function saveCareSubscription(db: DB, now: number, caregiverId: string, input: SubscriptionInput, name: string): CareBrowser {
  return db.transaction(() => {
    db.prepare("DELETE FROM caregiver_push WHERE endpoint = ?").run(input.endpoint);
    const id = newId();
    db.prepare("INSERT INTO caregiver_push (id, caregiver_id, endpoint, p256dh, auth, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
      id,
      caregiverId,
      input.endpoint,
      input.p256dh,
      input.auth,
      name,
      now,
    );
    db.prepare(
      `DELETE FROM caregiver_push WHERE caregiver_id = ? AND id NOT IN
         (SELECT id FROM caregiver_push WHERE caregiver_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(caregiverId, caregiverId, MAX_PER_CAREGIVER);
    const row = db.prepare<[string], Row>("SELECT * FROM caregiver_push WHERE id = ?").get(id);
    if (!row) throw new Error("subscription vanished");
    return toBrowser(row);
  }).immediate();
}

export function listCareSubscriptions(db: DB, caregiverId: string): CareBrowser[] {
  return db.prepare<[string], Row>("SELECT * FROM caregiver_push WHERE caregiver_id = ? ORDER BY created_at, rowid").all(caregiverId).map(toBrowser);
}

/** Removes one of a caregiver's browsers, by its endpoint. */
export function removeCareSubscription(db: DB, caregiverId: string, endpoint: string): CareBrowser | null {
  const row = db.prepare<[string, string], Row>("SELECT * FROM caregiver_push WHERE endpoint = ? AND caregiver_id = ?").get(endpoint, caregiverId);
  if (!row) return null;
  db.prepare("DELETE FROM caregiver_push WHERE id = ?").run(row.id);
  return toBrowser(row);
}

/** Sends a notice to one caregiver's browsers. */
export function sendToCaregiver(deps: Deps, caregiverId: string, notice: Notice): Promise<SendResult> {
  return pushTo(deps, listCareSubscriptions(deps.db, caregiverId), notice, "caregiver_push");
}

/**
 * The kid's help request (push.ts's helpNotice), to every caregiver who gets this phone's help
 * requests now, without waiting: it opens their own page. Checked again at sending: access
 * current, the phone theirs, help on.
 *
 * Only to those whose help on this phone began by `askedAt`, when the kid asked (store.ts's
 * helpAskedAt): a request asked before, sent once the phone came online, or words the kid added
 * later to one, never go to a caregiver whose name the kid's Help screen didn't show then.
 */
export function notifyCaregivers(deps: Deps, deviceId: string, notice: Notice, askedAt: number): void {
  const browsers = helpCaregivers(deps.db, deviceId, deps.now(), askedAt).flatMap((c) => listCareSubscriptions(deps.db, c.id));
  if (!browsers.length) return;
  void pushTo(deps, browsers, { ...notice, url: "/care#help" }, "caregiver_push").catch((error: unknown) => {
    deps.log(`Notices to caregivers didn't go out: ${error instanceof Error ? error.message : "error"}.`);
  });
}
