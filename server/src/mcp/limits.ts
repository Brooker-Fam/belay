/**
 * What an AI app does that reaches the kid, limited per connection and phone (ratelimit.ts's
 * aiChecks and aiLocks): each check of where the phone is posts a notice on the kid's phone, and
 * each pause or lock stops their apps (a lock locks the screen too). Past a few an hour, the tool
 * refuses in plain words and says when to try again, and the activity log says so, once an hour
 * however often the app tries. Only MCP's tools come through here: a parent, on the parent page
 * or with the CLI, isn't limited. An AI app's refused changes are in the activity log the same
 * way, once an hour (aiRefused).
 */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { AI_PER_HOUR } from "../ratelimit.js";
import { getSettings } from "../settings.js";
import { isoInZone } from "../time.js";
import type { Caller } from "./server.js";

/** The tools that reach the kid. Pauses and locks share their limit: both pause the phone. */
export type AiAction = "locate_now" | "pause_phone" | "lock_phone";

const KIND = { locate_now: "checks", pause_phone: "locks", lock_phone: "locks" } as const satisfies Record<AiAction, keyof typeof AI_PER_HOUR>;

const limiter = (deps: Deps, action: AiAction) => (KIND[action] === "checks" ? deps.limits.aiChecks : deps.limits.aiLocks);
const key = (caller: Caller, deviceId: string) => `${caller.grantId} ${deviceId}`;

/**
 * Null when this connection may do `action` to the phone now; otherwise the refusal, saying when
 * to try again. Counts nothing: aiCounted does, once the action is done.
 */
export function aiLimited(deps: Deps, caller: Caller, action: AiAction, phone: { id: string; name: string }): CallToolResult | null {
  const verdict = limiter(deps, action).check(key(caller, phone.id));
  if (verdict.ok) return null;
  const kind = KIND[action];
  const now = deps.now();
  if (deps.limits.aiLimitedLog.hit(`${key(caller, phone.id)} ${kind}`).ok) {
    audit(deps.db, now, { kind: "ai", parentId: caller.parentId, clientName: caller.clientName }, "ai.limited", {
      deviceId: phone.id,
      detail: { what: kind, limit: AI_PER_HOUR[kind] },
    });
  }
  const minutes = Math.max(1, Math.ceil(verdict.retryAfterSeconds / 60));
  const when = `Try again in ${minutes} minute${minutes === 1 ? "" : "s"}, at ${isoInZone(now + verdict.retryAfterSeconds * 1000, getSettings(deps.db).timezone)}.`;
  const text =
    kind === "checks"
      ? `Not checked: an AI app may check where ${phone.name} is at most ${AI_PER_HOUR.checks} times an hour through one connection (the kid's phone shows a notice for each check), and this one has. ${when} A parent can check at any time, on the phone's Location page.`
      : `Not done: an AI app may pause or lock ${phone.name} at most ${AI_PER_HOUR.locks} times an hour through one connection, pauses and locks together, and this one has. ${when} A parent can pause or lock it at any time, on the parent page.`;
  return { content: [{ type: "text", text }], isError: true };
}

/** Counts an action that reached the phone, against this connection's limit for it. */
export function aiCounted(deps: Deps, caller: Caller, action: AiAction, deviceId: string): void {
  limiter(deps, action).hit(key(caller, deviceId));
}

/** The tools whose refusals the activity log keeps (aiRefused). */
export type RefusingTool = "change_calls" | "change_screen_time";

/**
 * Why the server refused an AI app's change, for the activity log (web/pages/activity.tsx words
 * each): it named phone numbers while a parent keeps calls from AI apps (`numbers`), or apps while
 * a parent keeps apps from them (`apps`), it was a parent's alone (`parents_only`), it was about
 * texts, which Belay doesn't manage yet (`texts`), a schedule was too short (`short_schedule`), or
 * anything else Belay doesn't allow it (`other`).
 */
export type RefusedWhy = "numbers" | "apps" | "parents_only" | "texts" | "short_schedule" | "other";

/**
 * Puts an AI app's refused change in the activity log (`ai.refused`), so a parent sees what it
 * tried: once an hour per connection, phone, tool and reason, however often it tries, like
 * ai.limited. The entry names no number, contact, app or rule: only the tool and the kind of reason.
 */
export function aiRefused(deps: Deps, caller: Caller, tool: RefusingTool, deviceId: string, why: RefusedWhy): void {
  if (!deps.limits.aiRefusedLog.hit(`${key(caller, deviceId)} ${tool} ${why}`).ok) return;
  audit(deps.db, deps.now(), { kind: "ai", parentId: caller.parentId, clientName: caller.clientName }, "ai.refused", { deviceId, detail: { tool, why } });
}
