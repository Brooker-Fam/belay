/**
 * Play's allowed accounts (docs/protocol.md, `play_accounts`; platform notes A4): the parent-owned
 * Google accounts Play may use, set by a parent on the phone's hardening card, checked as email
 * addresses, in the activity log by how many (never which), sent to the phone in its policy, and
 * emptied by a hand-over. AI apps see how many, never the addresses, and can't change them. Made-up
 * accounts only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { cancelHandover, handOver } from "../src/family/offbelay/changes.js";
import { RuleRefused, buildPolicy, getRules, playAccountsOf, setHardening, type PolicyContext } from "../src/family/policy.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { enrollPhone, get, postForm, signIn, testServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const at = (path: string) => `/devices/${phone.deviceId}${path}`;
  const send = (path: string, fields: Record<string, string>) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const page = async () => (await get(t, at(""), sam.cookie)).text();
  return { t, sam, phone, parent, ctx, policy, at, send, page };
}

describe("Play's allowed accounts", () => {
  it("are empty until a parent lists some: the phone then leaves Play's configuration alone", async () => {
    const { policy, page } = await family();
    expect(policy().play_accounts).toEqual([]);
    const html = await page();
    expect(html).toContain("Play Store: the parent-owned Google accounts Play may use, by email address, one per line");
    expect(html).toContain("leave it empty and Belay leaves Play&#39;s settings alone");
  });

  it("a parent lists them on the hardening card, with no name typed: lowercase, once each, in the next rules version", async () => {
    const { t, sam, phone, policy, at, send, page } = await family();
    const version = policy().version;
    const res = await send(at("/hardening"), { frp_accounts: "", play_accounts: " Parent@Gmail.com\nparent@gmail.com, co.parent+play@example.org " });
    expect(res.status).toBe(302);
    expect(policy()).toMatchObject({ version: version + 1, play_accounts: ["parent@gmail.com", "co.parent+play@example.org"], restrictions: { factory_reset: false, debugging: false } });
    expect(await page()).toContain("parent@gmail.com\nco.parent+play@example.org</textarea>");
    // The activity log says how many, never which.
    const [entry] = listAudit(t.deps.db, { limit: 1, includeReads: false });
    expect(entry).toMatchObject({ actor: "parent", action: "policy.hardening", detail: { on: ["play_accounts"], off: [], play_accounts: 2 } });
    expect(JSON.stringify(entry?.detail)).not.toContain("@");
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("changed factory reset, debugging, reset protection or the accounts Play may use");
    // Emptied: Belay takes its configuration back from Play.
    await send(at("/hardening"), { frp_accounts: "", play_accounts: "" });
    expect(policy().play_accounts).toEqual([]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ detail: { on: [], off: ["play_accounts"], play_accounts: 0 } });
    // A form without the field leaves them as they are.
    await send(at("/hardening"), { frp_accounts: "", play_accounts: "parent@gmail.com" });
    await send(at("/hardening"), { frp_accounts: "" });
    expect(policy().play_accounts).toEqual(["parent@gmail.com"]);
    expect(phone.deviceId).toBeTruthy();
  });

  it("refuses anything that isn't a Google account's email address, and more than 5, saving nothing", async () => {
    const { policy, at, send } = await family();
    for (const [given, why] of [
      ["parent", "&quot;parent&quot; isn&#39;t a Google account&#39;s email address."],
      ["parent@gmail", "&quot;parent@gmail&quot; isn&#39;t a Google account&#39;s email address."],
      ['parent"@gmail.com', "isn&#39;t a Google account&#39;s email address."],
      ["a1@example.org a2@example.org a3@example.org a4@example.org a5@example.org a6@example.org", "List at most 5 accounts for Play."],
    ] as const) {
      const res = await send(at("/hardening"), { frp_accounts: "", play_accounts: given });
      expect(res.status, given).toBe(400);
      expect(await res.text()).toContain(why);
    }
    expect(policy().play_accounts).toEqual([]);
    expect(() => playAccountsOf(["x@example.org,y@example.org"])).toThrow(RuleRefused);
    expect(playAccountsOf(["X@Example.ORG", "", "x@example.org"])).toEqual(["x@example.org"]);
  });

  it("a hand-over empties them, so Play may use the kid's own account, and nothing sets them again while it lasts", async () => {
    const { t, phone, parent, ctx, policy } = await family();
    setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [], playAccounts: ["parent@gmail.com"] }, parent);
    const done = handOver(ctx(), phone.deviceId, parent);
    expect(done.result).toMatchObject({ already: false, playAccounts: 1 });
    expect(policy()).toMatchObject({ play_accounts: [], handover: { at: t.now() } });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "policy.handover", detail: { play_accounts_removed: 1 } });
    expect(() => setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [], playAccounts: ["parent@gmail.com"] }, parent)).toThrow(/Cancel the hand-over first/);
    expect(getRules(t.deps.db, phone.deviceId).playAccounts).toEqual([]);
    cancelHandover(ctx(), phone.deviceId, parent);
    setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [], playAccounts: ["parent@gmail.com"] }, parent);
    expect(policy().play_accounts).toEqual(["parent@gmail.com"]);
  });

  it("AI apps see how many, never which, and can't change them", async () => {
    const { t, sam, phone, parent, ctx } = await family();
    setHardening(ctx(), phone.deviceId, { factoryReset: false, debugging: false, frpAccounts: [], playAccounts: ["parent@gmail.com", "co.parent@example.org"] }, parent);
    const { token } = createPersonalToken(t.deps.db, t.now(), sam.parent.id, "Claude", MCP);
    const client = new Client({ name: "belay-test", version: "1.0.0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(MCP), {
        fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
        requestInit: { headers: { authorization: `Bearer ${token}` } },
      }),
    );
    const res = await client.callTool({ name: "get_policy", arguments: { device: "Sam's phone" } });
    const text = (res.content as { text: string }[])[0]?.text ?? "";
    const json = JSON.parse(text) as { summary: string[]; only_a_parent_on_the_parent_page_changes: Record<string, unknown> };
    expect(json.summary).toContain("Google Play may use only the 2 parent-owned Google accounts a parent listed.");
    expect(json.only_a_parent_on_the_parent_page_changes).toMatchObject({ play_accounts: 2 });
    expect(text).not.toContain("@");
    // No tool and no kind of proposal touches them.
    const { tools } = await client.listTools();
    expect(JSON.stringify(tools.map((tool) => tool.inputSchema))).not.toContain("play");
  });
});
