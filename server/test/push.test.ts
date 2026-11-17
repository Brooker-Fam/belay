import { createDecipheriv, createECDH, createHmac, createPublicKey, randomBytes, verify, type ECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { allowedEndpoint, encryptPayload, listSubscriptions, saveSubscription, sendNotice, vapidJwt, vapidKeys, VAPID_EXPIRY_SECONDS } from "../src/push.js";
import { deviceCall, enrollPhone, get, postForm, signIn, testServer, T0, type TestServer } from "./helpers.js";

const unb64 = (text: string) => Buffer.from(text.replace(/\s+/g, ""), "base64url");
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
const href = (url: string | URL | Request) => (url instanceof Request ? url.url : url.toString());

/** The browser's side of RFC 8291: what a user agent does with a push message. */
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
  expect(padded[end]).toBe(2);
  return padded.subarray(0, end).toString("utf8");
}

/** A made-up browser: its key pair and auth secret, subscribed at a push service. */
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${randomBytes(8).toString("hex")}`) {
  const keys = createECDH("prime256v1");
  keys.generateKeys();
  const auth = randomBytes(16);
  return { keys, auth, input: { endpoint, p256dh: b64(keys.getPublicKey()), auth: b64(auth) } };
}

function pushService(status = 201) {
  return vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status })));
}

async function family(fetch = pushService()) {
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  return { t, sam, phone, fetch };
}

const ask = (t: TestServer, token: string, id = "request-0001", app = "com.example.chat") =>
  deviceCall(t, token, "requests", { requests: [{ id, kind: "app", package: app, label: "Chatter\u0007 Box", asked_at: T0 }] });

describe("RFC 8291 encryption", () => {
  it("gives the example's message from its keys and salt (section 5)", () => {
    const message = encryptPayload(
      Buffer.from("When I grow up, I want to be a watermelon"),
      unb64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4"),
      unb64("BTBZMqHH6r4Tts7J_aSIgg"),
      { senderPrivate: unb64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw"), salt: unb64("DGv6ra1nlYgDCS1FRnbzlw") },
    );
    // 86 octets of header and 58 of ciphertext (the RFC's "Content-Length: 145" is one too many).
    expect(message.length).toBe(144);
    expect(b64(message)).toBe(
      "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
    );
    const receiver = createECDH("prime256v1");
    receiver.setPrivateKey(unb64("q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94"));
    expect(decrypt(message, receiver, unb64("BTBZMqHH6r4Tts7J_aSIgg"))).toBe("When I grow up, I want to be a watermelon");
  });

  it("uses a new key and salt for every message", () => {
    const b = browser();
    const one = encryptPayload(Buffer.from("hi"), b.keys.getPublicKey(), b.auth);
    const two = encryptPayload(Buffer.from("hi"), b.keys.getPublicKey(), b.auth);
    expect(one.subarray(0, 16).equals(two.subarray(0, 16))).toBe(false);
    expect(decrypt(one, b.keys, b.auth)).toBe("hi");
  });
});

describe("VAPID (RFC 8292)", () => {
  it("signs an ES256 token for the push service's origin, for 12 hours, naming the server", () => {
    const t = testServer();
    const keys = vapidKeys(t.deps.db);
    const [header, claims, signature] = vapidJwt(keys, "https://fcm.googleapis.com", "https://belay.example.org", T0).split(".") as [string, string, string];
    expect(JSON.parse(unb64(header).toString())).toEqual({ typ: "JWT", alg: "ES256" });
    expect(JSON.parse(unb64(claims).toString())).toEqual({ aud: "https://fcm.googleapis.com", exp: T0 / 1000 + VAPID_EXPIRY_SECONDS, sub: "https://belay.example.org" });
    expect(VAPID_EXPIRY_SECONDS).toBeLessThanOrEqual(12 * 3600);
    const point = unb64(keys.publicKey);
    expect(point.length).toBe(65);
    expect(point[0]).toBe(4);
    const publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64(point.subarray(1, 33)), y: b64(point.subarray(33)) }, format: "jwk" });
    expect(unb64(signature).length).toBe(64);
    expect(verify("sha256", Buffer.from(`${header}.${claims}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, unb64(signature))).toBe(true);
  });

  it("makes the key pair once and keeps it in the database", () => {
    const t = testServer();
    const first = vapidKeys(t.deps.db).publicKey;
    const row = t.deps.db.prepare("SELECT value FROM settings WHERE key = 'vapid'").get() as { value: string };
    expect(JSON.parse(row.value)).toMatchObject({ jwk: { kty: "EC", crv: "P-256" } });
    expect(vapidKeys(t.deps.db).publicKey).toBe(first);
  });
});

