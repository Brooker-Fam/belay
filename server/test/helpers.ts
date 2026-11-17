/** A server with an in-memory database, a clock the test moves, and no network. Made-up data only. */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto";
import { createApp } from "../src/app.js";
import { createParent, createSession } from "../src/auth/parents.js";
import { testConfig, type Config } from "../src/config.js";
import { openDatabase } from "../src/db.js";
import { makeDeps, type Deps } from "../src/deps.js";
import { createEnrollmentCode } from "../src/device/enroll.js";
import type { Device, Event, Fix, Package } from "../src/device/schemas.js";
import { saveSubscription } from "../src/push.js";

export const T0 = Date.UTC(2026, 10, 16, 15, 0, 0); // Mon Nov 16 2026, 10:00 in New York

export interface TestServer {
  app: ReturnType<typeof createApp>;
  deps: Deps;
  now(): number;
  advance(ms: number): void;
  logs: string[];
}

export function testServer(opts: { config?: Partial<Config>; fetch?: typeof fetch; locateWaitMs?: number } = {}): TestServer {
  let clock = T0;
  const logs: string[] = [];
  const db = openDatabase(":memory:");
  const deps = makeDeps(testConfig(opts.config), db, {
    now: () => clock,
    log: (m) => logs.push(m),
    fetch:
      opts.fetch ??
      (() => {
        throw new Error("no network in tests");
      }),
    // A check waits a minute for its fix on a real server; tests that time out don't.
    locateWaitMs: opts.locateWaitMs ?? 200,
  });
  return {
    app: createApp(deps),
    deps,
    now: () => clock,
    advance: (ms) => {
      clock += ms;
    },
    logs,
  };
}

export function device(overrides: Partial<Device> = {}, health: Partial<Device["health"]> = {}): Device {
  return {
    manufacturer: "Google",
    model: "Pixel 8",
    android_release: "17",
    sdk: 37,
    sdk_full: "37.2",
    security_patch: "2026-11-05",
    agent_version_name: "0.1.0",
    agent_version_code: 2,
    boot_count: 12,
    last_boot_at: T0 - 3_600_000,
    timezone: "America/New_York",
    device_time: T0,
    battery_percent: 81,
    charging: false,
    storage_free_bytes: 64e9,
    storage_total_bytes: 128e9,
    health: {
      device_owner: true,
      uninstall_blocked: true,
      battery_exempt: true,
      usage_access: true,
      notifications_shown: true,
      permissions: [{ name: "POST_NOTIFICATIONS", granted: true, fixed_by_policy: true }],
      standby_bucket: 5,
      background_restricted: false,
      service_running: true,
      test_only: false,
      ...health,
    },
    ...overrides,
  };
}

export function pkg(name: string, overrides: Partial<Package> = {}): Package {
  return {
    package: name,
    label: name.split(".").at(-1) ?? name,
    version_name: "1.0",
    version_code: 10,
    first_install_time: T0 - 86_400_000,
    last_update_time: T0 - 86_400_000,
    system: false,
    updated_system: false,
    enabled: true,
    launchable: true,
    target_sdk: 36,
    category: -1,
    source: "play_store",
    installer: { installing: "com.android.vending", initiating: "com.android.vending", update_owner: "com.android.vending" },
    permissions: [],
    ...overrides,
  };
}

let eventCounter = 0;
export function event(kind: Event["kind"], pkgName: string, overrides: Partial<Event> = {}): Event {
  eventCounter++;
  return {
    id: `event-${String(eventCounter).padStart(4, "0")}-${kind}`,
    kind,
    package: pkgName,
    label: pkgName.split(".").at(-1) ?? pkgName,
    detected_at: T0,
    detection: "broadcast",
    ...overrides,
  };
}

let snapshotCounter = 0;
export function snapshot(packages: Package[], takenAt: number, overrides: Record<string, unknown> = {}) {
  snapshotCounter++;
  return { snapshot_id: `snapshot-${String(snapshotCounter).padStart(4, "0")}`, taken_at: takenAt, boot_count: 12, device: device(), packages, ...overrides };
}

