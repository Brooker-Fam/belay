/**
 * Web Push notices to the parents' own browsers (RFC 8030), with Node's crypto only.
 *
 * Each notice is encrypted to the browser (RFC 8291, aes128gcm), so the push service carries
 * it but can't read it. Each request is signed with the server's VAPID key (RFC 8292), made
 * once and kept in the database: the private key never leaves the server. A push service
 * sees the browser's endpoint, when and how much is sent, the VAPID public key, and the
 * token's claims: its own origin, an expiry, and BELAY_PUBLIC_URL.
 *
 * The server only sends to endpoints at the known push services (checked when a browser
 * subscribes and again when sending) and never follows a redirect, so a subscription can't
 * point the server anywhere else.
 */
import { createCipheriv, createECDH, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign, type JsonWebKey, type KeyObject } from "node:crypto";
import { newId } from "./crypto.js";
import type { DB } from "./db.js";
import type { Deps } from "./deps.js";
import { oneLine } from "./text.js";

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");
const unb64 = (text: string): Buffer => Buffer.from(text, "base64url");
const BASE64URL = /^[A-Za-z0-9_-]+={0,2}$/;

// ── VAPID keys ──────────────────────────────────────────────────────────

export interface VapidKeys {
  /** As browsers take it (applicationServerKey): the uncompressed P-256 point, base64url. */
  publicKey: string;
  privateKey: KeyObject;
}

function keysFrom(jwk: JsonWebKey): VapidKeys {
  const privateKey = createPrivateKey({ key: jwk, format: "jwk" });
  const pub = createPublicKey(privateKey).export({ format: "jwk" });
  if (!pub.x || !pub.y) throw new Error("The VAPID key has no public point");
  return { publicKey: b64(Buffer.concat([Buffer.from([4]), unb64(pub.x), unb64(pub.y)])), privateKey };
}

const keyCache = new WeakMap<DB, VapidKeys>();

/** The server's VAPID key pair, made the first time it's needed. */
export function vapidKeys(db: DB): VapidKeys {
  const cached = keyCache.get(db);
  if (cached) return cached;
  const read = (): VapidKeys | null => {
    const row = db.prepare<[], { value: string }>("SELECT value FROM settings WHERE key = 'vapid'").get();
    return row ? keysFrom((JSON.parse(row.value) as { jwk: JsonWebKey }).jwk) : null;
  };
  let keys = read();
  if (!keys) {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
    db.prepare("INSERT INTO settings (key, value) VALUES ('vapid', ?) ON CONFLICT (key) DO NOTHING").run(JSON.stringify({ jwk: privateKey.export({ format: "jwk" }) }));
    keys = read();
  }
  if (!keys) throw new Error("Couldn't keep the VAPID key");
  keyCache.set(db, keys);
  return keys;
}

/** RFC 8292: lasts 12 hours (push services refuse more than 24). */
export const VAPID_EXPIRY_SECONDS = 12 * 3600;

