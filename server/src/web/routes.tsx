/** The parent pages: server-rendered, no SPA, working without JavaScript. */
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { createMiddleware } from "hono/factory";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { HtmlEscapedString } from "hono/utils/html";
import QRCode from "qrcode";
import { audit } from "../audit.js";
import { listAudit } from "../audit.js";
import {
  SESSION_TTL_MS,
  type Session,
  checkPassword,
  clearSetupToken,
  createInvite,
  createSession,
  endAllSessions,
  endSession,
  getParent,
  hashPassword,
  inviteValid,
  listParents,
  loadSession,
  parentCount,
  passwordProblem,
  removeParent,
  setPassword,
  setupTokenValid,
  useInvite,
  usernameProblem,
  usernameTaken,
} from "../auth/parents.js";
import { newId } from "../crypto.js";
import type { Deps } from "../deps.js";
import { cancelCode, createEnrollmentCode, pendingCodes } from "../device/enroll.js";
import { packageName } from "../device/schemas.js";
import { type App, getApp, listApps, listChanges, markReviewed, reviewHistory, appCounts } from "../family/apps.js";
import { getAgentFile, listAgentFiles, offerAgent, withdrawOffer } from "../family/agent.js";
import { makePhoneRecoveryKey, recoveryState, usableKey } from "../family/recovery.js";
import { issueCommand, listCommands } from "../family/commands.js";
import { type DeviceView, deleteDevice, getDevice, listDevices, nameTaken, renameDevice, revokeDevice } from "../family/devices.js";
import {
  type ChromeSettings,
  DNS_FILTERS,
  LIMITS,
  LOCK_RESTRICTIONS,
  MORE_TIME_CHOICES,
  RuleRefused,
  SAFE_RESTRICTIONS,
  answerRequest,
  askAgainSummary,
  clearPreDecisions,
  currentDecisions,
  decideApp,
  decisionHistory,
  getRules,
  neverBlockedOn,
  pausePhone,
  preDecisions,
  protect,
  resumePhone,
  setHardening,
  setMaintenance,
  setNewApps,
  setRestrictions,
  setSupportMessage,
  setWeb,
  unprotect,
  validHostname,
  type PolicyContext,
} from "../family/policy.js";
import { approveProposal, listProposals, outdatedBecause, pendingProposalCount, rejectProposal, screenTimeWords } from "../family/proposals.js";
import { listAppRequests, pendingRequestCount, recentAppRequests, recentRequests } from "../family/requests.js";
import { phoneLabels, phoneRules as screenRules } from "../family/screentime/rules.js";
import { clientAddress, type Bindings } from "../http.js";
import { createPersonalToken, getGrant, listGrants, revokeAllGrants, revokeGrant } from "../oauth/store.js";
import { serverHealth } from "../ops/health.js";
import { getDigest } from "../ops/notify.js";
import { opsWebRoutes } from "../ops/web.js";
import { browserName, listSubscriptions, removeSubscription, saveSubscription, sendNotice, subscriptionProblem, vapidKeys } from "../push.js";
import { AI_SCOPES, type AiScope, getSettings, updateSettings } from "../settings.js";
import { isValidTimeZone } from "../time.js";
import type { Assets } from "./assets.js";
import { ActivityPage } from "./pages/activity.js";
import { AddPage, CodePage } from "./pages/add.js";
import { InvitePage, LoginPage, MessagePage, SetupPage } from "./pages/auth.js";
import { RecoveryKeyPage } from "./pages/belay.js";
import { type AppRule, AppPage, DevicePage, DevicesPage, type PhoneRules } from "./pages/devices.js";
import { ProposalsPage, RequestsPage } from "./pages/requests.js";
import { AskAgainPage, MAINTENANCE_HOURS, PAUSE_MINUTES } from "./pages/rules.js";
import { DigestCard, ServerCard } from "./pages/server.js";
import { SettingsPage, ShownOncePage } from "./pages/settings.js";
import { TimelinePage } from "./pages/timeline.js";
import type { View } from "./ui.js";

export type WebEnv = { Bindings: Bindings; Variables: { session: Session | null } };
type WebContext = Context<WebEnv>;
type Form = Record<string, string | File | (string | File)[]>;

const COOKIE = "belay";
const NAME_MAX = 60;

const SAVED: Record<string, string> = {
  settings: "Settings saved.",
  password: "Password changed. You were signed out on your other browsers.",
  revoked: "Disconnected. Its tokens stopped working.",
  removed: "Removed.",
  renamed: "Renamed.",
  disconnected: "Disconnected. The phone's access stopped.",
  push_on: "Notifications are on for this browser.",
  push_off: "Notifications are off for this browser.",
  push_removed: "Removed. That browser gets no more notices.",
  protected: "Protection is on. The phone gets the new rules within seconds if it's online.",
  unprotected: "Protection is off. The phone gets the change within seconds if it's online.",
  new_apps_ask: "New apps now wait for your approval. The apps already on the phone are allowed.",
  new_apps_ask_again: "New apps wait for your approval again. The apps you chose are allowed; the others wait for you below.",
  new_apps_allow: "New apps now run without asking.",
  allowed: "Allowed.",
  blocked: "Blocked. The phone hides it within seconds if it's online.",
  cleared: "Cleared: those apps have no decision now.",
  update_offered: "Offered. The phone gets it with its next rules, within seconds if it's online.",
  update_not_newer: "Offered, but the phone runs that version or a newer one already, so it won't install it.",
  update_withdrawn: "The update isn't offered any more.",
  command_sent: "Sent. The phone removes them when it gets this, within seconds if it's online.",
  command_waiting: "That's already waiting for the phone.",
  paused: "Paused. The phone gets it within seconds if it's online.",
  resumed: "Resumed.",
  rules: "Saved. The phone gets it within seconds if it's online.",
  maintenance_on: "Maintenance mode is on: USB debugging works until it ends.",
  maintenance_off: "Maintenance mode is off.",
  answer_approved: "Approved, and the app is allowed. They'll see your answer on the phone.",
  answer_declined: "Declined. They'll see your answer on the phone.",
  answer_talk: "They'll see on the phone that you want to talk about it.",
  answer_more_time: "Given. The phone gets the extra time within seconds if it's online, and they'll see your answer there.",
  answer_other_approved: "Answered. They'll see your answer on the phone.",
  answer_other_declined: "Declined. They'll see your answer on the phone.",
  answer_other_talk: "They'll see on the phone that you want to talk about it.",
  proposal_approved: "Approved. The change is on its way to the phone.",
  proposal_rejected: "Rejected. Nothing changed.",
  digest: "Daily summary saved.",
};