export async function post(t: TestServer, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return t.app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

export function deviceCall(t: TestServer, token: string, path: string, body: unknown): Promise<Response> {
  return post(t, `/api/v1/${path}`, body, { authorization: `Bearer ${token}` });
}

export async function enrollPhone(t: TestServer, name = "Test phone"): Promise<{ token: string; deviceId: string }> {
  const { code } = createEnrollmentCode(t.deps.db, t.now(), { deviceName: name, createdBy: null });
  const res = await post(t, "/api/v1/enroll", { code, device: device() });
  if (res.status !== 200) throw new Error(`enroll failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { token: string; device_id: string };
  return { token: body.token, deviceId: body.device_id };
}

export interface EventRow {
  id: string;
  kind: string;
  package: string;
  detection: string;
  backfilled: number;
  from_code: number | null;
  to_code: number | null;
}

export function events(t: TestServer, deviceId: string): EventRow[] {
  return t.deps.db
    .prepare<[string], EventRow>(
      "SELECT id, kind, package, detection, backfilled, from_code, to_code FROM app_events WHERE device_id = ? ORDER BY received_at, rowid",
    )
    .all(deviceId);
}

export function appState(t: TestServer, deviceId: string, name: string) {
  return t.deps.db
    .prepare<[string, string], { present: number; version_code: number; install_seen_at: number; permissions: string; source: string; details_known: number }>(
      "SELECT present, version_code, install_seen_at, permissions, source, details_known FROM apps WHERE device_id = ? AND package = ?",
    )
    .get(deviceId, name);
}

// ── Phase 4: fixes (made-up places, nowhere real) ──────────────────────

/** A made-up point: a field in the middle of nowhere in particular. */
export const SPOT = { lat: 40.1, lng: -73.2 };

let fixCounter = 0;
export function fix(overrides: Partial<Fix> = {}): Fix {
  fixCounter++;
  return {
    id: `fix-${String(fixCounter).padStart(5, "0")}`,
    at: T0,
    lat: SPOT.lat,
    lng: SPOT.lng,
    accuracy_m: 20,
    provider: "gps",
    reason: "periodic",
    mock: false,
    ...overrides,
  };
}

/** A point `meters` north of `from` (a degree of latitude is about 111.2 km). */
export const north = (from: { lat: number; lng: number }, meters: number) => ({ lat: from.lat + meters / 111_195, lng: from.lng });

// ── Notices to a parent's browser ───────────────────────────────────────

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");

/** The browser's side of RFC 8291, as in push.test.ts. */
function decrypt(message: Buffer, browser: ECDH, auth: Buffer): string {
  const salt = message.subarray(0, 16);
  const idLength = message[20] ?? 0;
  const senderPublic = message.subarray(21, 21 + idLength);
  const sealed = message.subarray(21 + idLength);
  const prkKey = hmac(auth, browser.computeSecret(senderPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), browser.getPublicKey(), senderPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0, 1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0, 1])])).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  let end = padded.length - 1;
  while (padded[end] === 0) end--;
  return padded.subarray(0, end).toString("utf8");
}

/**
 * A browser a parent turned notifications on in, and what the server pushed to it: each notice
 * decrypted as the browser would, with the push's headers.
 */
export function browserFor(t: TestServer, parentId: string, fetchCalls: () => [url: string | URL | Request, init?: RequestInit][]) {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(6).toString("hex")}`;
  saveSubscription(t.deps.db, t.now(), parentId, { endpoint, p256dh: b64(keys.getPublicKey()), auth: b64(auth) }, "Chrome on Android");
  return {
    notices: (): { title: string; body: string; url: string; urgent?: boolean; urgency: string }[] =>
      fetchCalls()
        .filter(([url]) => (typeof url === "string" ? url : url instanceof URL ? url.href : url.url) === endpoint)
        .map(([, init]) => {
        const body = init?.body as Uint8Array;
        const headers = (init?.headers ?? {}) as Record<string, string>;
        return { ...(JSON.parse(decrypt(Buffer.from(body), keys, auth)) as { title: string; body: string; url: string; urgent?: boolean }), urgency: headers.urgency ?? "" };
      }),
  };
}

// ── The parent pages ────────────────────────────────────────────────────

export const ORIGIN = "https://belay.example.org";
export const PASSWORD = "correct horse battery staple";

/** A parent with a signed-in session: the cookie and the session's CSRF token. */
export async function signIn(t: TestServer, username = "sam", name = "Sam") {
  const parent = await createParent(t.deps.db, t.now(), { name, username, password: PASSWORD });
  const session = createSession(t.deps.db, t.now(), parent.id);
  return { parent, cookie: `__Host-belay=${session.cookie}`, csrf: session.csrf };
}

export function get(t: TestServer, path: string, cookie?: string) {
  return t.app.request(path, { headers: cookie ? { cookie } : {} });
}

export function postForm(
  t: TestServer,
  path: string,
  fields: Record<string, string | string[]>,
  opts: { cookie?: string; origin?: string | null; headers?: Record<string, string> } = {},
) {
  const body = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) body.append(k, one);
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", "x-forwarded-for": "203.0.113.9", ...opts.headers };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.origin !== null) headers.origin = opts.origin ?? ORIGIN;
  return t.app.request(path, { method: "POST", headers, body });
}