/** An ES256 JWT for one push service (`audience`: its origin), naming the server as `subject`. */
export function vapidJwt(keys: VapidKeys, audience: string, subject: string, nowMs: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${part({ typ: "JWT", alg: "ES256" })}.${part({ aud: audience, exp: Math.floor(nowMs / 1000) + VAPID_EXPIRY_SECONDS, sub: subject })}`;
  const signature = sign("sha256", Buffer.from(unsigned), { key: keys.privateKey, dsaEncoding: "ieee-p1363" });
  return `${unsigned}.${b64(signature)}`;
}

// ── RFC 8291 encryption ─────────────────────────────────────────────────

const RECORD_SIZE = 4096;
const hmac = (key: Uint8Array, data: Uint8Array): Buffer => createHmac("sha256", key).update(data).digest();
const info = (label: string): Buffer => Buffer.concat([Buffer.from(`Content-Encoding: ${label}`, "latin1"), Buffer.from([0, 1])]);

/**
 * Encrypts a notice to one browser (RFC 8291, with RFC 8188's aes128gcm in one record).
 * `fixed` sets the sender's key and the salt, for RFC 8291's example; otherwise both are new
 * each time.
 */
export function encryptPayload(plaintext: Uint8Array, uaPublic: Uint8Array, authSecret: Uint8Array, fixed?: { senderPrivate: Uint8Array; salt: Uint8Array }): Buffer {
  if (plaintext.length > RECORD_SIZE - 17) throw new Error("The notice is too long for one record");
  const sender = createECDH("prime256v1");
  if (fixed) sender.setPrivateKey(fixed.senderPrivate);
  else sender.generateKeys();
  const asPublic = sender.getPublicKey();
  const ecdhSecret = sender.computeSecret(uaPublic);
  const prkKey = hmac(authSecret, ecdhSecret);
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info", "latin1"), Buffer.from([0]), uaPublic, asPublic, Buffer.from([1])]));
  const salt = fixed ? Buffer.from(fixed.salt) : randomBytes(16);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, info("aes128gcm")).subarray(0, 16);
  const nonce = hmac(prk, info("nonce")).subarray(0, 12);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  // The last (and only) record ends with the 0x02 delimiter.
  const sealed = Buffer.concat([cipher.update(Buffer.concat([plaintext, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header.writeUInt8(asPublic.length, 20);
  return Buffer.concat([header, asPublic, sealed]);
}

// ── Push services ───────────────────────────────────────────────────────

const PUSH_HOSTS = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
const PUSH_DOMAINS = ["push.apple.com", "notify.windows.com"];

/** An https endpoint at a known push service (Google, Mozilla, Apple, Microsoft), on the default port. */
export function allowedEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2048) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port !== "") return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || PUSH_DOMAINS.some((domain) => host.endsWith(`.${domain}`));
}

// ── Subscriptions ───────────────────────────────────────────────────────

export interface PushSubscription {
  id: string;
  parentId: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  createdAt: number;
  lastSentAt: number | null;
}

interface SubscriptionRow {
  id: string;
  parent_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  name: string;
  created_at: number;
  last_sent_at: number | null;
}

const toSubscription = (r: SubscriptionRow): PushSubscription => ({
  id: r.id,
  parentId: r.parent_id,
  endpoint: r.endpoint,
  p256dh: r.p256dh,
  auth: r.auth,
  name: r.name,
  createdAt: r.created_at,
  lastSentAt: r.last_sent_at,
});

export interface SubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Why a browser's subscription won't do, or null. The key must be a point on P-256 (RFC 8291). */
export function subscriptionProblem(input: SubscriptionInput): string | null {
  if (!allowedEndpoint(input.endpoint)) return "That browser's push service isn't one Belay sends notices to.";
  if (!BASE64URL.test(input.p256dh) || !BASE64URL.test(input.auth)) return "The browser's keys aren't valid.";
  const key = unb64(input.p256dh);
  if (key.length !== 65 || key[0] !== 4 || unb64(input.auth).length !== 16) return "The browser's keys aren't valid.";
  try {
    createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(key.subarray(1, 33)), y: b64(key.subarray(33)) }, format: "jwk" });
  } catch {
    return "The browser's keys aren't valid.";
  }
  return null;
}

const MAX_PER_PARENT = 20;

/** Saves a browser for a parent (once per endpoint), keeping each parent's 20 newest. */
export function saveSubscription(db: DB, now: number, parentId: string, input: SubscriptionInput, name: string): PushSubscription {
  return db.transaction(() => {
    const existing = db.prepare<[string], { id: string }>("SELECT id FROM push_subscriptions WHERE endpoint = ?").get(input.endpoint);
    const id = existing?.id ?? newId();
    if (existing) {
      db.prepare("UPDATE push_subscriptions SET parent_id = ?, p256dh = ?, auth = ?, name = ? WHERE id = ?").run(parentId, input.p256dh, input.auth, name, id);
    } else {
      db.prepare("INSERT INTO push_subscriptions (id, parent_id, endpoint, p256dh, auth, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        id,
        parentId,
        input.endpoint,
        input.p256dh,
        input.auth,
        name,
        now,
      );
    }
    db.prepare(
      `DELETE FROM push_subscriptions WHERE parent_id = ? AND id NOT IN
         (SELECT id FROM push_subscriptions WHERE parent_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?)`,
    ).run(parentId, parentId, MAX_PER_PARENT);
    const row = db.prepare<[string], SubscriptionRow>("SELECT * FROM push_subscriptions WHERE id = ?").get(id);
    if (!row) throw new Error("subscription vanished");
    return toSubscription(row);
  }).immediate();
}

export function listSubscriptions(db: DB, parentId?: string): PushSubscription[] {
  const rows = parentId
    ? db.prepare<[string], SubscriptionRow>("SELECT * FROM push_subscriptions WHERE parent_id = ? ORDER BY created_at, rowid").all(parentId)
    : db.prepare<[], SubscriptionRow>("SELECT * FROM push_subscriptions ORDER BY created_at, rowid").all();
  return rows.map(toSubscription);
}

/** Removes one of a parent's browsers, by its id or its endpoint. */
export function removeSubscription(db: DB, parentId: string, which: { id: string } | { endpoint: string }): PushSubscription | null {
  const row =
    "id" in which
      ? db.prepare<[string, string], SubscriptionRow>("SELECT * FROM push_subscriptions WHERE id = ? AND parent_id = ?").get(which.id, parentId)
      : db.prepare<[string, string], SubscriptionRow>("SELECT * FROM push_subscriptions WHERE endpoint = ? AND parent_id = ?").get(which.endpoint, parentId);
  if (!row) return null;
  db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(row.id);
  return toSubscription(row);
}

/** "Safari on iPhone", from the browser's User-Agent and its push service, for Settings. */
export function browserName(userAgent: string | undefined, endpoint: string): string {
  const ua = userAgent ?? "";
  const host = (() => {
    try {
      return new URL(endpoint).hostname;
    } catch {
      return "";
    }
  })();
  const os = /iPhone/.test(ua)
    ? "iPhone"
    : /iPad/.test(ua)
      ? "iPad"
      : /Android/.test(ua)
        ? "Android"
        : /CrOS/.test(ua)
          ? "a Chromebook"
          : /Macintosh|Mac OS X/.test(ua)
            ? "a Mac"
            : /Windows/.test(ua)
              ? "Windows"
              : /Linux/.test(ua)
                ? "Linux"
                : null;
  const byHost = host.endsWith("apple.com") ? "Safari" : host.endsWith("mozilla.com") ? "Firefox" : host.endsWith("windows.com") ? "Edge" : "Chrome";
  const browser = /Edg\//.test(ua) ? "Edge" : /Firefox\/|FxiOS/.test(ua) ? "Firefox" : /Chrome\/|CriOS/.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : byHost;
  return os ? `${browser} on ${os}` : browser;
}

// ── Sending ─────────────────────────────────────────────────────────────

/**
 * What the service worker shows: a title, a line, and the parent page to open on a tap. An urgent
 * one (the kid's "I need help") goes with Web Push's high urgency, and stays on the screen until
 * the parent acts on it.
 */
export interface Notice {
  title: string;
  body: string;
  url: "/" | "/requests" | "/requests#help" | "/proposals" | "/settings" | `/devices/${string}`;
  urgent?: boolean;
}

export interface SendResult {
  sent: number;
  /** Browsers the push service no longer knows (404, 410): their subscriptions are deleted. */
  removed: number;
  failed: number;
}

const TIMEOUT_MS = 5000;
const TTL_SECONDS = 24 * 3600;

/** Sends a notice to every parent's browsers, or one parent's. Nothing is sent when nobody subscribed. */
export async function sendNotice(deps: Deps, notice: Notice, opts: { parentId?: string } = {}): Promise<SendResult> {
  const result: SendResult = { sent: 0, removed: 0, failed: 0 };
  const subscriptions = listSubscriptions(deps.db, opts.parentId);
  if (!subscriptions.length) return result;
  const keys = vapidKeys(deps.db);
  const payload = Buffer.from(JSON.stringify(notice), "utf8");
  const forget = (id: string) => {
    deps.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id);
    result.removed++;
  };
  await Promise.all(
    subscriptions.map(async (s) => {
      if (!allowedEndpoint(s.endpoint)) {
        forget(s.id);
        return;
      }
      try {
        const body = encryptPayload(payload, unb64(s.p256dh), unb64(s.auth));
        const jwt = vapidJwt(keys, new URL(s.endpoint).origin, deps.config.publicUrl, deps.now());
        const response = await deps.fetch(s.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/octet-stream",
            "content-encoding": "aes128gcm",
            ttl: String(TTL_SECONDS),
            urgency: notice.urgent === true ? "high" : "normal",
            authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
          },
          body: new Uint8Array(body),
          redirect: "error",
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        void response.body?.cancel().catch(() => undefined);
        if (response.status === 404 || response.status === 410) {
          forget(s.id);
          deps.log("A browser's notifications ended: its push service no longer knows it.");
        } else if (response.ok) {
          deps.db.prepare("UPDATE push_subscriptions SET last_sent_at = ? WHERE id = ?").run(deps.now(), s.id);
          result.sent++;
        } else {
          result.failed++;
          deps.log(`A push service didn't take a notice: it answered ${response.status}.`);
        }
      } catch (error) {
        result.failed++;
        deps.log(`A notice didn't reach a push service: ${error instanceof Error ? error.name : "error"}.`);
      }
    }),
  );
  return result;
}

