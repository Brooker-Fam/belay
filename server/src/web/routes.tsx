/** The parent pages: server-rendered, no SPA, working without JavaScript. */
import { type Context, Hono } from "hono";
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
import { getApp, listApps, listChanges, markReviewed, reviewHistory, appCounts } from "../family/apps.js";
import { deleteDevice, getDevice, listDevices, nameTaken, renameDevice, revokeDevice } from "../family/devices.js";
import { clientAddress, type Bindings } from "../http.js";
import { createPersonalToken, getGrant, listGrants, revokeAllGrants, revokeGrant } from "../oauth/store.js";
import { AI_SCOPES, type AiScope, getSettings, updateSettings } from "../settings.js";
import { isValidTimeZone } from "../time.js";
import type { Assets } from "./assets.js";
import { ActivityPage } from "./pages/activity.js";
import { AddPage, CodePage } from "./pages/add.js";
import { InvitePage, LoginPage, MessagePage, SetupPage } from "./pages/auth.js";
import { AppPage, DevicePage, DevicesPage } from "./pages/devices.js";
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
};

/** Security headers for every page. `formAction` widens form-action for the OAuth consent page. */
export function pageHeaders(c: Context, formAction = "'self'"): void {
  c.header(
    "Content-Security-Policy",
    `default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
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
    return { parentName: session?.parent.name ?? null, csrf: session?.csrf ?? "", tz: getSettings(db).timezone, now: deps.now(), path: c.req.path, assets: assets.urls };
  };
  const message = (c: WebContext, title: string, text: string, status: ContentfulStatusCode = 200, link?: { href: string; label: string }) =>
    render(c, <MessagePage view={view(c)} title={title} message={text} link={link} />, status);

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
    const devices = listDevices(db, settings, now).map((device) => ({ device, ...appCounts(db, device.id) }));
    const pending = pendingCodes(db, now).filter((p) => !p.deviceId);
    if (devices.length === 0 && pending.length === 0) return c.redirect("/add");
    return render(c, <DevicesPage view={view(c)} devices={devices} pending={pending} />);
  });

  const deviceOr404 = (c: WebContext) => getDevice(db, c.req.param("id") ?? "", getSettings(db), deps.now());

  app.get("/devices/:id", (c) => {
    const device = deviceOr404(c);
    if (!device) return message(c, "No such phone", "It may have been deleted.", 404, { href: "/", label: "Back to phones" });
    const filter = { q: c.req.query("q") ?? "", system: c.req.query("system") === "1", permission: c.req.query("permission") ?? "" };
    const apps = listApps(db, device.id, { query: filter.q, includeSystem: filter.system, permission: filter.permission || undefined });
    // Apps to review first.
    apps.sort((a, b) => Number(!!b.unreviewed) - Number(!!a.unreviewed));
    const reviewed = Number(c.req.query("reviewed") ?? "");
    const saved = c.req.query("saved");
    const note = Number.isInteger(reviewed) && reviewed > 0 ? `Marked ${reviewed} app${reviewed === 1 ? "" : "s"} reviewed.` : saved ? SAVED[saved] : undefined;
    return render(c, <DevicePage view={view(c)} device={device} apps={apps} filter={filter} message={note} />);
  });

  app.get("/devices/:id/apps/:package", (c) => {
    const device = deviceOr404(c);
    const app = device && getApp(db, device.id, c.req.param("package"));
    if (!device || !app) return message(c, "No such app", "This phone has never had it.", 404, { href: "/", label: "Back to phones" });
    const changes = listChanges(db, { deviceId: device.id, package: app.package, includeSystem: true, limit: 50 });
    return render(c, <AppPage view={view(c)} device={device} app={app} reviews={reviewHistory(db, device.id, app.package)} changes={changes} />);
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

  app.get("/activity", (c) => {
    const includeReads = c.req.query("reads") === "1";
    const before = Number(c.req.query("before") ?? "");
    const limit = 200;
    const entries = listAudit(db, { before: Number.isInteger(before) && before > 0 ? before : undefined, limit: limit + 1, includeReads });
    const next = entries.length > limit ? (entries[limit - 1]?.id ?? null) : null;
    return render(c, <ActivityPage view={view(c)} entries={entries.slice(0, limit)} includeReads={includeReads} next={next} />);
  });

  return app;
}
