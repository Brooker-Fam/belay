/**
 * Phase 3's requests (docs/protocol.md, POST /api/v1/requests): more time for a limit today, and
 * the kid's answer to the family agreement, beside Phase 2's app requests. The parents hear about
 * them, with the kid's reason, and answer on the Requests page. Made-up apps and names only.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { getRequest, listRequests } from "../src/family/requests.js";
import { saveAgreement, setPhoneRules } from "../src/family/screentime/changes.js";
import { NO_RULES } from "../src/family/screentime/rules.js";
import { requestsNotice, saveSubscription } from "../src/push.js";
import { deviceCall, enrollPhone, get, postForm, signIn, testServer, type TestServer } from "./helpers.js";

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

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  setPhoneRules(ctx(), phone.deviceId, { ...NO_RULES, limits: [{ id: "l-games", name: "Games", packages: ["com.example.blocks"], minutes: 60, by_day: null }] }, parent);
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, fetch, policy };
}

const moreTime = (t: TestServer, token: string, id: string, over: Record<string, unknown> = {}) =>
  deviceCall(t, token, "requests", { requests: [{ id, kind: "more_time", limit_id: "l-games", minutes: 15, asked_at: t.now(), ...over }] });
const agreement = (t: TestServer, token: string, id: string, answer: "agree" | "talk", over: Record<string, unknown> = {}) =>
  deviceCall(t, token, "requests", { requests: [{ id, kind: "agreement", version: 1, answer, asked_at: t.now(), ...over }] });

describe("more time", () => {
  it("waits for a parent, and the parents hear it with the kid's reason", async () => {
    const { t, sam, phone, fetch } = await family();
    const keys = createECDH("prime256v1");
    keys.generateKeys();
    const auth = randomBytes(16);
    saveSubscription(t.deps.db, t.now(), sam.parent.id, { endpoint: "https://fcm.googleapis.com/fcm/send/abc", p256dh: b64(keys.getPublicKey()), auth: b64(auth) }, "Chrome on Android");
    const res = await moreTime(t, phone.token, "request-0001", { package: "com.example.blocks", reason: "One more\u0007 level, please" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({
      kind: "more_time",
      limitId: "l-games",
      minutes: 15,
      package: "com.example.blocks",
      reason: "One more level, please",
      status: "pending",
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    const body = fetch.mock.calls[0]?.[1]?.body as Uint8Array;
    expect(JSON.parse(decrypt(Buffer.from(body), keys, auth))).toEqual({ title: "Belay", body: 'Alex\'s phone asks for 15 more minutes for Games: "One more level, please"', url: "/requests#request-request-0001" });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "phone", action: "request.made", detail: { kind: "more_time", limit: "Games", minutes: 15 } });
  });

  it("asking again for the same limit takes the waiting one's place, with the kid's words", async () => {
    const { t, phone, policy } = await family();
    await moreTime(t, phone.token, "request-0001", { reason: "Almost done" });
    await moreTime(t, phone.token, "request-0002", { minutes: 30 });
    expect(listRequests(t.deps.db, { deviceId: phone.deviceId }).map((r) => [r.id, r.status, r.reason])).toEqual([["request-0002", "pending", "Almost done"]]);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("superseded");
    // The same id again updates the reason while it waits.
    await moreTime(t, phone.token, "request-0002", { minutes: 30, reason: "Two more levels" });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")?.reason).toBe("Two more levels");
    expect(policy().requests.map((r) => r.id)).toEqual(["request-0002"]);
  });

  it("refuses a flood of made-up limits past 60 waiting, and keeps app requests apart", async () => {
    const { t, phone } = await family();
    for (let i = 0; i < 60; i += 20) {
      const batch = Array.from({ length: 20 }, (_, j) => ({ id: `request-${String(i + j).padStart(4, "0")}`, kind: "more_time", limit_id: `l-${i + j}`, minutes: 15, asked_at: t.now() }));
      expect((await deviceCall(t, phone.token, "requests", { requests: batch })).status).toBe(200);
    }
    expect((await moreTime(t, phone.token, "request-0999", { limit_id: "l-999" })).status).toBe(429);
    // An app's request still goes through: the caps are per kind.
    expect((await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-1000", kind: "app", package: "com.example.chat", label: "Chatter", asked_at: t.now() }] })).status).toBe(200);
  });

  it("checks each kind's fields", async () => {
    const { t, phone } = await family();
    for (const bad of [
      { id: "request-0001", kind: "more_time", minutes: 15, asked_at: 1 },
      { id: "request-0001", kind: "more_time", limit_id: "l-games", minutes: 4, asked_at: 1 },
      { id: "request-0001", kind: "more_time", limit_id: "l-games", minutes: 241, asked_at: 1 },
      { id: "request-0001", kind: "more_time", limit_id: "*", minutes: 15, asked_at: 1 },
      { id: "request-0001", kind: "more_time", limit_id: "l-games", minutes: 15, label: "Games", asked_at: 1 },
      { id: "request-0001", kind: "agreement", version: 1, answer: "maybe", asked_at: 1 },
      { id: "request-0001", kind: "agreement", version: 0, answer: "agree", asked_at: 1 },
      { id: "request-0001", kind: "agreement", answer: "agree", package: "com.example.chat", version: 1, asked_at: 1 },
      { id: "request-0001", kind: "time", asked_at: 1 },
    ]) {
      expect((await deviceCall(t, phone.token, "requests", { requests: [bad] })).status, JSON.stringify(bad)).toBe(400);
    }
    expect(listRequests(t.deps.db)).toEqual([]);
  });

  it("the notice for several requests at once counts them", () => {
    const notice = requestsNotice(
      "Alex's phone",
      [
        { kind: "app", label: "Chatter", reason: null },
        { kind: "more_time", label: null, limitId: "l-games", minutes: 15, reason: null },
      ],
      () => "Games",
    );
    expect(notice.body).toBe("Alex's phone: 2 requests are waiting for you");
    expect(requestsNotice("Alex's phone", [{ kind: "more_time", label: null, limitId: "*", minutes: 30, reason: null }], () => null).body).toBe("Alex's phone asks for 30 more minutes for screen time");
  });

  it("a notice about one request opens its own card; one about several opens the Requests page", () => {
    const one = requestsNotice("Alex's phone", [{ id: "req-0042", kind: "talk", label: null, reason: null }], () => null);
    expect(one.url).toBe("/requests#request-req-0042");
    const app = requestsNotice("Alex's phone", [{ id: "req-0043", kind: "app", label: "Chatter", reason: null }], () => null);
    expect(app.url).toBe("/requests#request-req-0043");
    const two = requestsNotice(
      "Alex's phone",
      [
        { id: "req-0044", kind: "app", label: "Chatter", reason: null },
        { id: "req-0045", kind: "app", label: "Maps", reason: null },
      ],
      () => null,
    );
    expect(two.url).toBe("/requests");
    // Never anything but an id the page could have: a stray character gives the plain page.
    expect(requestsNotice("Alex's phone", [{ id: "x/../settings", kind: "talk", label: null, reason: null }], () => null).url).toBe("/requests");
  });
});

describe("the family agreement's answers", () => {
  it('"I agree" is answered at once; "I want to talk about it" waits for a parent', async () => {
    const { t, phone, ctx, parent, policy } = await family();
    saveAgreement(ctx(), phone.deviceId, [{ title: "Phones at dinner", text: "In the basket." }], parent);
    expect((await agreement(t, phone.token, "request-0001", "talk", { reason: "Can we talk about weekends?" })).status).toBe(200);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ kind: "agreement", version: 1, answer: "talk", status: "pending" });
    expect(policy().agreement?.kid_agreed_at).toBeNull();
    // Agreeing later takes the "let's talk" one's place.
    t.advance(60_000);
    await agreement(t, phone.token, "request-0002", "agree");
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("superseded");
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")).toMatchObject({ status: "approved", answeredBy: null });
    expect(policy().agreement?.kid_agreed_at).toBe(t.now());
    // An answer to a version that doesn't exist is kept, and changes no agreement.
    expect((await agreement(t, phone.token, "request-0003", "agree", { version: 7 })).status).toBe(200);
    expect(policy().agreement?.version).toBe(1);
  });
});

describe("the Requests page", () => {
  it("offers 15, 30 or 60 minutes, let's talk or no, with a note, and approving gives the time for today", async () => {
    const { t, sam, phone, policy } = await family();
    await moreTime(t, phone.token, "request-0001", { reason: "One more level" });
    const page = await (await get(t, "/requests", sam.cookie)).text();
    expect(page).toContain("More time for Games");
    expect(page).toContain("Asked for 15 minutes");
    // The card a notice about this one request opens.
    expect(page).toContain('<div class="card" id="request-request-0001">');
    expect(page).toContain('<blockquote class="kid">One more level</blockquote>');
    for (const m of ["15", "30", "60"]) expect(page).toContain(`name="give" value="${m}"`);
    expect(page).toContain('name="answer" value="declined"');
    expect(page).toContain(`name="_csrf" value="${sam.csrf}"`);
    const action = `/devices/${phone.deviceId}/requests/request-0001/answer`;
    // Without the CSRF token, nothing.
    expect((await postForm(t, action, { give: "30", back: "requests" }, { cookie: sam.cookie })).status).toBe(403);
    expect((await postForm(t, action, { _csrf: sam.csrf, give: "45", back: "requests" }, { cookie: sam.cookie })).status).toBe(400);
    const res = await postForm(t, action, { _csrf: sam.csrf, give: "30", note: "Just today", back: "requests" }, { cookie: sam.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/requests?saved=answer_more_time");
    const p = policy();
    expect(p.requests[0]).toMatchObject({ id: "request-0001", status: "approved", minutes: 30, note: "Just today", answered_by: "Sam" });
    expect(p.screen_time?.extra).toMatchObject([{ limit_id: "l-games", minutes: 30, day: "2026-11-16", request_id: "request-0001" }]);
    const after = await (await get(t, "/requests?saved=answer_more_time", sam.cookie)).text();
    expect(after).toContain("More time for Games: 30 minutes given");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "request.answered", detail: { kind: "more_time", limit: "Games", minutes: 30 } });
  });

  it("answers the kid who wants to talk about the agreement", async () => {
    const { t, sam, phone, ctx, parent } = await family();
    saveAgreement(ctx(), phone.deviceId, [{ title: "Phones at dinner", text: "In the basket." }], parent);
    await agreement(t, phone.token, "request-0001", "talk", { reason: "Weekends?" });
    const page = await (await get(t, "/requests", sam.cookie)).text();
    expect(page).toContain("Wants to talk about the family agreement");
    const res = await postForm(t, `/devices/${phone.deviceId}/requests/request-0001/answer`, { _csrf: sam.csrf, answer: "talk", note: "Saturday, after lunch", back: "requests" }, { cookie: sam.cookie });
    expect(res.headers.get("location")).toBe("/requests?saved=answer_other_talk");
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "talk", note: "Saturday, after lunch" });
  });
});