/** Sends without waiting, so whatever caused the notice never waits for a push service. */
export function notifyParents(deps: Deps, notice: Notice): void {
  void sendNotice(deps, notice).catch((error: unknown) => {
    deps.log(`Notices didn't go out: ${error instanceof Error ? error.message : "error"}.`);
  });
}

/** `Sam's phone: "Chatter Box" is waiting for you`. App names come from their developers: cleaned and capped. */
export function requestNotice(deviceName: string, labels: string[]): Notice {
  const phone = oneLine(deviceName, 60);
  const [only] = labels;
  const body = labels.length === 1 && only !== undefined ? `${phone}: "${oneLine(only, 60) || "an app"}" is waiting for you` : `${phone}: ${labels.length} apps are waiting for you`;
  return { title: "Belay", body, url: "/requests" };
}

/** A request as requestsNotice reads it (help requests have helpNotice). */
export interface NewRequest {
  kind: "app" | "more_time" | "agreement" | "talk" | "contact";
  label: string | null;
  limitId?: string;
  minutes?: number;
  reason: string | null;
  answer?: "agree" | "talk";
  /** contact: the name the kid gave (their words). */
  contactName?: string;
}

/**
 * The notice for the kid's new requests, in the style of requestNotice: one app, more time
 * (`Sam's phone asks for 15 more minutes for Games: "One more level"`), the agreement, a contact
 * (Phase 5), or how many. The kid's reason goes with "more time", "let's talk" and a contact: like everything in a notice it's
 * end-to-end encrypted to the parent's own browser, and it's cleaned and capped. Limit names are
 * the family's own words.
 */
