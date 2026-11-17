/**
 * The apps the phone never blocks, so 911 and 988 always work: the server refuses to block them
 * too, for AI apps and parents alike, from its own well-known list and the phone's latest report
 * (the security review's finding 2).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { Policy } from "../src/device/schemas.js";
import { NEVER_BLOCKED, RuleRefused, buildPolicy, decideApp, neverBlockedReason, type PolicyContext } from "../src/family/policy.js";
import { nothingToLoosen } from "../src/family/proposals.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { device, deviceCall, enrollPhone, pkg, postForm, signIn, snapshot, testServer, T0, type TestServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(
    t,
    phone.token,
    "inventory",
    snapshot([pkg("com.example.maps", { label: "Trail Maps" }), pkg("com.example.keyboard", { label: "Swirl Keys" }), pkg("com.google.android.inputmethod.latin", { label: "Gboard", system: true })], T0),
  );
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const claude = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  /** The phone reports what it never blocks, as it resolves the roles on that phone. */
  const report = (neverBlocked: string[]) =>
    deviceCall(t, phone.token, "checkin", { status: device({ device_time: t.now(), enforcement: { policy_version: 0, applied_at: t.now(), never_blocked: neverBlocked } }) });
  return { t, sam, phone, ctx, parent, claude, policy, report };
}

async function mcp(t: TestServer, parentId: string) {
  const { token } = createPersonalToken(t.deps.db, t.now(), parentId, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return async (name: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    return { isError: res.isError === true, text, json: (() => { try { return JSON.parse(text) as Record<string, any>; } catch { return {}; } })() };
  };
}

describe("apps the phone never blocks", () => {
  it("are refused for AI apps, parents and the CLI alike, with the reason", async () => {
    const { t, phone, ctx, parent, claude, policy } = await family();
    expect(() => decideApp(ctx(), phone.deviceId, "com.google.android.dialer", "blocked", parent)).toThrow(
      new RuleRefused("The phone never blocks its dialer: 911 and 988 must always work."),
    );
    for (const [name, why] of [
      ["com.google.android.inputmethod.latin", "The phone never blocks its keyboard: texting 988 needs one."],
      ["com.samsung.android.messaging", "The phone never blocks its texting app: texting 988 must always work."],
      ["com.google.android.apps.safetyhub", "The phone never blocks its emergency and safety apps: 911 and 988 must always work."],
      ["com.android.providers.telephony", "The phone never blocks what places calls and texts: 911 and 988 must always work."],
      ["com.android.launcher3", "The phone never blocks its home screen: it's the way to calls and texts."],
      ["android", "The phone never blocks Android itself."],
      ["family.brooker.belay", "Belay never blocks itself."],
    ] as const) {
      for (const who of [parent, claude, { kind: "server" } as const]) expect(() => decideApp(ctx(), phone.deviceId, name, "blocked", who)).toThrow(why);
    }
    for (const name of NEVER_BLOCKED.keys()) expect(neverBlockedReason(t.deps.db, phone.deviceId, name)).not.toBeNull();
    expect(policy()).toMatchObject({ version: 0, apps: { decisions: [] } });
    // Allowing one, or clearing a decision, is fine: only blocking is refused.
    decideApp(ctx(), phone.deviceId, "com.google.android.inputmethod.latin", "allowed", parent);
    expect(policy().apps.decisions).toEqual([{ package: "com.google.android.inputmethod.latin", state: "allowed" }]);
  });

  it("include what the phone's latest report says it never blocks, like a keyboard it added", async () => {
    const { t, phone, ctx, parent, claude, report } = await family();
    await report(["family.brooker.belay", "com.example.keyboard"]);
    const why = "The phone says it never blocks this app: it's one the phone needs, like its dialer, texting app or keyboard, so 911 and 988 always work.";
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.keyboard", "blocked", claude)).toThrow(why);
    expect(() => decideApp(ctx(), phone.deviceId, "com.example.keyboard", "blocked", parent)).toThrow(why);
    expect(nothingToLoosen(t.deps.db, phone.deviceId, { kind: "allow_app", package: "com.example.keyboard" }, t.now())).toContain("Belay never blocks it");
    // A later report without it: the kid switched keyboards, so it can be blocked again.
    await report(["family.brooker.belay"]);
    decideApp(ctx(), phone.deviceId, "com.example.keyboard", "blocked", claude);
    expect(neverBlockedReason(t.deps.db, phone.deviceId, "com.example.keyboard")).toBeNull();
  });

  it("over MCP: block_app refuses the packages 911 and 988 depend on, and says why", async () => {
    const { t, sam, report, policy } = await family();
    await report(["com.example.keyboard"]);
    const call = await mcp(t, sam.parent.id);
    for (const name of [
      "com.google.android.inputmethod.latin",
      "com.android.dialer",
      "com.android.messaging",
      "com.samsung.android.messaging",
      "com.samsung.android.dialer",
      "com.google.android.apps.safetyhub",
      "com.google.android.cellbroadcastreceiver",
      "com.android.providers.telephony",
      "com.shannon.imsservice",
      "com.android.launcher3",
      "android",
      "com.example.keyboard",
    ]) {
      const res = await call("block_app", { device: "Sam's phone", package: name });
      expect(res.isError, name).toBe(true);
      expect(res.text, name).toMatch(/^Not blocked\. (The phone|Belay) (says it )?never blocks/);
    }
    expect(policy().apps.decisions).toEqual([]);
    const apps = (await call("get_installed_apps", { device: "Sam's phone", include_system: true })).json.apps as { untrusted: { package: string }; rule: string }[];
    expect(apps.find((a) => a.untrusted.package === "com.example.keyboard")?.rule).toBe("runs (the phone never blocks it)");
    expect(apps.find((a) => a.untrusted.package === "com.google.android.inputmethod.latin")?.rule).toBe("runs (system app)");
  });

  it("on the parent page and in the CLI: the block isn't saved, and the page says why", async () => {
    const { t, sam, phone, policy } = await family();
    const res = await postForm(t, `/devices/${phone.deviceId}/decide`, { _csrf: sam.csrf, block: "com.google.android.dialer" }, { cookie: sam.cookie });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("The phone never blocks its dialer: 911 and 988 must always work.");
    const page = await (await t.app.request(`/devices/${phone.deviceId}/apps/com.google.android.inputmethod.latin`, { headers: { cookie: sam.cookie } })).text();
    expect(page).toContain("The phone never blocks its keyboard: texting 988 needs one.");
    expect(page).not.toContain('name="block"');
    const err: string[] = [];
    const code = await runCommand(["decide", "Sam's phone", "com.android.messaging", "block"], {
      db: t.deps.db,
      config: t.deps.config,
      now: t.now(),
      out: () => undefined,
      err: (line) => err.push(line),
      readSecret: () => Promise.resolve(""),
      interactive: false,
    });
    expect({ code, err }).toEqual({ code: 1, err: ["The phone never blocks its texting app: texting 988 must always work."] });
    expect(policy().version).toBe(0);
  });
});