/** Google account ids for reset protection: long numbers, one per line ("people/" before one is fine). */
function accountIds(text: string): { ok: true; ids: string[] } | { ok: false; error: string } {
  const ids = [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((s) => s.replace(/^people\//i, ""))
        .filter(Boolean),
    ),
  ];
  if (ids.some((id) => !/^\d{1,64}$/.test(id))) return { ok: false, error: "A Google account id is a long number, like 112233445566778899000. Paste only the number after people/." };
  if (ids.length > LIMITS.maxFrpAccounts) return { ok: false, error: `List at most ${LIMITS.maxFrpAccounts} accounts.` };
  return { ok: true, ids };
}

/** Sites for Chrome's lists, one per line, as Chrome takes them (example.com, *.example.com). */
function urlPatterns(text: string): { ok: true; list: string[] } | { ok: false } {
  const list = [
    ...new Set(
      text
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (list.length > LIMITS.maxUrlPatterns || list.some((p) => p.length > LIMITS.urlPattern || /\s/.test(p))) return { ok: false };
  return { ok: true, list };
}

/**
 * Security headers for every page. `formAction` widens form-action for the OAuth consent page.
 * Scripts, the service worker (/sw.js) and the web app manifest are all same-origin files.
 */
export function pageHeaders(c: Context, formAction = "'self'"): void {
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; manifest-src 'self'; worker-src 'self'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
  );
  c.header("X-Content-Type-Options", "nosniff");
  c.header("X-Frame-Options", "DENY");
  c.header("Referrer-Policy", "same-origin");
  c.header("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  c.header("Cache-Control", "no-store");
}

export async function render(c: Context, element: HtmlEscapedString | Promise<HtmlEscapedString>, status: ContentfulStatusCode = 200): Promise<Response> {
  if (!c.res.headers.has("Content-Security-Policy")) pageHeaders(c);
  return c.html(`<!doctype html>${(await element).toString()}`, status);
}

export function first(form: Form, name: string): string {
  const value = form[name];
  const one = Array.isArray(value) ? value[0] : value;
  return typeof one === "string" ? one.trim() : "";
}

function all(form: Form, name: string): string[] {
  const value = form[name];
  return (Array.isArray(value) ? value : value === undefined ? [] : [value]).filter((v): v is string => typeof v === "string");
}

/** A same-origin request, judged by the browser's own headers: a cross-site form can't fake them. */
export function sameOrigin(c: Context, publicUrl: string): boolean {
  const origin = c.req.header("origin");
  if (origin !== undefined) return origin === publicUrl;
  const site = c.req.header("sec-fetch-site");
  return site === undefined || site === "same-origin" || site === "none";
}

/** Only paths on this site: never another host after signing in. */
export function safeNext(next: string | undefined): string {
  return next && /^\/(?![/\\])[^\s]*$/.test(next) ? next : "/";
}

export function sessionCookie(deps: Deps) {
  const prefix = deps.config.secureCookies ? ("host" as const) : undefined;
  return {
    get: (c: Context) => getCookie(c, COOKIE, prefix),
    set: (c: Context, value: string) => {
      setCookie(c, COOKIE, value, { httpOnly: true, sameSite: "Lax", secure: deps.config.secureCookies, path: "/", maxAge: SESSION_TTL_MS / 1000, prefix });
    },
    clear: (c: Context) => {
      deleteCookie(c, COOKIE, { path: "/", secure: deps.config.secureCookies, prefix });
    },
  };
}

export function webRoutes(deps: Deps, assets: Assets): Hono<WebEnv> {
  const { db, config } = deps;
  const app = new Hono<WebEnv>();
  const cookie = sessionCookie(deps);

  const view = (c: WebContext): View => {
    const session = c.var.session;
    return {
      parentName: session?.parent.name ?? null,
      csrf: session?.csrf ?? "",
      tz: getSettings(db).timezone,
      now: deps.now(),
      path: c.req.path,
      assets: assets.urls,
      waiting: session ? { requests: pendingRequestCount(db), proposals: pendingProposalCount(db) } : undefined,
    };
  };
  const message = (c: WebContext, title: string, text: string, status: ContentfulStatusCode = 200, link?: { href: string; label: string }) =>
    render(c, <MessagePage view={view(c)} title={title} message={text} link={link} />, status);

  app.use("*", bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.text("That form is too large.", 413) }));
  app.use(
    "*",
    createMiddleware<WebEnv>(async (c, next) => {
      c.set("session", loadSession(db, cookie.get(c), deps.now()));
      if (c.req.method === "POST" && !sameOrigin(c, config.publicUrl)) {
        return message(c, "That didn't come from here", `For safety, use Belay's pages at ${config.publicUrl}.`, 403);
      }
      return next();
    }),
  );

  // ── Setup, sign-in, invites ──────────────────────────────────────────

  app.get("/setup", (c) => {
    if (parentCount(db) > 0) return c.redirect("/login");
    const token = c.req.query("token") ?? "";
    if (!setupTokenValid(db, token, deps.now())) {
      return message(c, "This setup link doesn't work", "It may have expired. Restart the server, or run the setup-link command (docs/server.md), for a new one.", 400);
    }
    return render(c, <SetupPage view={view(c)} token={token} />);
  });

  app.post("/setup", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const token = first(form, "token");
    const values = { name: first(form, "name"), username: first(form, "username"), timezone: first(form, "timezone") };
    const password = typeof form.password === "string" ? form.password : "";
    const problem =
      (!values.name || values.name.length > NAME_MAX ? "Enter your name." : null) ??
      usernameProblem(values.username) ??
      passwordProblem(password, typeof form.repeat === "string" ? form.repeat : "") ??
      (isValidTimeZone(values.timezone) ? null : "Pick a timezone from the list, like America/New_York.");
    if (problem) return render(c, <SetupPage view={view(c)} token={token} error={problem} values={values} />, 400);
    const passwordHash = await hashPassword(password);
    const now = deps.now();
    const parentId = db.transaction(() => {
      if (!setupTokenValid(db, token, now)) return null;
      const id = newId();
      db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, values.name, values.username, passwordHash, now);
      clearSetupToken(db);
      return id;
    })();
    if (!parentId) return message(c, "This setup link doesn't work", "Belay may already be set up.", 400, { href: "/login", label: "Sign in" });
    updateSettings(db, { timezone: values.timezone });
    audit(db, now, { kind: "parent", parentId }, "parent.setup");
    cookie.set(c, createSession(db, now, parentId).cookie);
    deps.log("The first parent account was created.");
    return c.redirect("/add");
  });

  app.get("/login", (c) => {
    if (c.var.session) return c.redirect(safeNext(c.req.query("next")));
    if (parentCount(db) === 0) return message(c, "Belay isn't set up yet", "Open the setup link from the server's log to create the first parent account.");
    return render(c, <LoginPage view={view(c)} next={safeNext(c.req.query("next"))} />);
  });

  app.post("/login", async (c) => {
    const form = await c.req.parseBody({ all: true });
    const username = first(form, "username");
    const password = typeof form.password === "string" ? form.password : "";
    const next = safeNext(first(form, "next"));
    const client = clientAddress(c, config.trustProxy);
    const limited = [deps.limits.loginPerClient.check(client), deps.limits.loginPerUser.check(username.toLowerCase())].find(
      (v): v is { ok: false; retryAfterSeconds: number } => !v.ok,
    );
    if (limited) {
      c.header("Retry-After", String(limited.retryAfterSeconds));
      return render(c, <LoginPage view={view(c)} username={username} next={next} error="Too many tries. Wait 15 minutes, then try again." />, 429);
    }
    const parent = await checkPassword(db, username, password);
    if (!parent) {
      deps.limits.loginPerClient.hit(client);
      deps.limits.loginPerUser.hit(username.toLowerCase());
      return render(c, <LoginPage view={view(c)} username={username} next={next} error="That username and password don't match." />, 401);
    }
    const now = deps.now();
    cookie.set(c, createSession(db, now, parent.id).cookie);
    audit(db, now, { kind: "parent", parentId: parent.id }, "parent.signed_in");
    return c.redirect(next);
  });

  app.get("/invite/:token", (c) => {
    if (!inviteValid(db, c.req.param("token"), deps.now())) return message(c, "This invite doesn't work", "It was used already or expired. Ask for a new one.", 400);
    return render(c, <InvitePage view={view(c)} token={c.req.param("token")} />);
  });

  app.post("/invite/:token", async (c) => {
    const token = c.req.param("token");
    const form = await c.req.parseBody({ all: true });
    const values = { name: first(form, "name"), username: first(form, "username") };
    const password = typeof form.password === "string" ? form.password : "";
    const problem =
      (!values.name || values.name.length > NAME_MAX ? "Enter your name." : null) ??
      usernameProblem(values.username) ??
      (usernameTaken(db, values.username) ? "That username is taken." : null) ??
      passwordProblem(password, typeof form.repeat === "string" ? form.repeat : "");
    if (problem) return render(c, <InvitePage view={view(c)} token={token} error={problem} values={values} />, 400);
    const passwordHash = await hashPassword(password);
    const now = deps.now();
    const parentId = db.transaction(() => {
      if (!useInvite(db, token, now) || usernameTaken(db, values.username)) return null;
      const id = newId();
      db.prepare("INSERT INTO parents (id, name, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)").run(id, values.name, values.username, passwordHash, now);
      return id;
    })();
    if (!parentId) return message(c, "This invite doesn't work", "It was used already or expired. Ask for a new one.", 400);
    audit(db, now, { kind: "parent", parentId }, "parent.joined");
    cookie.set(c, createSession(db, now, parentId).cookie);
    return c.redirect("/");
  });

  // ── Everything below needs a signed-in parent ─────────────────────────

  app.use(
    "*",
    createMiddleware<WebEnv>(async (c, next) => {
      const session = c.var.session;
      if (!session) {
        if (c.req.method === "GET") return c.redirect(`/login?next=${encodeURIComponent(c.req.path + (new URL(c.req.url).search || ""))}`);
        return message(c, "Signed out", "Sign in again, then try that once more.", 401, { href: "/login", label: "Sign in" });
      }
      if (c.req.method === "POST") {
        const form = await c.req.parseBody({ all: true });
        if (first(form, "_csrf") !== session.csrf) return message(c, "That form expired", "Go back, reload the page, and try again.", 403);
      }
      return next();
    }),
  );

  const me = (c: WebContext): Session => {
    const session = c.var.session;
    if (!session) throw new Error("no session");
    return session;
  };
  const form = (c: WebContext) => c.req.parseBody({ all: true });

  app.post("/logout", (c) => {
    endSession(db, me(c).idHash);
    cookie.clear(c);
    return c.redirect("/login");
  });

  app.get("/", (c) => {
    const now = deps.now();
    const settings = getSettings(db);
    const devices = listDevices(db, settings, now).map((device) => ({
      device,
      ...appCounts(db, device.id),
      requests: pendingRequestCount(db, device.id),
      protectedOn: getRules(db, device.id).protectedAt !== null,
    }));
    const pending = pendingCodes(db, now).filter((p) => !p.deviceId);
    if (devices.length === 0 && pending.length === 0) return c.redirect("/add");
    return render(c, <DevicesPage view={view(c)} devices={devices} pending={pending} server={<ServerCard view={view(c)} health={serverHealth(deps)} />} />);
  });

  const deviceOr404 = (c: WebContext) => getDevice(db, c.req.param("id") ?? "", getSettings(db), deps.now());

  /** A phone's rules, as its page shows them. */
  const phoneRules = (deviceId: string): PhoneRules => {
    const rules = getRules(db, deviceId);
    const decisions = currentDecisions(db, deviceId);
    const never = neverBlockedOn(db, deviceId);
    const ruleOf = (app: Pick<App, "package" | "system">): AppRule => {
      const decision = decisions.get(app.package) ?? null;
      const neverWhy = never(app.package);
      const canBlock = neverWhy === null;
      if (decision) return { state: decision.state, decision, canBlock, neverWhy };
      if (app.system || !canBlock) return { state: "runs", decision: null, canBlock, neverWhy };
      return { state: rules.newApps === "ask" ? "waiting" : "runs", decision: null, canBlock, neverWhy };
    };
    const present = new Set(
      db
        .prepare<[string], { package: string }>("SELECT package FROM apps WHERE device_id = ? AND present = 1")
        .all(deviceId)
        .map((r) => r.package),
    );
    // The newest open request per app.
    const seen = new Set<string>();
    const openRequests = recentAppRequests(db, deps.now(), { deviceId }).filter((r) => {
      if ((r.status !== "pending" && r.status !== "talk") || seen.has(r.package)) return false;
      seen.add(r.package);
      return true;
    });
    return {
      rules,
      undecidedApps: listApps(db, deviceId).filter((a) => !decisions.has(a.package)).length,
      ruleOf,
      openRequests,
      requestsForUnknownApps: openRequests.filter((r) => !present.has(r.package)),
      beforeInstall: preDecisions(db, deviceId),
      askAgain: askAgainSummary(db, deviceId),
      agentFiles: listAgentFiles(db),
      recovery: recoveryState(db, deviceId),
      commands: listCommands(db, deviceId, deps.now(), { kind: "remove_other_users" }),
    };
  };

  const showDevice = (c: WebContext, device: DeviceView, extra: { message?: string; error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const filter = { q: c.req.query("q") ?? "", system: c.req.query("system") === "1", permission: c.req.query("permission") ?? "" };
    const apps = listApps(db, device.id, { query: filter.q, includeSystem: filter.system, permission: filter.permission || undefined });
    const phone = phoneRules(device.id);
    // The kid's requests first, then apps waiting for a decision, then apps to review.
    const requested = new Set(phone.openRequests.map((r) => r.package));
    const rank = (a: App) => (requested.has(a.package) ? 0 : phone.ruleOf(a).state === "waiting" ? 1 : a.unreviewed ? 2 : 3);
    apps.sort((a, b) => rank(a) - rank(b));
    return render(c, <DevicePage view={view(c)} device={device} apps={apps} phone={phone} filter={filter} message={extra.message} error={extra.error} />, status);
  };

  app.get("/devices/:id", (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404, { href: "/", label: "Back to phones" });
    const reviewed = Number(c.req.query("reviewed") ?? "");
    const saved = c.req.query("saved");
    const note = Number.isInteger(reviewed) && reviewed > 0 ? `Marked ${reviewed} app${reviewed === 1 ? "" : "s"} reviewed.` : saved ? SAVED[saved] : undefined;
    return showDevice(c, device, { message: note });
  });

  app.get("/devices/:id/apps/:package", (c) => {
    const device = deviceOr404(c);
    const app = device && getApp(db, device.id, c.req.param("package"));
    if (!device || !app) return message(c, "No such app", "This phone has never had it.", 404, { href: "/", label: "Back to phones" });
    const changes = listChanges(db, { deviceId: device.id, package: app.package, includeSystem: true, limit: 50 });
    return render(
      c,
      <AppPage
        view={view(c)}
        device={device}
        app={app}
        reviews={reviewHistory(db, device.id, app.package)}
        changes={changes}
        rule={phoneRules(device.id).ruleOf(app)}
        history={decisionHistory(db, device.id, app.package)}
        requests={listAppRequests(db, { deviceId: device.id, package: app.package, limit: 20 })}
        message={SAVED[c.req.query("saved") ?? ""]}
      />,
    );
  });

  // ── Rules ──────────────────────────────────────────────────────────

  const policyContext = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });
  const asParent = (c: WebContext) => ({ kind: "parent", parentId: me(c).parent.id }) as const;
  const backTo = (c: WebContext, device: DeviceView, saved: string, section: string) => c.redirect(`/devices/${device.id}?saved=${saved}#${section}`);
  const noPhone = (c: WebContext) => message(c, "No such phone", "It may have been deleted.", 404, { href: "/", label: "Back to phones" });

  app.post("/devices/:id/protect", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    protect(policyContext(), device.id, asParent(c));
    return backTo(c, device, "protected", "rules");
  });

  app.post("/devices/:id/unprotect", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    unprotect(policyContext(), device.id, asParent(c));
    return backTo(c, device, "unprotected", "rules");
  });

  app.post("/devices/:id/new-apps", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const mode = first(body, "mode");
    if (mode !== "ask" && mode !== "allow") return showDevice(c, device, { error: "Choose Ask or Allow for new apps." }, 400);
    // Back to Ask after Allow: the parent chooses which of the apps without a decision keep working.
    const confirmed = first(body, "confirm") === "1";
    if (mode === "ask" && !confirmed) {
      const again = askAgainSummary(db, device.id);
      if (again && (again.installedMeanwhile.length || again.waitingBefore.length)) return render(c, <AskAgainPage view={view(c)} device={device} again={again} />);
    }
    const done = setNewApps(policyContext(), device.id, mode, asParent(c), confirmed ? { allow: all(body, "allow") } : {});
    return backTo(c, device, mode === "allow" ? "new_apps_allow" : done.result.firstTime || !done.changed ? "new_apps_ask" : "new_apps_ask_again", "new-apps");
  });

  // ── Updating Belay (Phase 6): a parent's action only ────────────────

  app.post("/devices/:id/update", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return showDevice(c, device, { error: "This phone is disconnected, so it can't be updated." }, 400);
    const sha256 = first(await form(c), "sha256");
    if (!getAgentFile(db, sha256)) return showDevice(c, device, { error: "Choose a version of Belay that's on the server." }, 400);
    const done = offerAgent(policyContext(), device.id, sha256, asParent(c));
    return backTo(c, device, done.result.notNewerThan === null ? "update_offered" : "update_not_newer", "update");
  });

  app.post("/devices/:id/update/withdraw", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    withdrawOffer(policyContext(), device.id, asParent(c));
    return backTo(c, device, "update_withdrawn", "update");
  });

  // ── Phase 10: removing other users and profiles, a parent's action only ─

  app.post("/devices/:id/remove-other-users", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return showDevice(c, device, { error: "This phone is disconnected, so it wouldn't get that." }, 400);
    const done = issueCommand(policyContext(), device.id, "remove_other_users", asParent(c));
    return backTo(c, device, done.result.already ? "command_waiting" : "command_sent", "users");
  });

  app.post("/devices/:id/before-install/clear", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const pkg = first(body, "package");
    const byAi = first(body, "ai") === "1";
    if (!byAi && !packageName.safeParse(pkg).success) return showDevice(c, device, { error: "Choose an app to clear." }, 400);
    clearPreDecisions(policyContext(), device.id, byAi ? { byAi: true } : { package: pkg }, asParent(c));
    return backTo(c, device, "cleared", "before-install");
  });

  app.post("/devices/:id/decide", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const allow = first(body, "allow");
    const block = first(body, "block");
    const pkg = allow || block;
    if (!pkg || (allow && block) || !packageName.safeParse(pkg).success) return showDevice(c, device, { error: "Choose Allow or Block on one app." }, 400);
    const state = allow ? "allowed" : "blocked";
    const note = first(body, "note");
    if (note.length > LIMITS.decisionNote) return showDevice(c, device, { error: `Keep the note under ${LIMITS.decisionNote} characters.` }, 400);
    decideApp(policyContext(), device.id, pkg, state, asParent(c), { note: note || null });
    if (first(body, "back") === "app") return c.redirect(`/devices/${device.id}/apps/${encodeURIComponent(pkg)}?saved=${state}`);
    return backTo(c, device, state, "apps");
  });

  app.post("/devices/:id/pause", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const minutes = first(body, "minutes");
    const note = first(body, "note");
    if (minutes !== "until" && !PAUSE_MINUTES.has(minutes)) return showDevice(c, device, { error: "Choose how long to pause the phone." }, 400);
    if (note.length > LIMITS.pauseNote) return showDevice(c, device, { error: `Keep the note under ${LIMITS.pauseNote} characters.` }, 400);
    pausePhone(policyContext(), device.id, { minutes: minutes === "until" ? null : Number(minutes), note: note || null }, asParent(c));
    return backTo(c, device, "paused", "pause");
  });

  app.post("/devices/:id/resume", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    resumePhone(policyContext(), device.id, asParent(c));
    return backTo(c, device, "resumed", "pause");
  });

  app.post("/devices/:id/restrictions", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const locks = new Set(all(body, "lock"));
    const rules = getRules(db, device.id);
    if (locks.has("modify_accounts") && !rules.restrictions.modify_accounts && first(body, "accounts_ready") !== "1") {
      return showDevice(c, device, { error: "Add the parent-owned Google account to the phone first, and tick that it's there: once accounts are locked, none can be added." }, 400);
    }
    if (locks.has("sim") && !rules.restrictions.sim && first(body, "sim_ready") !== "1") {
      return showDevice(c, device, { error: "Activate the phone's line first, and tick that it works: once eSIMs are locked, none can be added or downloaded." }, 400);
    }
    const changes = Object.fromEntries([...SAFE_RESTRICTIONS, ...LOCK_RESTRICTIONS].map((r) => [r, locks.has(r)]));
    setRestrictions(policyContext(), device.id, changes, asParent(c));
    return backTo(c, device, "rules", "locks");
  });

  app.post("/devices/:id/hardening", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const factoryReset = first(body, "factory_reset") === "1";
    const debugging = first(body, "debugging") === "1";
    const accounts = accountIds(first(body, "frp_accounts"));
    if (!accounts.ok) return showDevice(c, device, { error: accounts.error }, 400);
    const rules = getRules(db, device.id);
    const tightens =
      (factoryReset && !rules.restrictions.factory_reset) ||
      (debugging && !rules.restrictions.debugging) ||
      (accounts.ids.length > 0 && JSON.stringify(accounts.ids) !== JSON.stringify(rules.frpAccounts));
    if (tightens && first(body, "confirm").toLowerCase() !== device.name.trim().toLowerCase()) {
      return showDevice(c, device, { error: `These can lock the phone for good. To turn them on, type the phone's name, ${device.name}, in the box.` }, 400);
    }
    // Phase 6: turning on a lock that can strand the phone makes its recovery key, in the same request, if it has none to use.
    const locking = (factoryReset && !rules.restrictions.factory_reset) || (debugging && !rules.restrictions.debugging);
    const made = db.transaction(() => {
      setHardening(policyContext(), device.id, { factoryReset, debugging, frpAccounts: accounts.ids }, asParent(c));
      return locking && !usableKey(recoveryState(db, device.id)) ? makePhoneRecoveryKey(policyContext(), device.id, asParent(c)).result : null;
    })();
    if (made) return render(c, <RecoveryKeyPage view={view(c)} device={device} grouped={made.grouped} replaced={made.replaced} because="hardening" />);
    return backTo(c, device, "rules", "hardening");
  });

  app.post("/devices/:id/recovery-key", (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return showDevice(c, device, { error: "This phone is disconnected, so a new key wouldn't reach it." }, 400);
    const made = makePhoneRecoveryKey(policyContext(), device.id, asParent(c)).result;
    return render(c, <RecoveryKeyPage view={view(c)} device={device} grouped={made.grouped} replaced={made.replaced} because="asked" />);
  });

  app.post("/devices/:id/maintenance", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    if (first(body, "end") === "1") {
      setMaintenance(policyContext(), device.id, null, asParent(c));
      return backTo(c, device, "maintenance_off", "maintenance");
    }
    const hours = first(body, "hours");
    if (!MAINTENANCE_HOURS.has(hours)) return showDevice(c, device, { error: "Choose 1, 4 or 24 hours." }, 400);
    setMaintenance(policyContext(), device.id, deps.now() + Number(hours) * 3_600_000, asParent(c));
    return backTo(c, device, "maintenance_on", "maintenance");
  });

  app.post("/devices/:id/web", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    const checked = (name: string) => first(body, name) === "1";
    const filter = first(body, "filter");
    let privateDns: string | null;
    if (filter === "cleanbrowsing" || filter === "adguard") privateDns = DNS_FILTERS[filter].host;
    else if (filter === "off") privateDns = null;
    else if (filter === "custom") {
      privateDns = first(body, "custom_host").toLowerCase().replace(/\.$/, "");
      if (!validHostname(privateDns)) return showDevice(c, device, { error: "Enter the Private DNS host name, like dns.example.org." }, 400);
    } else return showDevice(c, device, { error: "Choose a web filter, or Off." }, 400);
    let chrome: ChromeSettings | null = null;
    if (checked("chrome")) {
      const youtube = first(body, "youtube");
      const allowed = urlPatterns(first(body, "allowlist"));
      const blocked = urlPatterns(first(body, "blocklist"));
      if (youtube !== "off" && youtube !== "moderate" && youtube !== "strict") return showDevice(c, device, { error: "Choose a YouTube setting." }, 400);
      if (!allowed.ok || !blocked.ok) {
        return showDevice(c, device, { error: `List one site per line, without spaces, at most ${LIMITS.maxUrlPatterns} of them.` }, 400);
      }
      chrome = {
        incognito: checked("incognito"),
        safe_search: checked("safe_search"),
        youtube_restrict: youtube,
        safe_sites: checked("safe_sites"),
        allow_downloads: checked("allow_downloads"),
        url_allowlist: checked("allowlist_mode") ? allowed.list : null,
        url_blocklist: blocked.list,
      };
    }
    setWeb(policyContext(), device.id, { privateDns, chrome, hideBrowsers: checked("hide_browsers") }, asParent(c));
    return backTo(c, device, "rules", "web");
  });

  app.post("/devices/:id/support", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const text = first(await form(c), "message");
    if (text.length > LIMITS.supportMessage) return showDevice(c, device, { error: `Keep it under ${LIMITS.supportMessage} characters.` }, 400);
    setSupportMessage(policyContext(), device.id, text || null, asParent(c));
    return backTo(c, device, "rules", "support");
  });

  // ── Requests and proposals ─────────────────────────────────────────

  app.post("/devices/:id/requests/:requestId/answer", async (c) => {
    const device = deviceOr404(c);
    if (!device) return noPhone(c);
    const body = await form(c);
    // "More time": the minutes buttons (15, 30, 60) approve with that many.
    const give = first(body, "give");
    const answer = give ? "approved" : first(body, "answer");
    const note = first(body, "note");
    if (answer !== "approved" && answer !== "declined" && answer !== "talk") return message(c, "Choose an answer", "Approve, Decline or Let's talk.", 400);
    if (give && !(MORE_TIME_CHOICES as readonly number[]).includes(Number(give))) return message(c, "Choose how much time", "15, 30 or 60 minutes.", 400);
    if (note.length > LIMITS.answerNote) return message(c, "That note is too long", `Keep it under ${LIMITS.answerNote} characters.`, 400);
    const done = answerRequest(policyContext(), device.id, c.req.param("requestId"), answer, asParent(c), note || null, give ? { minutes: Number(give) } : {});
    if (!done.result) return message(c, "No such request", "It may have been deleted with its phone.", 404, { href: "/requests", label: "Back to requests" });
    const saved = done.result.kind === "app" ? `answer_${answer}` : done.result.kind === "more_time" && answer === "approved" ? "answer_more_time" : `answer_other_${answer}`;
    const back = first(body, "back");
    if (back === "requests") return c.redirect(`/requests?saved=${saved}`);
    if (back === "app" && done.result.package) return c.redirect(`/devices/${device.id}/apps/${encodeURIComponent(done.result.package)}?saved=${saved}`);
    if (back === "screen-time") return c.redirect(`/devices/${device.id}/screen-time?saved=${saved}`);
    return backTo(c, device, saved, "apps");
  });

  app.get("/requests", (c) => {
    const now = deps.now();
    const phones = listDevices(db, getSettings(db), now).length;
    const known = new Set(
      db
        .prepare<[], { key: string }>("SELECT DISTINCT a.device_id || ' ' || a.package AS key FROM apps a JOIN requests r ON r.device_id = a.device_id AND r.package = a.package")
        .all()
        .map((r) => r.key),
    );
    const limits = new Map<string, Map<string, string>>();
    const limitName = (deviceId: string, limitId: string): string => {
      if (limitId === "*") return "every limit";
      let names = limits.get(deviceId);
      if (!names) {
        names = new Map(screenRules(db, deviceId).rules.limits.map((l) => [l.id, l.name]));
        limits.set(deviceId, names);
      }
      return names.get(limitId) ?? "a limit that's gone";
    };
    return render(
      c,
      <RequestsPage
        view={view(c)}
        requests={recentRequests(db, now, { limit: 200 })}
        phones={phones}
        known={known}
        limitName={limitName}
        message={SAVED[c.req.query("saved") ?? ""]}
      />,
    );
  });

  const proposalsPage = (c: WebContext, extra: { message?: string; error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const now = deps.now();
    const proposals = listProposals(db, { limit: 200 });
    const stale = new Map(
      proposals.flatMap((p) => {
        const why = p.status === "pending" ? outdatedBecause(db, p, now) : null;
        return why ? [[p.id, why] as const] : [];
      }),
    );
    // Phase 3: a screen-time proposal's every change, with the apps' names on its phone.
    const details = new Map(
      proposals.flatMap((p) => (p.change.kind === "screen_time" && p.status === "pending" ? [[p.id, screenTimeWords(p.change, phoneLabels(db, p.deviceId))] as const] : [])),
    );
    return render(
      c,
      <ProposalsPage view={view(c)} proposals={proposals} stale={stale} details={details} message={extra.message ?? SAVED[c.req.query("saved") ?? ""]} error={extra.error} />,
      status,
    );
  };

  app.get("/proposals", (c) => proposalsPage(c));

  app.post("/proposals/:id/approve", async (c) => {
    const note = first(await form(c), "note");
    if (note.length > LIMITS.answerNote) return proposalsPage(c, { error: `Keep the note under ${LIMITS.answerNote} characters.` }, 400);
    let done: ReturnType<typeof approveProposal>;
    try {
      done = approveProposal(policyContext(), c.req.param("id"), me(c).parent.id, note || null);
    } catch (error) {
      if (error instanceof RuleRefused) return proposalsPage(c, { error: `Nothing changed. ${error.message}` }, 400);
      throw error;
    }
    if (!done.ok && done.outdated) return proposalsPage(c, { error: `Nothing changed: that proposal was out of date. ${done.reason}` }, 409);
    if (!done.ok) return proposalsPage(c, { error: done.reason }, 400);
    return c.redirect("/proposals?saved=proposal_approved");
  });

  app.post("/proposals/:id/reject", (c) => {
    const done = rejectProposal(db, deps.now(), c.req.param("id"), me(c).parent.id);
    if (!done.ok) return proposalsPage(c, { error: done.reason }, 400);
    return c.redirect("/proposals?saved=proposal_rejected");
  });

  app.post("/devices/:id/review", async (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404);
    const body = await form(c);
    const packages = all(body, "package").slice(0, 500);
    const note = first(body, "note");
    const now = deps.now();
    const parentId = me(c).parent.id;
    const result = markReviewed(db, now, { deviceId: device.id, packages, note, parentId, via: "web" });
    if (result.marked.length) {
      audit(db, now, { kind: "parent", parentId }, "apps.reviewed", { deviceId: device.id, detail: { apps: result.marked.map((a) => a.label), note: note || undefined } });
    }
    if (first(body, "back") === "app" && packages[0]) return c.redirect(`/devices/${device.id}/apps/${encodeURIComponent(packages[0])}`);
    return c.redirect(`/devices/${device.id}?reviewed=${result.marked.length}`);
  });

  app.post("/devices/:id/rename", async (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404);
    const name = first(await form(c), "name");
    if (!name || name.length > NAME_MAX) return message(c, "Pick a name", `Use 1 to ${NAME_MAX} characters.`, 400);
    if (nameTaken(db, name, device.id)) return message(c, "Pick another name", "Another phone already has that name.", 400);
    renameDevice(db, device.id, name);
    audit(db, deps.now(), { kind: "parent", parentId: me(c).parent.id }, "device.renamed", { deviceId: device.id, detail: { from: device.name, to: name } });
    return c.redirect(`/devices/${device.id}?saved=renamed`);
  });

  app.post("/devices/:id/disconnect", (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404);
    const now = deps.now();
    if (revokeDevice(db, device.id, now)) {
      audit(db, now, { kind: "parent", parentId: me(c).parent.id }, "device.disconnected", { deviceId: device.id, detail: { name: device.name } });
    }
    return c.redirect(`/devices/${device.id}?saved=disconnected`);
  });

  app.post("/devices/:id/delete", (c) => {
    const device = deviceOr404(c);
    if (!device) return c.redirect("/");
    if (!deleteDevice(db, device.id)) return message(c, "Disconnect it first", "Only a disconnected phone can be deleted.", 400);
    audit(db, deps.now(), { kind: "parent", parentId: me(c).parent.id }, "device.deleted", { detail: { name: device.name } });
    return c.redirect("/");
  });

  const codePage = async (c: WebContext, deviceName: string, deviceId: string | null) => {
    const now = deps.now();
    const parentId = me(c).parent.id;
    const made = createEnrollmentCode(db, now, { deviceName, createdBy: parentId, deviceId });
    audit(db, now, { kind: "parent", parentId }, "code.created", { deviceId, detail: { name: deviceName } });
    const link = `belay://enroll?server=${encodeURIComponent(config.publicUrl)}&code=${made.code}`;
    const qrSvg = await QRCode.toString(link, { type: "svg", errorCorrectionLevel: "M", margin: 1 });
    return render(
      c,
      <CodePage view={view(c)} deviceName={deviceName} code={made.code} display={made.display} expiresAt={made.expiresAt} server={config.publicUrl} link={link} qrSvg={qrSvg} reconnect={deviceId !== null} />,
    );
  };

  app.post("/devices/:id/reconnect", (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404);
    return codePage(c, device.name, device.id);
  });

  app.get("/timeline", (c) => {
    const settings = getSettings(db);
    const devices = listDevices(db, settings, deps.now()).map((d) => ({ id: d.id, name: d.name }));
    const filter = { device: c.req.query("device") ?? "", system: c.req.query("system") === "1" };
    const limit = 100;
    const changes = listChanges(db, { deviceId: filter.device || undefined, includeSystem: filter.system, before: c.req.query("before"), limit: limit + 1 });
    const next = changes.length > limit ? (changes[limit - 1]?.cursor ?? null) : null;
    return render(c, <TimelinePage view={view(c)} changes={changes.slice(0, limit)} devices={devices} filter={filter} next={next} />);
  });

  app.get("/add", (c) => render(c, <AddPage view={view(c)} pending={pendingCodes(db, deps.now())} />));

  app.post("/add", async (c) => {
    const name = first(await form(c), "name");
    if (!name || name.length > NAME_MAX) {
      return render(c, <AddPage view={view(c)} pending={pendingCodes(db, deps.now())} error={`Name the phone, in 1 to ${NAME_MAX} characters.`} />, 400);
    }
    if (nameTaken(db, name)) {
      return render(c, <AddPage view={view(c)} pending={pendingCodes(db, deps.now())} error="Another phone already has that name. To reconnect it, use Reconnect on its page." />, 400);
    }
    return codePage(c, name, null);
  });

  app.post("/add/cancel", async (c) => {
    if (cancelCode(db, first(await form(c), "code"))) audit(db, deps.now(), { kind: "parent", parentId: me(c).parent.id }, "code.cancelled");
    return c.redirect("/add");
  });

  const settingsPage = (c: WebContext, extra: { message?: string; error?: string } = {}, status: ContentfulStatusCode = 200) =>
    render(
      c,
      <SettingsPage
        view={view(c)}
        settings={getSettings(db)}
        parents={listParents(db)}
        meId={me(c).parent.id}
        grants={listGrants(db)}
        mcpUrl={`${config.publicUrl}/mcp`}
        push={{ publicKey: vapidKeys(db).publicKey, browsers: listSubscriptions(db, me(c).parent.id) }}
        digest={<DigestCard view={view(c)} digest={getDigest(db)} meId={me(c).parent.id} browsers={listSubscriptions(db, me(c).parent.id).length} />}
        message={extra.message ?? SAVED[c.req.query("saved") ?? ""]}
        error={extra.error}
      />,
      status,
    );

  app.get("/settings", (c) => settingsPage(c));

  app.post("/settings", async (c) => {
    const body = await form(c);
    const timezone = first(body, "timezone");
    const silentHours = Number(first(body, "silent_hours"));
    if (!isValidTimeZone(timezone)) return settingsPage(c, { error: "Pick a timezone from the list, like America/New_York." }, 400);
    if (!Number.isInteger(silentHours) || silentHours < 1 || silentHours > 168) return settingsPage(c, { error: "Use 1 to 168 hours for the silent threshold." }, 400);
    const chosen = new Set(all(body, "ai_scope"));
    const aiScopes = Object.fromEntries(Object.keys(AI_SCOPES).map((k) => [k, chosen.has(k)])) as Record<AiScope, boolean>;
    const before = getSettings(db);
    const after = updateSettings(db, { timezone, silentHours, aiScopes });
    audit(db, deps.now(), { kind: "parent", parentId: me(c).parent.id }, "settings.changed", { detail: { before, after } });
    return c.redirect("/settings?saved=settings");
  });

  app.post("/settings/password", async (c) => {
    const body = await form(c);
    const session = me(c);
    const current = typeof body.current === "string" ? body.current : "";
    const password = typeof body.password === "string" ? body.password : "";
    const repeat = typeof body.repeat === "string" ? body.repeat : "";
    const client = clientAddress(c, config.trustProxy);
    if (!deps.limits.loginPerClient.check(client).ok) return settingsPage(c, { error: "Too many tries. Wait 15 minutes, then try again." }, 429);
    if (!(await checkPassword(db, session.parent.username, current))) {
      deps.limits.loginPerClient.hit(client);
      return settingsPage(c, { error: "Your current password isn't right." }, 400);
    }
    const problem = passwordProblem(password, repeat);
    if (problem) return settingsPage(c, { error: problem }, 400);
    await setPassword(db, session.parent.id, password);
    endAllSessions(db, session.parent.id, session.idHash);
    audit(db, deps.now(), { kind: "parent", parentId: session.parent.id }, "parent.password_changed");
    return c.redirect("/settings?saved=password");
  });

  app.post("/settings/sign-out-everywhere", (c) => {
    const session = me(c);
    endAllSessions(db, session.parent.id);
    cookie.clear(c);
    audit(db, deps.now(), { kind: "parent", parentId: session.parent.id }, "parent.signed_out_everywhere");
    return c.redirect("/login");
  });

  app.post("/settings/invite", (c) => {
    const now = deps.now();
    const parentId = me(c).parent.id;
    const token = createInvite(db, now, parentId);
    audit(db, now, { kind: "parent", parentId }, "parent.invited");
    return render(
      c,
      <ShownOncePage view={view(c)} title="Invite a parent" intro="Send this link to the other parent. It works once, for 7 days." secret={`${config.publicUrl}/invite/${token}`} />,
    );
  });

  app.post("/settings/parents/:id/remove", (c) => {
    const session = me(c);
    const target = getParent(db, c.req.param("id"));
    if (!target || target.id === session.parent.id) return c.redirect("/settings");
    const now = deps.now();
    revokeAllGrants(db, target.id, now);
    if (removeParent(db, target.id)) audit(db, now, { kind: "parent", parentId: session.parent.id }, "parent.removed", { detail: { name: target.name } });
    return c.redirect("/settings?saved=removed");
  });

  app.post("/settings/tokens", async (c) => {
    const name = first(await form(c), "name");
    if (!name || name.length > NAME_MAX) return settingsPage(c, { error: `Name the token, in 1 to ${NAME_MAX} characters.` }, 400);
    const now = deps.now();
    const parentId = me(c).parent.id;
    const { token } = createPersonalToken(db, now, parentId, name, `${config.publicUrl}/mcp`);
    audit(db, now, { kind: "parent", parentId }, "token.created", { detail: { name } });
    return render(
      c,
      <ShownOncePage
        view={view(c)}
        title="Personal access token"
        intro={`Use it as a Bearer token for ${config.publicUrl}/mcp.`}
        secret={token}
        command={`claude mcp add --transport http belay ${config.publicUrl}/mcp --header "Authorization: Bearer ${token}"`}
        after="Belay keeps only a hash of it. Revoke it in Settings when you no longer need it."
      />,
    );
  });

  // ── Notifications (Web Push) ───────────────────────────────────────

  app.post("/settings/push/subscribe", async (c) => {
    const body = await form(c);
    const input = { endpoint: first(body, "endpoint"), p256dh: first(body, "p256dh"), auth: first(body, "auth") };
    const problem = subscriptionProblem(input);
    if (problem) return settingsPage(c, { error: problem }, 400);
    const now = deps.now();
    const parentId = me(c).parent.id;
    const saved = saveSubscription(db, now, parentId, input, browserName(c.req.header("user-agent"), input.endpoint));
    audit(db, now, { kind: "parent", parentId }, "push.subscribed", { detail: { browser: saved.name } });
    return c.redirect("/settings?saved=push_on#notifications");
  });

  app.post("/settings/push/unsubscribe", async (c) => {
    const endpoint = first(await form(c), "endpoint");
    const parentId = me(c).parent.id;
    const removed = endpoint ? removeSubscription(db, parentId, { endpoint }) : null;
    if (removed) audit(db, deps.now(), { kind: "parent", parentId }, "push.unsubscribed", { detail: { browser: removed.name } });
    return c.redirect("/settings?saved=push_off#notifications");
  });

  app.post("/settings/push/:id/remove", (c) => {
    const parentId = me(c).parent.id;
    const removed = removeSubscription(db, parentId, { id: c.req.param("id") });
    if (removed) audit(db, deps.now(), { kind: "parent", parentId }, "push.unsubscribed", { detail: { browser: removed.name } });
    return c.redirect("/settings?saved=push_removed#notifications");
  });

  app.post("/settings/push/test", async (c) => {
    const result = await sendNotice(deps, { title: "Belay", body: "A test notice from Belay's Settings page.", url: "/settings" }, { parentId: me(c).parent.id });
    const message =
      result.sent > 0
        ? `Sent a test notice to ${result.sent} browser${result.sent === 1 ? "" : "s"}.`
        : result.removed > 0
          ? "That browser's push service no longer knows it, so it was removed. Turn notifications on again there."
          : "The test notice didn't go out. Try again in a minute.";
    return settingsPage(c, result.sent > 0 ? { message } : { error: message }, result.sent > 0 ? 200 : 502);
  });

  app.post("/settings/ai/:id/revoke", (c) => {
    const grant = getGrant(db, c.req.param("id"));
    const now = deps.now();
    if (grant && revokeGrant(db, grant.id, now)) {
      audit(db, now, { kind: "parent", parentId: me(c).parent.id }, grant.kind === "pat" ? "token.revoked" : "ai.disconnected", {
        detail: grant.kind === "pat" ? { name: grant.clientName } : { client: grant.clientName },
      });
    }
    return c.redirect("/settings?saved=revoked");
  });

  // Recording a restore drill, and the daily summary's settings (ops/web.ts).
  app.route("/", opsWebRoutes(deps));

  app.get("/activity", (c) => {
    const includeReads = c.req.query("reads") === "1";
    const before = Number(c.req.query("before") ?? "");
    const limit = 200;
    const entries = listAudit(db, { before: Number.isInteger(before) && before > 0 ? before : undefined, limit: limit + 1, includeReads });
    const next = entries.length > limit ? (entries[limit - 1]?.id ?? null) : null;
    return render(c, <ActivityPage view={view(c)} entries={entries.slice(0, limit)} includeReads={includeReads} next={next} />);
  });

  // A change the server refuses (rules too large to send, an app the phone never blocks…) is
  // shown with its reason, on the phone's page when it was one; nothing of it was saved.
  app.onError((err, c) => {
    if (!(err instanceof RuleRefused)) throw err;
    const id = /^\/devices\/([^/]+)\//.exec(c.req.path)?.[1];
    const device = id ? getDevice(db, decodeURIComponent(id), getSettings(db), deps.now()) : null;
    if (device) return showDevice(c, device, { error: err.message }, 400);
    return message(c, "That wasn't saved", err.message, 400);
  });

  return app;
}
