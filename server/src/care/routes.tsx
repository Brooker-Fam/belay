/**
 * Phase 12: a caregiver's own pages, under /care (docs/design/phase12-caregivers.md): signing in,
 * joining with the one-time link a parent made, and, for each phone a parent chose, only what the
 * parent let them see and do: its status, pausing or locking it (only ever tighter), the kid's
 * "I need help", and checking where it is now. Mounted before the parent pages (app.ts), with its
 * own body limit, same-origin check, session and CSRF tokens; its catch-all answers every other
 * /care path, so no request here ever reaches a parent page's handler.
 *
 * Deny by default, in one place: a caregiver's session is `caregiver_sessions`, behind the cookie
 * `belay_care`, which no parent page reads (auth/caregivers.ts); its middleware drops one whose
 * access ended; and every route asks careAccess (family/caregivers/store.ts) whether this
 * caregiver may do this to this phone now.
 */
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { audit } from "../audit.js";
import {
  CARE_SESSION_TTL_MS,
  type CareSession,
  careLinkCaregiver,
  careSignedIn,
  checkCaregiverPassword,
  createCareSession,
  endCareSession,
  joinWithLink,
  loadCareSession,
} from "../auth/caregivers.js";
import { passwordProblem, usernameProblem } from "../auth/parents.js";
import type { Deps } from "../deps.js";
import { CARE_PAUSE_MINUTES, careActor, careCounted, careLimited, careLocate, carePause } from "../family/caregivers/changes.js";
import { listCareSubscriptions, removeCareSubscription, saveCareSubscription, sendToCaregiver } from "../family/caregivers/push.js";
import { type Caregiver, HELP_WINDOW_MS, ONLINE_MS, accessCurrent, careAccess } from "../family/caregivers/store.js";
import { LOCATE_NOW_MS } from "../family/commands.js";
import { getDevice } from "../family/devices.js";
import { phoneHelp } from "../family/kidside.js";
import { checkAnswer } from "../family/location/fixes.js";
import { locationSettings, takesChecks } from "../family/location/store.js";
import { type PolicyContext, RuleRefused, activePause, getRules } from "../family/policy.js";
import { type HelpView, listRequests } from "../family/requests.js";
import { phoneRules } from "../family/screentime/rules.js";
import { type Bindings, clientAddress } from "../http.js";
import { browserName, subscriptionProblem, vapidKeys } from "../push.js";
import { getSettings } from "../settings.js";
import type { Assets } from "../web/assets.js";
import { whereFor } from "../web/location.js";
import { first, render, safeNext, sameOrigin } from "../web/routes.js";
import { CareCheckPage, CareHomePage, CareJoinPage, CareLoginPage, CareMessagePage, type CarePhone, type CareView } from "./pages.js";

export type CareEnv = { Bindings: Bindings; Variables: { care: CareSession | null } };
type CareContext = Context<CareEnv>;

/** The caregiver's cookie: never the parents' (`belay`), and only these pages read it. */
export const CARE_COOKIE = "belay_care";
const NAME_MAX = 60;
/** A caregiver's check shows its answer this long after they asked: it's about where the phone is now, never where it was. */
const CHECK_SHOWN_MS = 15 * 60_000;

const SAVED: Record<string, string> = {
  paused: "Paused. The phone gets it within seconds if it's online, and shows your name.",
  locked: "Paused, and the screen locks. The phone gets it within seconds if it's online, and shows your name.",
  kept: "The phone was paused at least that long already, so nothing changed.",
  push_on: "Notifications are on for this browser.",
  push_off: "Notifications are off for this browser.",
};