export function requestsNotice(deviceName: string, requests: NewRequest[], limitName: (id: string) => string | null): Notice {
  const phone = oneLine(deviceName, 60);
  const kinds = new Set(requests.map((r) => r.kind));
  const [first] = requests;
  if (kinds.size === 1 && first?.kind === "app") return requestNotice(deviceName, requests.map((r) => r.label ?? "an app"));
  const why = (r: NewRequest) => (r.reason ? `: "${oneLine(r.reason, 80)}"` : "");
  if (requests.length === 1 && first?.kind === "more_time") {
    const limit = first.limitId === "*" ? "screen time" : oneLine(limitName(first.limitId ?? "") ?? "a limit", 40);
    return { title: "Belay", body: `${phone} asks for ${first.minutes ?? 0} more minutes for ${limit}${why(first)}`, url: "/requests" };
  }
  if (requests.length === 1 && first?.kind === "agreement") {
    const body = first.answer === "agree" ? `${phone}: the kid agreed to the family agreement` : `${phone}: the kid wants to talk about the family agreement${why(first)}`;
    return { title: "Belay", body, url: "/requests" };
  }
  if (requests.length === 1 && first?.kind === "talk") return { title: "Belay", body: `${phone}: the kid would like to talk${why(first)}`, url: "/requests" };
  // Phase 5: the kid's name for the contact; never the number, which waits on the Requests page.
  if (requests.length === 1 && first?.kind === "contact") {
    return { title: "Belay", body: `${phone} asks to add a contact: "${oneLine(first.contactName ?? "", 60) || "a number"}"${why(first)}`, url: "/requests" };
  }
  return { title: "Belay", body: `${phone}: ${requests.length} requests are waiting for you`, url: "/requests" };
}