describe("push endpoints", () => {
  it("are only the known push services, over https", () => {
    for (const ok of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://api.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(allowedEndpoint(ok)).toBe(true);
    }
    for (const bad of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://127.0.0.1/push",
      "https://192.168.1.1:8443/admin",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://belay.example.org/settings",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilpush.apple.com/x",
      "https://push.apple.com/x",
      "https://fcm.googleapis.com:8443/x",
      "https://user:pass@fcm.googleapis.com/x",
      "not a url",
    ]) {
      expect(allowedEndpoint(bad)).toBe(false);
    }
  });
});

describe("sending notices", () => {
  it("sends nothing when nobody has turned notifications on", async () => {
    const { t, phone, fetch } = await family();
    expect((await ask(t, phone.token)).status).toBe(200);
    expect(await sendNotice(t.deps, { title: "Belay", body: "x", url: "/requests" })).toEqual({ sent: 0, removed: 0, failed: 0 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends each parent's browser an encrypted notice when the kid asks for something, without waiting for it", async () => {
    let release: () => void = () => undefined;
    const slow = vi.fn(
      (_url: string | URL | Request, _init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          release = () => {
            resolve(new Response(null, { status: 201 }));
          };
        }),
    );
    const { t, sam, phone } = await family(slow);
    const alex = await signIn(t, "alex", "Alex");
    const mine = browser();
    const theirs = browser("https://web.push.apple.com/QGuQyavXutnMQPm");
    saveSubscription(t.deps.db, t.now(), sam.parent.id, mine.input, "Chrome on Android");
    saveSubscription(t.deps.db, t.now(), alex.parent.id, theirs.input, "Safari on iPhone");

    // The phone's request is answered before any push service answers.
    expect((await ask(t, phone.token)).status).toBe(200);
    await vi.waitFor(() => {
      expect(slow).toHaveBeenCalledTimes(2);
    });
    release();

    const calls = slow.mock.calls.map(([url, init]) => ({ url: href(url), init: init as RequestInit & { headers: Record<string, string> } }));
    const toMine = calls.find((c) => c.url === mine.input.endpoint);
    expect(toMine?.init).toMatchObject({ method: "POST", redirect: "error" });
    expect(toMine?.init.signal).toBeInstanceOf(AbortSignal);
    expect(toMine?.init.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "normal" });
    const auth = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(toMine?.init.headers.authorization ?? "");
    expect(auth?.[2]).toBe(vapidKeys(t.deps.db).publicKey);
    expect(JSON.parse(unb64(auth?.[1]?.split(".")[1] ?? "").toString())).toMatchObject({ aud: "https://fcm.googleapis.com", sub: "https://belay.example.org" });
    const notice = JSON.parse(decrypt(Buffer.from(toMine?.init.body as Uint8Array), mine.keys, mine.auth)) as Record<string, string>;
    expect(notice).toEqual({ title: "Belay", body: 'Sam\'s phone: "Chatter Box" is waiting for you', url: "/requests" });

    const toTheirs = calls.find((c) => c.url === theirs.input.endpoint);
    const apple = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+)/.exec(toTheirs?.init.headers.authorization ?? "");
    expect(JSON.parse(unb64(apple?.[1]?.split(".")[1] ?? "").toString()).aud).toBe("https://web.push.apple.com");
    expect(JSON.parse(decrypt(Buffer.from(toTheirs?.init.body as Uint8Array), theirs.keys, theirs.auth))).toMatchObject({ url: "/requests" });
  });

  it("sends nothing for a request it already has", async () => {
    const { t, sam, phone, fetch } = await family();
    saveSubscription(t.deps.db, t.now(), sam.parent.id, browser().input, "Chrome on Android");
    await ask(t, phone.token);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    await ask(t, phone.token);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("sends at most six notices an hour about one phone", async () => {
    const { t, sam, phone, fetch } = await family();
    saveSubscription(t.deps.db, t.now(), sam.parent.id, browser().input, "Chrome on Android");
    for (let i = 0; i < 8; i++) await ask(t, phone.token, `request-000${i}`, `com.example.app${i}`);
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(6);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(6);
    t.advance(3_600_001);
    await ask(t, phone.token, "request-0009", "com.example.app9");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(7);
    });
  });

  it("doesn't tell parents again when the kid asks again for an app already waiting", async () => {
    const { t, sam, phone, fetch } = await family();
    saveSubscription(t.deps.db, t.now(), sam.parent.id, browser().input, "Chrome on Android");
    await ask(t, phone.token, "request-0001");
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    // The app was removed and installed again: the phone asks with a new id.
    await ask(t, phone.token, "request-0002");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("forgets a browser its push service no longer knows (404 or 410)", async () => {
    const answers = new Map<string, number>();
    const fetch = vi.fn((url: string | URL | Request) => Promise.resolve(new Response(null, { status: answers.get(href(url)) ?? 201 })));
    const { t, sam } = await family(fetch);
    const gone = browser();
    const missing = browser();
    const fine = browser();
    answers.set(gone.input.endpoint, 410);
    answers.set(missing.input.endpoint, 404);
    for (const b of [gone, missing, fine]) saveSubscription(t.deps.db, t.now(), sam.parent.id, b.input, "Chrome on Android");
    expect(await sendNotice(t.deps, { title: "Belay", body: "x", url: "/requests" })).toEqual({ sent: 1, removed: 2, failed: 0 });
    expect(listSubscriptions(t.deps.db).map((s) => [s.endpoint, s.lastSentAt])).toEqual([[fine.input.endpoint, t.now()]]);
  });

  it("logs a push service that fails, without the endpoint", async () => {
    const fetch = vi.fn(() => Promise.reject(new TypeError("fetch failed")));
    const { t, sam } = await family(fetch);
    const b = browser();
    saveSubscription(t.deps.db, t.now(), sam.parent.id, b.input, "Chrome on Android");
    expect(await sendNotice(t.deps, { title: "Belay", body: "x", url: "/requests" })).toEqual({ sent: 0, removed: 0, failed: 1 });
    expect(t.logs.join("\n")).toContain("didn't reach a push service");
    expect(t.logs.join("\n")).not.toContain(b.input.endpoint);
    expect(listSubscriptions(t.deps.db)).toHaveLength(1);
  });
});

describe("turning notifications on and off", () => {
  it("needs a signed-in parent, the form's CSRF token, and this site's origin", async () => {
    const { t, sam } = await family();
    const b = browser();
    expect((await postForm(t, "/settings/push/subscribe", { ...b.input })).status).toBe(401);
    expect((await postForm(t, "/settings/push/subscribe", { ...b.input }, { cookie: sam.cookie })).status).toBe(403);
    expect((await postForm(t, "/settings/push/subscribe", { ...b.input, _csrf: sam.csrf }, { cookie: sam.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(listSubscriptions(t.deps.db)).toEqual([]);
    const res = await postForm(t, "/settings/push/subscribe", { ...b.input, _csrf: sam.csrf }, { cookie: sam.cookie, headers: { "user-agent": "Mozilla/5.0 (Linux; Android 16; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36" } });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings?saved=push_on#notifications");
    expect(listSubscriptions(t.deps.db, sam.parent.id).map((s) => s.name)).toEqual(["Chrome on Android"]);
    expect(await (await get(t, "/settings", sam.cookie)).text()).toContain("Chrome on Android");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "push.subscribed", parentName: "Sam" });

    expect((await postForm(t, "/settings/push/unsubscribe", { endpoint: b.input.endpoint }, { cookie: sam.cookie })).status).toBe(403);
    expect((await postForm(t, "/settings/push/unsubscribe", { endpoint: b.input.endpoint, _csrf: sam.csrf }, { cookie: sam.cookie })).status).toBe(302);
    expect(listSubscriptions(t.deps.db)).toEqual([]);
  });

  it("refuses an endpoint that isn't a known push service, like an address on the family's network", async () => {
    const { t, sam } = await family();
    const b = browser("http://192.168.1.1/admin");
    const res = await postForm(t, "/settings/push/subscribe", { ...b.input, _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("push service isn&#39;t one Belay sends notices to");
    expect(listSubscriptions(t.deps.db)).toEqual([]);
  });

  it("refuses keys that aren't a point on P-256", async () => {
    const { t, sam } = await family();
    const b = browser();
    const offCurve = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]);
    const res = await postForm(t, "/settings/push/subscribe", { ...b.input, p256dh: b64(offCurve), _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(res.status).toBe(400);
    expect(listSubscriptions(t.deps.db)).toEqual([]);
  });

  it("lets a parent remove one of their own browsers, not someone else's", async () => {
    const { t, sam } = await family();
    const alex = await signIn(t, "alex", "Alex");
    const theirs = saveSubscription(t.deps.db, t.now(), alex.parent.id, browser().input, "Safari on iPhone");
    const mine = saveSubscription(t.deps.db, t.now(), sam.parent.id, browser().input, "Firefox on Windows");
    await postForm(t, `/settings/push/${theirs.id}/remove`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    await postForm(t, `/settings/push/${mine.id}/remove`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(listSubscriptions(t.deps.db).map((s) => s.name)).toEqual(["Safari on iPhone"]);
  });

  it("sends a test notice to the parent's own browsers", async () => {
    const { t, sam, fetch } = await family();
    const alex = await signIn(t, "alex", "Alex");
    saveSubscription(t.deps.db, t.now(), sam.parent.id, browser().input, "Chrome on Android");
    saveSubscription(t.deps.db, t.now(), alex.parent.id, browser().input, "Safari on iPhone");
    const res = await postForm(t, "/settings/push/test", { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(await res.text()).toContain("Sent a test notice to 1 browser.");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("the web app pieces", () => {
  it("serve the service worker, the manifest and the icon from this site, and allow them in the CSP", async () => {
    const { t, sam } = await family();
    const page = await get(t, "/settings", sam.cookie);
    const csp = page.headers.get("content-security-policy") ?? "";
    for (const directive of ["script-src 'self'", "connect-src 'self'", "manifest-src 'self'", "worker-src 'self'", "default-src 'none'"]) expect(csp).toContain(directive);
    const html = await page.text();
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest"/>');
    expect(html).toContain(`data-vapid-key="${vapidKeys(t.deps.db).publicKey}"`);
    expect(html).not.toMatch(/<script>|<script [^>]*>[^<]/);

    const sw = await t.app.request("/sw.js");
    expect(sw.headers.get("content-type")).toContain("text/javascript");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    expect(await sw.text()).toContain("showNotification");
    const manifest = await t.app.request("/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toBe("application/manifest+json");
    expect(JSON.parse(await manifest.text())).toMatchObject({ display: "standalone", start_url: "/", scope: "/" });
    expect((await t.app.request("/static/icon.svg")).headers.get("content-type")).toBe("image/svg+xml");
  });
});