/** Only a caregiver page: never a parent page after signing in. */
function careNext(next: string | undefined): string {
  const path = safeNext(next);
  return /^\/care(?:[/?#]|$)/.test(path) ? path : "/care";
}

function careCookie(deps: Deps) {
  const prefix = deps.config.secureCookies ? ("host" as const) : undefined;
  return {
    get: (c: Context) => getCookie(c, CARE_COOKIE, prefix),
    set: (c: Context, value: string) => {
      setCookie(c, CARE_COOKIE, value, { httpOnly: true, sameSite: "Lax", secure: deps.config.secureCookies, path: "/", maxAge: CARE_SESSION_TTL_MS / 1000, prefix });
    },
    clear: (c: Context) => {
      deleteCookie(c, CARE_COOKIE, { path: "/", secure: deps.config.secureCookies, prefix });
    },
  };
}

export function careRoutes(deps: Deps, assets: Assets): Hono<CareEnv> {
  const { db, config } = deps;
  const app = new Hono<CareEnv>();
  const cookie = careCookie(deps);

  const view = (c: CareContext): CareView => {
    const care = c.var.care;
    return {
      parentName: null,
      caregiverName: care?.caregiver.name ?? null,
      endsAt: care?.caregiver.endsAt ?? null,
      csrf: care?.csrf ?? "",
      tz: getSettings(db).timezone,
      now: deps.now(),
      path: c.req.path,
      assets: assets.urls,
    };
  };
  const message = (c: CareContext, title: string, text: string, status: ContentfulStatusCode = 200, link?: { href: string; label: string }) =>
    render(c, <CareMessagePage view={view(c)} title={title} message={text} link={link} />, status);

  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("That form is too large.", 413) }));
  app.use(
    "*",
    createMiddleware<CareEnv>(async (c, next) => {
      c.set("care", loadCareSession(db, cookie.get(c), deps.now()));
      if (c.req.method === "POST" && !sameOrigin(c, config.publicUrl)) {
        return message(c, "That didn't come from here", `For safety, use Belay's pages at ${config.publicUrl}.`, 403);
      }
      return next();
    }),
  );

  // ── Signing in, and joining with a link ────────────────────────────

  app.get("/login", (c) => {
    if (c.var.care) return c.redirect(careNext(c.req.query("next")));
    return render(c, <CareLoginPage view={view(c)} next={careNext(c.req.query("next"))} />);
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const username = first(form, "username");
    const password = typeof form.password === "string" ? form.password : "";
    const next = careNext(first(form, "next"));
    // The same per-address limit as a parent's sign-in, so alternating the two pages gains nothing.
    const client = clientAddress(c, config.trustProxy);
    const user = `care:${username.toLowerCase()}`;
    const limited = [deps.limits.loginPerClient.check(client), deps.limits.loginPerUser.check(user)].find((v): v is { ok: false; retryAfterSeconds: number } => !v.ok);
    if (limited) {
      c.header("Retry-After", String(limited.retryAfterSeconds));
      return render(c, <CareLoginPage view={view(c)} username={username} next={next} error="Too many tries. Wait 15 minutes, then try again." />, 429);
    }
    const caregiver = await checkCaregiverPassword(db, username, password);
    if (!caregiver) {
      deps.limits.loginPerClient.hit(client);
      deps.limits.loginPerUser.hit(user);
      return render(c, <CareLoginPage view={view(c)} username={username} next={next} error="That username and password don't match." />, 401);
    }
    const now = deps.now();
    if (!accessCurrent(caregiver, now)) {
      return render(c, <CareLoginPage view={view(c)} username={username} next={next} error="Your access to this family's phones has ended. A parent can give it again." />, 403);
    }
    cookie.set(c, createCareSession(db, now, caregiver.id).cookie);
    careSignedIn(db, now, caregiver.id);
    audit(db, now, careActor(caregiver), "caregiver.signed_in");
    return c.redirect(next);
  });

  const linkBroken = (c: CareContext) =>
    message(c, "This link doesn't work", "It was used already, or it expired, or the access it was for has ended. Ask the parent for a new one.", 400);
  const phoneNames = (caregiver: Caregiver) => caregiver.phones.flatMap((id) => db.prepare<[string], { name: string }>("SELECT name FROM devices WHERE id = ?").all(id).map((r) => r.name));

  app.get("/join/:token", (c) => {
    const caregiver = careLinkCaregiver(db, c.req.param("token"), deps.now());
    if (!caregiver) return linkBroken(c);
    return render(c, <CareJoinPage view={view(c)} token={c.req.param("token")} caregiver={caregiver} phones={phoneNames(caregiver)} />);
  });

  app.post("/join/:token", async (c) => {
    const token = c.req.param("token");
    const before = careLinkCaregiver(db, token, deps.now());
    if (!before) return linkBroken(c);
    const form = await c.req.parseBody({ all: true });
    const username = first(form, "username");
    const password = typeof form.password === "string" ? form.password : "";
    const problem = usernameProblem(username) ?? passwordProblem(password, typeof form.repeat === "string" ? form.repeat : "");
    const again = (error: string) => render(c, <CareJoinPage view={view(c)} token={token} caregiver={before} phones={phoneNames(before)} error={error} username={username} />, 400);
    if (problem) return again(problem);
    const now = deps.now();
    const joined = await joinWithLink(db, now, token, username, password);
    if (!joined.ok) return joined.why === "username" ? again("Another caregiver has that username. Choose another.") : linkBroken(c);
    cookie.set(c, joined.cookie);
    audit(db, now, careActor(joined.caregiver), "caregiver.joined", before.joined ? { detail: { again: true } } : {});
    return c.redirect("/care");
  });

  // ── Everything below needs a signed-in caregiver whose access lasts ─

  app.use(
    "*",
    createMiddleware<CareEnv>(async (c, next) => {
      const care = c.var.care;
      if (!care) {
        if (c.req.method === "GET") return c.redirect(`/care/login?next=${encodeURIComponent(careNext(c.req.path + (new URL(c.req.url).search || "")))}`);
        return message(c, "Signed out", "Sign in again, then try that once more.", 401, { href: "/care/login", label: "Sign in" });
      }
      if (c.req.method === "POST") {
        const form = await c.req.parseBody({ all: true });
        if (first(form, "_csrf") !== care.csrf) return message(c, "That form expired", "Go back, reload the page, and try again.", 403);
      }
      return next();
    }),
  );

  const me = (c: CareContext): CareSession => {
    const care = c.var.care;
    if (!care) throw new Error("no caregiver session");
    return care;
  };
  const ctx = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });

  app.post("/logout", (c) => {
    endCareSession(db, me(c).idHash);
    cookie.clear(c);
    return c.redirect("/care/login");
  });

  /** One phone, as this caregiver's choices let them see it. */
  const phoneView = (caregiver: Caregiver, deviceId: string, now: number): CarePhone | null => {
    const device = getDevice(db, deviceId, getSettings(db), now);
    if (!device) return null;
    let status: CarePhone["status"] = null;
    if (careAccess(caregiver, deviceId, "status", now)) {
      const pause = activePause(getRules(db, deviceId), now);
      const reported = device.enforcement?.screen_time?.schedule ?? null;
      const schedule = reported && reported.until > now ? phoneRules(db, deviceId).rules.schedules.find((s) => s.id === reported.id) : undefined;
      status = {
        online: device.revokedAt === null && device.policyAskedAt !== null && now - device.policyAskedAt < ONLINE_MS,
        lastSeenAt: device.lastSeenAt,
        battery: device.facts?.battery_percent ?? null,
        charging: device.facts?.charging ?? null,
        // Never who else paused it: a caregiver doesn't learn of other caregivers.
        pause: pause ? { until: pause.until, yours: pause.caregiver !== null && pause.caregiver === caregiver.name } : null,
        schedule: reported && reported.until > now ? { name: schedule?.name ?? "A schedule", until: reported.until, reportedAt: device.factsAt } : null,
      };
    }
    return {
      id: device.id,
      name: device.name,
      disconnected: device.revokedAt !== null,
      status,
      canPause: careAccess(caregiver, deviceId, "pause", now),
      locate: careAccess(caregiver, deviceId, "locate", now) ? { on: takesChecks(locationSettings(db, deviceId)) } : null,
    };
  };

  /**
   * The help requests a caregiver sees: their phones' with help on, since their access began, at
   * most 7 days back. The list puts every help request no parent has seen first (at most 100 a
   * phone), so it reads past them to the newer ones a parent saw.
   */
  const helpFor = (caregiver: Caregiver, now: number): HelpView[] =>
    caregiver.phones
      .filter((id) => careAccess(caregiver, id, "help", now))
      .flatMap((id) => listRequests(db, { deviceId: id, kind: "help", limit: 300 }))
      .filter((r): r is HelpView => r.kind === "help" && r.receivedAt >= Math.max(caregiver.accessFrom, now - HELP_WINDOW_MS))
      .sort((a, b) => b.receivedAt - a.receivedAt);

  const home = (c: CareContext, extra: { message?: string; error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const { caregiver } = me(c);
    const now = deps.now();
    const helps = caregiver.phones.some((id) => careAccess(caregiver, id, "help", now));
    return render(
      c,
      <CareHomePage
        view={view(c)}
        caregiver={caregiver}
        phones={caregiver.phones.flatMap((id) => phoneView(caregiver, id, now) ?? [])}
        help={helps ? { requests: helpFor(caregiver, now), kidNumber: (id) => phoneHelp(db, id).kidNumber, where: whereFor(deps) } : null}
        push={helps ? { publicKey: vapidKeys(db).publicKey, browsers: listCareSubscriptions(db, caregiver.id).length } : null}
        message={extra.error ? undefined : (extra.message ?? SAVED[c.req.query("saved") ?? ""])}
        error={extra.error}
      />,
      status,
    );
  };

  app.get("/", (c) => home(c));

  /** The phone in the path, when it's one of this caregiver's. Another family phone is "no such phone": they don't learn of it. */
  const theirPhone = (c: CareContext) => {
    const { caregiver } = me(c);
    const id = c.req.param("id") ?? "";
    return caregiver.phones.includes(id) ? getDevice(db, id, getSettings(db), deps.now()) : null;
  };
  const noPhone = (c: CareContext) => message(c, "No such phone", "It isn't one of the phones you look after.", 404, { href: "/care", label: "Back" });
  const notChosen = (c: CareContext) => home(c, { error: "A parent didn't choose that for you, or your access to it changed." }, 403);

  app.post("/phones/:id/pause", async (c) => {
    const device = theirPhone(c);
    if (!device) return noPhone(c);
    const { caregiver } = me(c);
    if (!careAccess(caregiver, device.id, "pause", deps.now())) return notChosen(c);
    if (device.revokedAt !== null) return home(c, { error: "This phone is disconnected, so it wouldn't get that." }, 400);
    const body = await c.req.parseBody({ all: true });
    const minutes = Number(first(body, "minutes"));
    const lock = first(body, "lock") === "1";
    if (!(CARE_PAUSE_MINUTES as readonly number[]).includes(minutes)) return home(c, { error: "Choose how long: 15 minutes to 4 hours." }, 400);
    const action = lock ? "lock" : "pause";
    const limited = careLimited(deps, caregiver, action, device);
    if (limited) return home(c, { error: limited }, 429);
    const done = carePause(ctx(), caregiver, device.id, minutes, lock);
    if (done.changed) careCounted(deps, caregiver, action, device.id);
    return c.redirect(`/care?saved=${done.result.kept && !lock ? "kept" : lock ? "locked" : "paused"}#phone-${device.id}`);
  });

  /** Check where it is now: the phone gets a check within seconds; this waits up to a minute for its fix, then shows it. */
  app.post("/phones/:id/locate", async (c) => {
    const device = theirPhone(c);
    if (!device) return noPhone(c);
    const { caregiver } = me(c);
    if (!careAccess(caregiver, device.id, "locate", deps.now())) return notChosen(c);
    if (device.revokedAt !== null) return home(c, { error: "This phone is disconnected, so it wouldn't get that." }, 400);
    if (!takesChecks(locationSettings(db, device.id))) return home(c, { error: "Location is off for this phone, so it doesn't answer a check. A parent can turn it on." }, 400);
    const limited = careLimited(deps, caregiver, "locate", device);
    if (limited) return home(c, { error: limited }, 429);
    let command: string;
    try {
      command = careLocate(ctx(), caregiver, device.id).result.command;
    } catch (error) {
      if (error instanceof RuleRefused) return home(c, { error: error.message }, 400);
      throw error;
    }
    careCounted(deps, caregiver, "locate", device.id);
    await deps.fixWaiters.wait(device.id, () => checkAnswer(db, device.id, command, { withinMs: LOCATE_NOW_MS }) !== null, deps.locateWaitMs, c.req.raw.signal);
    return c.redirect(`/care/phones/${device.id}/checks/${encodeURIComponent(command)}`);
  });

  /** A check's answer: only this caregiver's own, for a few minutes, and never a later check's fix. */
  app.get("/phones/:id/checks/:command", (c) => {
    const device = theirPhone(c);
    if (!device) return noPhone(c);
    const { caregiver } = me(c);
    const now = deps.now();
    if (!careAccess(caregiver, device.id, "locate", now)) return notChosen(c);
    const mine = db
      .prepare<[string, string, string], { issued_at: number }>("SELECT issued_at FROM commands WHERE device_id = ? AND id = ? AND caregiver_id = ? AND kind = 'locate_now'")
      .get(device.id, c.req.param("command"), caregiver.id);
    if (!mine) return message(c, "No such check", "Check again to see where the phone is now.", 404, { href: `/care#phone-${device.id}`, label: "Back" });
    const expired = now - mine.issued_at > CHECK_SHOWN_MS;
    const fix = expired ? null : checkAnswer(db, device.id, c.req.param("command"), { withinMs: LOCATE_NOW_MS });
    return render(c, <CareCheckPage view={view(c)} phone={{ id: device.id, name: device.name }} fix={fix} where={whereFor(deps)} expired={expired} />);
  });

  // ── Notifications: only the kid's help requests, so only with help on ─

  const getsHelp = (caregiver: Caregiver) => caregiver.phones.some((id) => careAccess(caregiver, id, "help", deps.now()));

  app.post("/push/subscribe", async (c) => {
    const { caregiver } = me(c);
    if (!getsHelp(caregiver)) return notChosen(c);
    const body = await c.req.parseBody({ all: true });
    const input = { endpoint: first(body, "endpoint"), p256dh: first(body, "p256dh"), auth: first(body, "auth") };
    const problem = subscriptionProblem(input);
    if (problem) return home(c, { error: problem }, 400);
    const now = deps.now();
    const saved = saveCareSubscription(db, now, caregiver.id, input, browserName(c.req.header("user-agent"), input.endpoint).slice(0, NAME_MAX));
    audit(db, now, careActor(caregiver), "push.subscribed", { detail: { browser: saved.name } });
    return c.redirect("/care?saved=push_on#notifications");
  });

  app.post("/push/unsubscribe", async (c) => {
    const { caregiver } = me(c);
    const endpoint = first(await c.req.parseBody({ all: true }), "endpoint");
    const removed = endpoint ? removeCareSubscription(db, caregiver.id, endpoint) : null;
    if (removed) audit(db, deps.now(), careActor(caregiver), "push.unsubscribed", { detail: { browser: removed.name } });
    return c.redirect("/care?saved=push_off#notifications");
  });

  app.post("/push/test", async (c) => {
    const { caregiver } = me(c);
    if (!getsHelp(caregiver)) return notChosen(c);
    const result = await sendToCaregiver(deps, caregiver.id, { title: "Belay", body: "A test notice from Belay's caregiver page.", url: "/care" });
    if (result.sent > 0) return home(c, { message: `Sent a test notice to ${result.sent} browser${result.sent === 1 ? "" : "s"}.` });
    return home(c, { error: result.removed > 0 ? "That browser's push service no longer knows it, so it was removed. Turn notifications on again there." : "The test notice didn't go out. Try again in a minute." }, 502);
  });

  // Every other /care path: a caregiver page that isn't, never a parent page.
  app.all("*", (c) => message(c, "Not here", "There's no caregiver page at this address.", 404, { href: "/care", label: "Back" }));

  return app;
}
