/**
 * Phase 6: each phone's recovery key. Made when a parent first turns on a lock that can strand the
 * phone (or asks for a new one, or with the CLI), shown once, kept only as its check, carried in
 * the policy until the phone reports it used.
 */
import { createDecipheriv, createECDH, createHmac, randomBytes, type ECDH } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it, vi } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { getDevice } from "../src/family/devices.js";
import { buildPolicy } from "../src/family/policy.js";
import { makePhoneRecoveryKey, normalizeRecoveryKey, recoveryHash } from "../src/family/recovery.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { saveSubscription } from "../src/push.js";
import { getSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, postForm, signIn, testServer, type TestServer } from "./helpers.js";

const GROUPED = /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{6}$/;

async function family(opts: { fetch?: typeof fetch } = {}) {
  const t = testServer(opts);
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "CI phone");
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const send = (path: string, fields: Record<string, string> = {}) => postForm(t, `/devices/${phone.deviceId}${path}`, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const page = async () => (await get(t, `/devices/${phone.deviceId}`, sam.cookie)).text();
  const shownKey = (html: string) => /<pre id="secret" class="code">([^<]+)<\/pre>/.exec(html)?.[1] ?? "";
  return { t, sam, phone, policy, send, page, shownKey };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(""),
    interactive: false,
  });
  return { code, out, err };
}

