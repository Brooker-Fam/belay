/** For the ops tests: a server whose data dir is a real (temporary) folder, for backups. Made-up data only. */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, vi } from "vitest";
import type { DailyContext, DiskSpace } from "../src/ops/backups.js";
import { setOpsOptions, type OpsOptions } from "../src/ops/options.js";
import { type Notice, saveSubscription } from "../src/push.js";
import { updateSettings } from "../src/settings.js";
import { testServer, type TestServer } from "./helpers.js";

/** Fast scrypt settings for tests; the header records them, so decrypting needs nothing else. */
export const FAST_SCRYPT = { logN: 10, r: 8, p: 1 };
export const PASSPHRASE = "correct horse battery staple, backed up";
/** A disk with plenty of room: the machine running the tests may have little. */
export const ROOMY_DISK: DiskSpace = { freeBytes: 400e9, totalBytes: 500e9 };

const folders: string[] = [];

afterEach(() => {
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A new empty folder, deleted after the test. */
export function scratchDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belay-ops-test-"));
  folders.push(dir);
  return dir;
}

export interface OpsServer extends TestServer {
  dataDir: string;
}

/**
 * A test server in New York time whose data dir is a scratch folder (its database is still in
 * memory), with a roomy disk, fast scrypt and no backup passphrase unless `ops` says otherwise.
 */
export function opsServer(opts: { fetch?: typeof fetch; ops?: OpsOptions } = {}): OpsServer {
  const dataDir = scratchDir();
  const t = testServer({ config: { dataDir }, fetch: opts.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => ROOMY_DISK, ...opts.ops });
  return Object.assign(t, { dataDir });
}

export function dailyContext(t: OpsServer, extra: Partial<DailyContext> = {}): DailyContext {
  return {
    db: t.deps.db,
    dataDir: t.dataDir,
    now: () => t.now(),
    passphrase: () => null,
    log: (m) => t.logs.push(m),
    scrypt: FAST_SCRYPT,
    disk: () => ROOMY_DISK,
    ...extra,
  };
}

// ── Web Push ────────────────────────────────────────────────────────────

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** A made-up browser a parent turned notifications on in. */
export interface FakeBrowser {
  endpoint: string;
  keys: ECDH;
  auth: Buffer;
}

export function subscribe(t: TestServer, parentId: string, name = "Firefox on Linux"): FakeBrowser {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const auth = randomBytes(16);
  const endpoint = `https://updates.push.services.mozilla.com/wpush/v2/${randomBytes(8).toString("hex")}`;
  saveSubscription(t.deps.db, t.now(), parentId, { endpoint, p256dh: keys.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, name);
  return { endpoint, keys, auth };
}

/** What the browser reads from a push message (RFC 8291). */
export function readNotice(browser: FakeBrowser, message: Uint8Array): Notice {
  const buf = Buffer.from(message);
  const salt = buf.subarray(0, 16);
  const idLength = buf[20] ?? 0;
  const senderPublic = buf.subarray(21, 21 + idLength);
  const sealed = buf.subarray(21 + idLength);
  const info = (label: string) => Buffer.concat([Buffer.from(`Content-Encoding: ${label}`, "latin1"), Buffer.from([0, 1])]);
  const prkKey = hmac(browser.auth, browser.keys.computeSecret(senderPublic));
  const ikm = hmac(prkKey, Buffer.concat([Buffer.from("WebPush: info", "latin1"), Buffer.from([0]), browser.keys.getPublicKey(), senderPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const decipher = createDecipheriv("aes-128-gcm", hmac(prk, info("aes128gcm")).subarray(0, 16), hmac(prk, info("nonce")).subarray(0, 12));
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  return JSON.parse(padded.subarray(0, padded.lastIndexOf(2)).toString("utf8")) as Notice;
}

/** A push service that answers `status`, keeping what was sent where. */
export function pushService(status = 201) {
  const sent: { endpoint: string; body: Uint8Array }[] = [];
  const fetch = vi.fn((url: string | URL | Request, init?: RequestInit) => {
    sent.push({ endpoint: url instanceof Request ? url.url : url.toString(), body: init?.body as Uint8Array });
    return Promise.resolve(new Response(null, { status }));
  });
  return { fetch: fetch as unknown as typeof globalThis.fetch, sent };
}
