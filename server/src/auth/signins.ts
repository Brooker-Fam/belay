/**
 * Every sign-in, told to every parent at once (the second bypass audit's B1). The kid's phone
 * shows the server's address and its browser reaches the parent pages, so a parent's password
 * seen over a shoulder and typed there loosens everything a parent can. Belay can't stop a correct
 * password, so it makes each use of one plain to every parent, as it happens. Each way a sign-in
 * makes a session goes through here: the sign-in page, the OAuth sign-in screen an AI app opens,
 * the first-run setup link, a parent's invite, and (Phase 12) a caregiver's sign-in and link.
 *
 * - The activity log gets the line, with the kind of browser it was on ("signed in on Chrome on
 *   Android", auth/browsers.ts: what the browser says it is).
 * - Every parent's browsers get a notice, urgent (Web Push's high urgency, so a phone in Doze gets
 *   it at once; it stays on the screen until they act on it): who, on what kind of browser, and
 *   when, and what to do if it wasn't them. A parent's own browsers get "If that wasn't you"; the
 *   other parents', "If that wasn't Sam". Each opens a page of its own (the sign-in's browser in
 *   Settings, or its line on the Activity page), so no later notice takes its place on the screen
 *   (sw.js keeps one per page).
 * - No limit holds one back, not the per-phone limits and not one of its own: making one takes a
 *   parent's (or caregiver's) password, a setup link or an invite, and a flood of them is itself
 *   the alarm. A push service that fails or is unreachable is logged, as for every notice; the
 *   activity log keeps the line either way.
 * - Never the client's address: not in the notice, not in the activity log, not in the session
 *   (docs/privacy.md). It's used for the sign-in limits only, in memory (http.ts).
 * - A caregiver's sign-in tells the parents too, on the same terms: their access can check where
 *   the phone is and read the kid's help requests, so a parent should know at once when it's used,
 *   by them or by anyone with their password; and they sign in rarely (a session lasts 7 days).
 * - A restore drill's scratch copy sends nothing (ops/verify.ts), as it sends no notice at all:
 *   its browsers are the family's real ones.
 */
import { audit, type Actor } from "../audit.js";
import type { Deps } from "../deps.js";
import type { Caregiver } from "../family/caregivers/store.js";
import { drillCopy } from "../ops/verify.js";
import { type Notice, sendNotice } from "../push.js";
import { getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { formatDateTime } from "../time.js";
import { listParents } from "./parents.js";

/** How a session came to be. */
export type SignIn =
  | {
      kind: "parent";
      parent: { id: string; name: string };
      /** The sign-in page; the OAuth sign-in screen, for an AI app; the first-run setup link; an invite. */
      how: "password" | "ai_app" | "setup" | "invite";
      /** The new session's id: its row in the parent's Settings. */
      sessionId: string;
    }
  | {
      kind: "caregiver";
      caregiver: Pick<Caregiver, "id" | "name">;
      /** Their caregiver sign-in page; their one-time link, first or again (a new password). */
      how: "password" | "join" | "join_again";
    };

const ACTIONS: Record<SignIn["how"], string> = {
  password: "signed_in",
  ai_app: "signed_in",
  setup: "setup",
  invite: "joined",
  join: "joined",
  join_again: "joined",
};

/** The activity log's line for a sign-in, with the kind of browser: its entry's id. */
function logged(deps: Deps, signIn: SignIn, browser: string): number {
  const now = deps.now();
  if (signIn.kind === "parent") {
    const actor: Actor = { kind: "parent", parentId: signIn.parent.id };
    return audit(deps.db, now, actor, `parent.${ACTIONS[signIn.how]}`, { detail: { browser, ...(signIn.how === "ai_app" ? { to: "connect_ai" } : {}) } });
  }
  const actor: Actor = { kind: "caregiver", caregiverId: signIn.caregiver.id, name: signIn.caregiver.name };
  return audit(deps.db, now, actor, `caregiver.${ACTIONS[signIn.how]}`, { detail: { browser, ...(signIn.how === "join_again" ? { again: true } : {}) } });
}

/**
 * The notice for one parent's browsers: `Sam signed in on Chrome on Android (Nov 18, 2026, 3:41
 * PM). If that wasn't you, …`. Names are the family's own words, cleaned and capped; the browser,
 * Belay's own few words.
 */
export function signInNotice(signIn: SignIn, to: { parentId: string }, browser: string, when: string, entryId: number): Notice {
  const title = "Belay: a new sign-in";
  const activity: Notice["url"] = `/activity#entry-${entryId}`;
  if (signIn.kind === "caregiver") {
    const name = oneLine(signIn.caregiver.name, 40) || "A caregiver";
    const did =
      signIn.how === "password"
        ? `${name} signed in to their caregiver page on ${browser}`
        : signIn.how === "join"
          ? `${name} joined as a caregiver, on ${browser}`
          : `${name} chose a new password with a sign-in link, on ${browser}`;
    return { title, body: `${did} (${when}). If that wasn't them, end their access on the Caregivers page.`, url: activity, urgent: true };
  }
  const name = oneLine(signIn.parent.name, 60) || "A parent";
  const own = to.parentId === signIn.parent.id;
  if (signIn.how === "invite") {
    const body = own ? `You joined Belay as a parent, on ${browser} (${when}).` : `${name} joined Belay as a parent, on ${browser} (${when}). If you didn't invite them, remove them in Settings.`;
    return { title, body, url: own ? `/settings#browser-${signIn.sessionId}` : activity, urgent: true };
  }
  const did = signIn.how === "setup" ? `${name} set up Belay on ${browser}` : `${name} signed in on ${browser}${signIn.how === "ai_app" ? " to connect an AI app" : ""}`;
  const advice = own
    ? `If that wasn't you, sign that browser out in Settings${signIn.how === "ai_app" ? ", disconnect any AI app you don't know," : ""} and change your password.`
    : `If that wasn't ${name}, tell them: they can sign it out in their Settings and change their password.`;
  return { title, body: `${did} (${when}). ${advice}`, url: own ? `/settings#browser-${signIn.sessionId}` : activity, urgent: true };
}

/**
 * Records a sign-in that made a session, and tells every parent at once (above). `browser` is the
 * request's kind of browser (auth/browsers.ts), the same words the session keeps. Sends without
 * waiting: the sign-in never waits for a push service.
 */
export function signedIn(deps: Deps, signIn: SignIn, browser: string): void {
  const entryId = logged(deps, signIn, browser);
  if (drillCopy(deps.db)) return;
  const when = formatDateTime(deps.now(), getSettings(deps.db).timezone);
  for (const parent of listParents(deps.db)) {
    void sendNotice(deps, signInNotice(signIn, { parentId: parent.id }, browser, when, entryId), { parentId: parent.id }).catch((error: unknown) => {
      deps.log(`A sign-in's notices didn't go out: ${error instanceof Error ? error.message : "error"}.`);
    });
  }
}