describe("the recovery key", () => {
  it("is made when a parent first turns on a lock that can strand the phone, and shown once", async () => {
    const { t, policy, send, shownKey } = await family();
    const res = await send("/hardening", { factory_reset: "1", frp_accounts: "", confirm: "CI phone" });
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain("It&#39;s shown only now. Print it, or keep it in a password manager.");
    const key = shownKey(html);
    expect(key).toMatch(GROUPED);
    const check = policy().recovery;
    expect(check).toMatchObject({ version: 1 });
    expect(check?.hash).toBe(recoveryHash(check?.salt ?? "", normalizeRecoveryKey(key) ?? ""));
    expect(policy().restrictions.factory_reset).toBe(true);
    // Only its check is kept.
    const stored = JSON.stringify(t.deps.db.prepare("SELECT * FROM recovery_keys").all());
    expect(stored).not.toContain(key);
    expect(stored).not.toContain(normalizeRecoveryKey(key));
    expect(listAudit(t.deps.db, { limit: 5, includeReads: false }).map((e) => e.action)).toContain("recovery.made");
    // Turning on the other lock while the phone has a key makes no new one.
    const again = await send("/hardening", { factory_reset: "1", debugging: "1", frp_accounts: "", confirm: "CI phone" });
    expect(again.status).toBe(302);
    expect(policy().recovery?.version).toBe(1);
  });

  it("isn't made when the lock isn't turned on: the phone's name is still needed", async () => {
    const { policy, send } = await family();
    expect((await send("/hardening", { factory_reset: "1", frp_accounts: "" })).status).toBe(400);
    expect((await send("/hardening", { frp_accounts: "" })).status).toBe(302);
    expect(policy().recovery).toBeNull();
  });

  it("can be made new on the phone's page: the next version, and only its check in the policy", async () => {
    const { policy, send, page, shownKey } = await family();
    expect(await page()).toContain("Turning on a lock above makes one for this phone.");
    const first = shownKey(await (await send("/recovery-key")).text());
    const old = policy().recovery;
    const second = shownKey(await (await send("/recovery-key")).text());
    expect(first).not.toBe(second);
    expect(policy().recovery).toMatchObject({ version: 2 });
    expect(policy().recovery?.hash).not.toBe(old?.hash);
    expect(await page()).toContain("This phone has one, made");
  });

  it("when the phone reports it used: recorded once, out of the policy, the parents told, and a new one asked for", async () => {
    const pushService = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
    const { t, sam, phone, policy, page } = await family({ fetch: pushService as unknown as typeof fetch });
    const browser = createECDH("prime256v1");
    browser.generateKeys();
    const auth = randomBytes(16);
    saveSubscription(t.deps.db, t.now(), sam.parent.id, { endpoint: "https://fcm.googleapis.com/fcm/send/made-up", p256dh: browser.getPublicKey().toString("base64url"), auth: auth.toString("base64url") }, "Chrome");
    makePhoneRecoveryKey({ db: t.deps.db, now: t.now() }, phone.deviceId, { kind: "parent", parentId: sam.parent.id });
    const version = policy().version;
    const use = { version: 1, used_at: t.now() - 60_000, until: t.now() + 86_400_000 };
    const report = (recovery: typeof use) => deviceCall(t, phone.token, "checkin", { status: device({ device_time: t.now(), enforcement: { policy_version: version, applied_at: t.now(), recovery } }) });
    await report(use);
    await report(use);
    expect(policy()).toMatchObject({ version: version + 1, recovery: null });
    await vi.waitFor(() => {
      expect(pushService).toHaveBeenCalledTimes(1);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pushService).toHaveBeenCalledTimes(1);
    expect(JSON.parse(decryptPush(pushService.mock.calls[0]?.[1]?.body as Uint8Array, browser, auth))).toEqual({
      title: "Belay",
      body: "The recovery key was used on CI phone. Make a new one on the phone's page.",
      url: `/devices/${phone.deviceId}`,
    });
    expect(listAudit(t.deps.db, { limit: 10, includeReads: false }).filter((e) => e.action === "recovery.used")).toEqual([
      expect.objectContaining({ actor: "phone", detail: expect.objectContaining({ key_version: 1 }) as unknown }),
    ]);
    const view = getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now());
    expect(view?.problems.map((p) => p.code)).toEqual(["recovery_used"]);
    expect(view?.problems[0]?.text).toBe("The recovery key was used on the phone 1 minute ago, so it won't work again: make a new one on the phone's page");
    expect(await page()).toContain("It won&#39;t work again: make a new one.");
    // A version the server never made is ignored.
    await report({ ...use, version: 99 });
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM recovery_keys").get()).toEqual({ n: 1 });
    // A new key: the problem goes, and the policy carries its check.
    makePhoneRecoveryKey({ db: t.deps.db, now: t.now() }, phone.deviceId, { kind: "parent", parentId: sam.parent.id });
    expect(policy().recovery?.version).toBe(2);
    expect(getDevice(t.deps.db, phone.deviceId, getSettings(t.deps.db), t.now())?.problems).toEqual([]);
  });

  it("from the CLI: prints only the grouped key, with or without the locks, and the phone gets its check", async () => {
    const { t, policy } = await family();
    const before = policy().version;
    const made = await cli(t, "recovery-key", "CI phone");
    expect(made.code).toBe(0);
    expect(made.out).toHaveLength(1);
    expect(made.out[0]).toMatch(GROUPED);
    expect(made.err[0]).toContain("It's shown only now: print it, or keep it in a password manager.");
    expect(policy()).toMatchObject({ version: before + 1, recovery: { version: 1 } });
    const again = await cli(t, "recovery-key", "CI phone");
    expect(again.err[0]).toContain("The earlier key stops working once the phone has this one.");
    expect(policy().recovery?.version).toBe(2);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "recovery.made", detail: { key_version: 2 } });
    const status = JSON.parse((await cli(t, "status", "--json")).out.join("\n")) as { phones: { recovery: unknown }[] };
    expect(status.phones[0]?.recovery).toEqual({ version: 2, last_used: null });
  });

  it("is something AI clients only know exists, and when it was last used", async () => {
    const { t, sam, phone } = await family();
    makePhoneRecoveryKey({ db: t.deps.db, now: t.now() }, phone.deviceId, { kind: "parent", parentId: sam.parent.id });
    const { token } = createPersonalToken(t.deps.db, t.now(), sam.parent.id, "Claude", "https://belay.example.org/mcp");
    const client = new Client({ name: "belay-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL("https://belay.example.org/mcp"), {
        fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const res = await client.callTool({ name: "get_policy", arguments: { device: "CI phone" } });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    expect((JSON.parse(text) as { only_a_parent_on_the_parent_page_changes: unknown }).only_a_parent_on_the_parent_page_changes).toMatchObject({
      recovery_key: { exists: true, last_used: null },
    });
    const { salt, hash } = t.deps.db.prepare("SELECT salt, hash FROM recovery_keys").get() as { salt: string; hash: string };
    expect(text).not.toContain(salt);
    expect(text).not.toContain(hash);
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as unknown as { kind: "server" };
    expect(() => makePhoneRecoveryKey({ db: t.deps.db, now: t.now() }, phone.deviceId, ai)).toThrow(/Only a person/);
  });
});

/** The browser's side of RFC 8291: what a notice said. */
function decryptPush(message: Uint8Array, browser: ECDH, auth: Buffer): string {
  const data = Buffer.from(message);
  const hmac = (key: Uint8Array, input: Uint8Array) => createHmac("sha256", key).update(input).digest();
  const salt = data.subarray(0, 16);
  const idLength = data[20] ?? 0;
  const senderPublic = data.subarray(21, 21 + idLength);
  const sealed = data.subarray(21 + idLength);
  const ikm = hmac(hmac(auth, browser.computeSecret(senderPublic)), Buffer.concat([Buffer.from("WebPush: info"), Buffer.from([0]), browser.getPublicKey(), senderPublic, Buffer.from([1])]));
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: aes128gcm"), Buffer.from([0, 1])])).subarray(0, 16);
  const nonce = hmac(prk, Buffer.concat([Buffer.from("Content-Encoding: nonce"), Buffer.from([0, 1])])).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce);
  decipher.setAuthTag(sealed.subarray(-16));
  const padded = Buffer.concat([decipher.update(sealed.subarray(0, -16)), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2)).toString("utf8");
}
