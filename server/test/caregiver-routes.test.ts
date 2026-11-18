/**
 * Phase 12: a caregiver is never a parent, structurally (docs/design/phase12-caregivers.md, "Deny
 * by default"). Every route the server registers, apart from the caregiver's own under /care
 * (pages, forms, the APK upload, personal access tokens, Settings, /mcp, OAuth, the device API),
 * answers a caregiver's credentials exactly as it answers none: in the caregiver's cookie, in the
 * parent's cookie, or as a Bearer token. And the OAuth sign-in and consent screens, the parents'
 * sign-in and MCP refuse a caregiver who tries them. Made-up names only.
 */
import { describe, expect, it, vi } from "vitest";
import { pkceChallenge } from "../src/crypto.js";
import { listGrants } from "../src/oauth/store.js";
import { deviceCall, enrollPhone, get, PASSWORD, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

const CLAUDE_METADATA = "https://claude.ai/oauth/mcp-oauth-client-metadata";
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

function metadataFetch() {
  return vi.fn((url: string | URL | Request, _init?: RequestInit) => {
    const href = url instanceof Request ? url.url : url.toString();
    if (href !== CLAUDE_METADATA) return Promise.resolve(new Response(null, { status: 201 }));
    const body = { client_id: CLAUDE_METADATA, client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
    return Promise.resolve(new Response(JSON.stringify(body), { headers: { "content-type": "application/json", "cache-control": "max-age=300" } }));
  });
}

/** A family with a phone, a help request, and a caregiver who joined, with every capability on. */
async function family() {
  const t = testServer({ fetch: metadataFetch() as unknown as typeof globalThis.fetch });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block Party" })], T0));
  await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", reason: "I missed the bus", asked_at: T0 }] });
  const made = await postForm(t, "/caregivers", { _csrf: sam.csrf, name: "Grandma", phone: [phone.deviceId], can: ["status", "pause", "help", "locate"], until: "2026-11-19T18:00" }, { cookie: sam.cookie });
  const link = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await made.text())?.[1] ?? "";
  const joined = await postForm(t, `/care/join/${link}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD });
  expect(joined.status).toBe(302);
  const careCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const value = careCookie.split("=")[1] ?? "";
  const csrf = /name="_csrf" value="([^"]+)"/.exec(await (await get(t, "/care", careCookie)).text())?.[1] ?? "";
  expect(csrf).not.toBe("");
  const caregiverId = (t.deps.db.prepare("SELECT id FROM caregivers").get() as { id: string }).id;
  return { t, sam, phone, careCookie, value, csrf, caregiverId };
}

/** Every route's path with its parameters filled in from the family's own ids, so a handler would find something. */
function concrete(path: string, ids: { device: string; caregiver: string }): string {
  return path
    .replace(/\/caregivers\/:id/, `/caregivers/${ids.caregiver}`)
    .replace(/:id\b/g, ids.device)
    .replace(/:package\b/g, "com.example.blocks")
    .replace(/:requestId\b/g, "request-0001")
    .replace(/:sha256\b\{[^}]*\}|:sha256\b/g, "0".repeat(64))
    .replace(/:token\b/g, "x".repeat(43))
    .replace(/:category\b/g, "location")
    .replace(/:[A-Za-z]+(\{[^}]*\})?/g, "x");
}

describe("a caregiver's session is no session anywhere but /care", () => {
  it("every other route answers it exactly as it answers none: cookie, parent's cookie, or Bearer token", async () => {
    const f = await family();
    const routes = [
      ...new Map(
        f.t.app.routes
          .filter((r) => !/^\/care(\/|$)/.test(r.path) && !r.path.includes("*"))
          .flatMap((r) => (r.method === "ALL" ? ["GET", "POST"] : [r.method]).map((method) => [`${method} ${r.path}`, { method, path: r.path }] as const)),
      ).values(),
    ];
    // The walk covers them all: pages, forms, uploads, tokens, MCP, OAuth and the device API.
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const must of [
      "GET /",
      "GET /devices/:id",
      "POST /devices/:id/pause",
      "POST /devices/:id/resume",
      "POST /devices/:id/update/add",
      "POST /settings/tokens",
      "GET /activity",
      "GET /requests",
      "GET /caregivers",
      "POST /caregivers",
      "GET /mcp",
      "POST /mcp",
      "GET /oauth/authorize",
      "POST /oauth/authorize",
      "POST /oauth/token",
      "POST /api/v1/checkin",
      "GET /api/v1/policy",
    ]) {
      expect(paths, must).toContain(must);
    }
    expect(routes.length).toBeGreaterThan(80);

    let n = 0;
    const call = (method: string, path: string, headers: Record<string, string>) => {
      n++;
      // A new address each time, so no sign-in or registration limit makes two answers differ.
      const base = { "x-forwarded-for": `198.51.100.${n % 250}`, origin: "https://belay.example.org", ...headers };
      if (method === "GET") return f.t.app.request(path, { headers: base });
      return f.t.app.request(path, {
        method,
        headers: { "content-type": "application/x-www-form-urlencoded", ...base },
        body: new URLSearchParams({ _csrf: f.csrf, minutes: "30", lock: "1", name: "Coach Lee", phone: f.phone.deviceId, can: "status", until: "2026-11-19T18:00" }),
      });
    };
    const answer = (res: Response) => ({ status: res.status, location: res.headers.get("location") });
    let signInFirst = 0;
    for (const { method, path: template } of routes) {
      const path = concrete(template, { device: f.phone.deviceId, caregiver: f.caregiverId });
      const none = answer(await call(method, path, {}));
      if ((none.status === 302 && none.location?.startsWith("/login?next=")) || none.status === 401) signInFirst++;
      const asCaregiver = answer(await call(method, path, { cookie: f.careCookie }));
      const asParentCookie = answer(await call(method, path, { cookie: `__Host-belay=${f.value}` }));
      expect(asCaregiver, `${method} ${path} with the caregiver's cookie`).toEqual(none);
      expect(asParentCookie, `${method} ${path} with the caregiver's session in the parent's cookie`).toEqual(none);
      // As a Bearer token: only what answers anyone (a page to sign in, the server's health, the web
      // app's files) answers it, and every device API call but enrolling (a code, never a token) and
      // MCP refuse it. (The OAuth token endpoint refuses any Authorization header: public clients only.)
      const bearer = answer(await call(method, path, { authorization: `Bearer ${f.value}` }));
      if (bearer.status < 300) expect(none.status, `${method} ${path} with the caregiver's session as a Bearer token`).toBeLessThan(300);
      if (path === "/mcp" || (path.startsWith("/api/v1/") && path !== "/api/v1/enroll")) expect(bearer.status, `${method} ${path}`).toBe(401);
    }
    // Most of them need a parent's sign-in (or a phone's token) first, and the caregiver's answer was that too.
    expect(signInFirst).toBeGreaterThan(routes.length * 0.8);
    // Nothing a caregiver sent changed anything a parent keeps.
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregivers").get()).toEqual({ n: 1 });
    expect(f.t.deps.db.prepare("SELECT paused FROM policies WHERE device_id = ?").get(f.phone.deviceId)).toEqual({ paused: 0 });
    expect(listGrants(f.t.deps.db)).toEqual([]);
  });

  it("the parents' sign-in, the OAuth sign-in and consent, and MCP refuse a caregiver", async () => {
    const f = await family();
    // The parents' sign-in doesn't know a caregiver's username.
    expect((await postForm(f.t, "/login", { username: "grandma", password: PASSWORD })).status).toBe(401);
    // OAuth: the caregiver's session isn't signed in there, their password doesn't sign in, and no code is made.
    const params = {
      client_id: CLAUDE_METADATA,
      redirect_uri: CLAUDE_CALLBACK,
      response_type: "code",
      state: "state-123",
      code_challenge: pkceChallenge("v".repeat(50)),
      code_challenge_method: "S256",
      resource: "https://belay.example.org/mcp",
      scope: "belay",
    };
    const page = await f.t.app.request(`/oauth/authorize?${new URLSearchParams(params).toString()}`, { headers: { cookie: `${f.careCookie}; __Host-belay=${f.value}` } });
    const html = await page.text();
    expect(html).toContain("Sign in to connect");
    expect(html).not.toContain("Connect to Belay?");
    const signIn = await postForm(f.t, "/oauth/authorize", { ...params, username: "grandma", password: PASSWORD });
    expect(signIn.status).toBe(401);
    const approve = await postForm(f.t, "/oauth/authorize", { ...params, _csrf: f.csrf, decision: "approve" }, { cookie: `${f.careCookie}; __Host-belay=${f.value}` });
    expect(approve.status).toBe(200);
    expect(approve.headers.get("location")).toBeNull();
    expect(await approve.text()).toContain("Sign in again to approve");
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM oauth_codes").get()).toEqual({ n: 0 });
    // MCP takes no caregiver session as a token.
    const mcp = await f.t.app.request("/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${f.value}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(401);
  });

  it("every caregiver route answers a parent's session exactly as it answers none: in the parent's cookie or the caregiver's", async () => {
    const f = await family();
    const parentValue = f.sam.cookie.split("=").slice(1).join("=");
    const routes = [
      ...new Map(
        f.t.app.routes
          .filter((r) => /^\/care(\/|$)/.test(r.path) && !r.path.includes("*"))
          .flatMap((r) => (r.method === "ALL" ? ["GET", "POST"] : [r.method]).map((method) => [`${method} ${r.path}`, { method, path: r.path }] as const)),
      ).values(),
    ];
    const paths = routes.map((r) => `${r.method} ${r.path}`);
    for (const must of ["GET /care", "GET /care/login", "POST /care/phones/:id/pause", "POST /care/phones/:id/locate", "GET /care/phones/:id/checks/:command", "POST /care/push/subscribe"]) {
      expect(paths, must).toContain(must);
    }
    let n = 0;
    const call = (method: string, path: string, cookie?: string) => {
      n++;
      const headers = { "x-forwarded-for": `203.0.113.${n % 250}`, origin: "https://belay.example.org", ...(cookie ? { cookie } : {}) };
      if (method === "GET") return f.t.app.request(path, { headers });
      return f.t.app.request(path, {
        method,
        headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
        body: new URLSearchParams({ _csrf: f.sam.csrf, minutes: "30", lock: "1", endpoint: "https://fcm.googleapis.com/fcm/send/x", p256dh: "x", auth: "x" }),
      });
    };
    const answer = async (res: Response | Promise<Response>) => {
      const r = await res;
      return { status: r.status, location: r.headers.get("location") };
    };
    for (const { method, path: template } of routes) {
      const path = concrete(template, { device: f.phone.deviceId, caregiver: f.caregiverId });
      const none = await answer(call(method, path));
      expect(await answer(call(method, path, f.sam.cookie)), `${method} ${path} with the parent's cookie`).toEqual(none);
      expect(await answer(call(method, path, `__Host-belay_care=${parentValue}`)), `${method} ${path} with the parent's session in the caregiver's cookie`).toEqual(none);
    }
    // Nothing a parent's session sent there paused the phone or turned notifications on.
    expect(f.t.deps.db.prepare("SELECT paused FROM policies WHERE device_id = ?").get(f.phone.deviceId)).toEqual({ paused: 0 });
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_push").get()).toEqual({ n: 0 });
  });

  it("a parent's session gets nothing on the caregiver pages: it isn't a caregiver's", async () => {
    const f = await family();
    expect((await get(f.t, "/care", f.sam.cookie)).headers.get("location")).toBe("/care/login?next=%2Fcare");
    const res = await postForm(f.t, `/care/phones/${f.phone.deviceId}/pause`, { _csrf: f.sam.csrf, minutes: "30" }, { cookie: f.sam.cookie });
    expect(res.status).toBe(401);
    // An unknown caregiver path is the caregiver pages' own answer, never a parent page's.
    expect((await get(f.t, "/care/settings", f.careCookie)).status).toBe(404);
    expect((await get(f.t, "/care/settings")).headers.get("location")).toBe("/care/login?next=%2Fcare%2Fsettings");
  });
});