/**
 * Phase 7: the kid pressed "I need help" (`Sam's phone needs help: "I'm lost"`), urgent, to every
 * parent at once. The kid's words go with it, cleaned and capped, end-to-end encrypted like every
 * notice; where the phone is doesn't, only that it was shared (it's on the Requests page).
 */
export function helpNotice(deviceName: string, help: { reason: string | null; shared: boolean; withdrawn?: boolean; update?: boolean }): Notice {
  const phone = oneLine(deviceName, 60);
  const words = help.reason ? oneLine(help.reason, 160) : "";
  const said = words ? `: "${words}"` : "";
  const where = help.shared ? " They shared where the phone is." : "";
  const body = `${phone} ${help.withdrawn ? "asked for help, then withdrew it" : "needs help"}${said}.${where}`;
  return { title: help.update ? "Belay: more about the help request" : "Belay: help", body, url: "/requests#help", urgent: true };
}

/** Phase 4: `Sam's phone arrived at School` (the family's own name for it), with the time when it's from a while ago. */
export function placeNotice(phone: { id: string; name: string }, placeName: string, kind: "arrived" | "left", when: string | null): Notice {
  const place = oneLine(placeName, 40);
  const body = `${oneLine(phone.name, 60)} ${kind === "arrived" ? "arrived at" : "left"} ${place}${when ? ` at ${when}` : ""}`;
  return { title: "Belay", body, url: `/devices/${phone.id}/location` };
}

/** `Sam's phone: Belay couldn't update to 0.4.0 (version 4)`. Never the phone's own words: those wait on the phone's page. */
export function updateFailedNotice(phone: { id: string; name: string }, version: string): Notice {
  return { title: "Belay", body: `${oneLine(phone.name, 60)}: Belay couldn't update to ${oneLine(version, 70)}. The phone's page says why.`, url: `/devices/${phone.id}` };
}

/** "Sam's phone reports the recovery key was used on it": the phone's word, so the notice says so. */
export function recoveryUsedNotice(phone: { id: string; name: string }): Notice {
  return { title: "Belay", body: `${oneLine(phone.name, 60)} reports the recovery key was used on it. Make a new one on the phone's page.`, url: `/devices/${phone.id}` };
}

/** `Sam's phone: Claude proposes allowing "Chatter Box"`. */
export function proposalNotice(deviceName: string, clientName: string, what: string): Notice {
  return { title: "Belay", body: `${oneLine(deviceName, 60)}: ${oneLine(clientName, 40)} proposes ${oneLine(what, 90)}`, url: "/proposals" };
}
