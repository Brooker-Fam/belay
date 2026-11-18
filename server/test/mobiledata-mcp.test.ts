/**
 * Phase 13's Wi-Fi-only apps, tighten or loosen (docs/design/phase13-mobile-data.md): adding an app
 * tightens, taking one off loosens, a mix loosens; change_wifi_only applies a tightening at once and
 * turns anything that takes an app off into a proposal; approving it applies it in the parent's
 * name, and an out-of-date one changes nothing. Never an app the phone never blocks, for anyone, and
 * for an AI app never one the phone hasn't reported. get_mobile_data under the Mobile data category,
 * app names only with Apps too; get_policy says how many are Wi-Fi only. Made-up apps only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { changeWifiOnly, setMobileDataMeasure } from "../src/family/mobiledata/changes.js";
import { classifyWifiOnlyChange } from "../src/family/mobiledata/classify.js";
import { wifiOnlyApps } from "../src/family/mobiledata/store.js";
import { wifiOnlyTitle, wifiOnlyWords } from "../src/family/mobiledata/words.js";
import { RuleRefused, buildPolicy, type PolicyContext } from "../src/family/policy.js";
import { approveProposal, changeWords, listProposals, rejectProposal } from "../src/family/proposals.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, pkg, snapshot, testServer, T0 } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MB = 1_000_000;
type Json = Record<string, any>;

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(
    t,
    phone.token,
    "inventory",
    snapshot([pkg("com.example.video", { label: "Video Tube" }), pkg("com.example.blocks", { label: "Block Party" }), pkg("com.example.maps", { label: "Trail Maps" })], T0),
  );
  const { token } = createPersonalToken(t.deps.db, t.now(), parent.id, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const person = { kind: "parent", parentId: parent.id } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = (res.content as { type: string; text: string }[])[0]?.text ?? "";
    let json: Json = {};
    try {
      json = JSON.parse(text) as Json;
    } catch {
      // A refusal is words.
    }
    return { json, text, isError: res.isError === true };
  };
  return { t, client, phone, parent, ctx, person, policy, call };
}

describe("classifyWifiOnlyChange", () => {
  it("adding tightens, taking off loosens, a mix loosens, nothing is none", () => {
    expect(classifyWifiOnlyChange([], ["com.example.video"])).toEqual({
      changes: [{ kind: "added", packages: ["com.example.video"], effect: "tightens" }],
      none: false,
      onlyTightens: true,
      effect: "tightens",
    });
    expect(classifyWifiOnlyChange(["com.example.video", "com.example.blocks"], ["com.example.blocks"])).toMatchObject({
      changes: [{ kind: "removed", packages: ["com.example.video"], effect: "loosens" }],
      onlyTightens: false,
      effect: "loosens",
    });
    expect(classifyWifiOnlyChange(["com.example.video"], ["com.example.blocks"])).toMatchObject({
      changes: [
        { kind: "added", packages: ["com.example.blocks"] },
        { kind: "removed", packages: ["com.example.video"] },
      ],
      onlyTightens: false,
      effect: "loosens",
    });
    expect(classifyWifiOnlyChange(["com.example.video"], ["com.example.video"])).toMatchObject({ changes: [], none: true, onlyTightens: false, effect: "none" });
  });

  it("words each part for the parent, by name, or counted without the Apps category", () => {
    const label = (p: string) => ({ "com.example.video": "Video Tube", "com.example.blocks": "Block Party" })[p] ?? p;
    const patch = { add: ["com.example.blocks"], remove: ["com.example.video"] };
    expect(wifiOnlyWords(patch, label)).toEqual([
      { effect: "loosens", words: "Let Video Tube use mobile data again", gerund: "letting Video Tube use mobile data again" },
      { effect: "tightens", words: "Make Block Party Wi-Fi only", gerund: "making Block Party Wi-Fi only" },
    ]);
    expect(wifiOnlyTitle(patch, label)).toEqual({
      title: "Let Video Tube use mobile data again, and make Block Party Wi-Fi only",
      gerund: "letting Video Tube use mobile data again, and making Block Party Wi-Fi only",
    });
    expect(wifiOnlyTitle({ add: [], remove: ["com.example.video", "com.example.blocks"] }, null).title).toBe("Let 2 apps use mobile data again");
    expect(changeWords({ kind: "mobile_data", patch: { add: [], remove: ["com.example.video"] } }, null, label).title).toBe("Let Video Tube use mobile data again");
  });
});

describe("the Wi-Fi-only apps", () => {
  it("never an app the phone never blocks, for a parent either; an AI app only the phone's own apps", async () => {
    const { t, phone, ctx, person } = await family();
    for (const never of ["com.google.android.apps.messaging", "com.android.phone", "family.brooker.belay", "com.google.android.dialer"]) {
      expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: [never], remove: [] }, person), never).toThrow(RuleRefused);
    }
    // Android's own parts the phone reported (a system app without an icon).
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.video", { label: "Video Tube" }), pkg("com.example.carrier", { system: true, launchable: false })], T0 + 1));
    expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.carrier"], remove: [] }, person)).toThrow("It's one of Android's own parts");
    const ai = { kind: "ai", parentId: person.parentId, clientName: "Claude" } as const;
    expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.later"], remove: [] }, ai)).toThrow("isn't an app this phone has reported");
    expect(changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.later"], remove: [] }, person).result.added).toEqual(["com.example.later"]);
    expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: [], remove: ["com.example.later"] }, ai)).toThrow(/can't take an app off/);
    expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: ["com.example.video"] }, person)).toThrow("at once");
    // At most 100 a phone.
    changeWifiOnly(ctx(), phone.deviceId, { add: Array.from({ length: 99 }, (_, i) => `com.example.app${i}`), remove: [] }, person);
    expect(() => changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: [] }, person)).toThrow("at most 100");
  });

  it("change_wifi_only: adding applies at once, in the activity log, and the phone gets a new policy", async () => {
    const { t, phone, policy, call } = await family();
    const version = policy().version;
    const done = await call("change_wifi_only", { device: "Alex's phone", change: { add: ["com.example.video"] }, reason: "It uses most of the plan." });
    expect(done.isError).toBe(false);
    expect(done.json).toMatchObject({ status: "done: it only tightens, so it applies at once", changes: [{ effect: "tightens", untrusted: { change: "Make Video Tube Wi-Fi only" } }] });
    expect(policy()).toMatchObject({ version: version + 1, mobile_data: { wifi_only: ["com.example.video"], measure: false } });
    expect(wifiOnlyApps(t.deps.db, phone.deviceId)).toMatchObject([{ package: "com.example.video", addedBy: "ai", clientName: "Claude", parentName: "Sam" }]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "ai", action: "mobile_data.wifi_only_added", detail: { packages: ["com.example.video"], apps: ["Video Tube"] } });
    // Again: nothing changes.
    const again = await call("change_wifi_only", { device: "Alex's phone", change: { add: ["com.example.video"] }, reason: "Again." });
    expect(again.json.status).toBe("nothing changed: those apps were Wi-Fi only already");
    // Refused: the texting app, and an app the phone never reported.
    for (const add of [["com.google.android.apps.messaging"], ["com.example.never.seen"]]) {
      const refused = await call("change_wifi_only", { device: "Alex's phone", change: { add }, reason: "x" });
      expect(refused.isError, add[0]).toBe(true);
    }
    expect((await call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.blocks"] }, reason: "x" })).text).toContain("isn't Wi-Fi only");
  });

  it("change_wifi_only: taking one off is a proposal; approving applies it, rejecting changes nothing, an out-of-date one is marked so", async () => {
    const { t, phone, parent, ctx, person, policy, call } = await family();
    changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video", "com.example.blocks"], remove: [] }, person);
    const version = policy().version;
    const asked = await call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.video"], add: ["com.example.maps"] }, reason: "They're doing well." });
    expect(asked.json).toMatchObject({ status: "proposed: waiting for a parent to approve or reject it", where: "https://belay.example.org/proposals" });
    expect(asked.json.changes.map((c: Json) => c.effect)).toEqual(["loosens", "tightens"]);
    // Nothing changed yet, not even the part that tightens.
    expect(policy()).toMatchObject({ version, mobile_data: { wifi_only: ["com.example.blocks", "com.example.video"] } });
    const [proposal] = listProposals(t.deps.db, { deviceId: phone.deviceId, status: "pending" });
    expect(proposal?.change).toEqual({ kind: "mobile_data", patch: { add: ["com.example.maps"], remove: ["com.example.video"] } });
    // The same again is the same proposal.
    expect((await call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.video"], add: ["com.example.maps"] }, reason: "Again." })).json.note).toContain("already proposed");
    expect(approveProposal(ctx(), proposal?.id ?? "", parent.id)).toMatchObject({ ok: true });
    expect(policy().mobile_data.wifi_only).toEqual(["com.example.blocks", "com.example.maps"]);
    expect(listAudit(t.deps.db, { limit: 4, includeReads: false }).map((e) => e.action)).toEqual([
      "proposal.approved",
      "mobile_data.wifi_only_removed",
      "mobile_data.wifi_only_added",
      "proposal.created",
    ]);

    // One the parent already did is out of date when they approve it: nothing changes.
    await call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.blocks"] }, reason: "x" });
    const [stale] = listProposals(t.deps.db, { deviceId: phone.deviceId, status: "pending" });
    changeWifiOnly(ctx(), phone.deviceId, { add: [], remove: ["com.example.blocks"] }, person);
    const before = policy().version;
    expect(approveProposal(ctx(), stale?.id ?? "", parent.id)).toMatchObject({ ok: false, outdated: true });
    expect(policy().version).toBe(before);
    // Rejecting changes nothing.
    await call("change_wifi_only", { device: "Alex's phone", change: { remove: ["com.example.maps"] }, reason: "x" });
    const [rejected] = listProposals(t.deps.db, { deviceId: phone.deviceId, status: "pending" });
    expect(rejectProposal(t.deps.db, t.now(), rejected?.id ?? "", parent.id)).toMatchObject({ ok: true });
    expect(policy().mobile_data.wifi_only).toEqual(["com.example.maps"]);
  });

  it("measuring is never an AI app's: no tool turns it on or off", async () => {
    const { client } = await family();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      // No input called measure or measuring (screen time's if_unmeasured is about what Belay can't count).
      expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/"measur(e|ing)":/);
    }
  });
});

describe("get_mobile_data", () => {
  it("reads the days with the Mobile data category, names apps only with Apps too, and says which days are unknown", async () => {
    const { t, phone, ctx, person, call } = await family();
    setMobileDataMeasure(ctx(), phone.deviceId, true, person);
    changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: [] }, person);
    t.advance(60_000);
    const day = (d: string, apps: { package: string; bytes: number }[], from: number) => ({
      day: d,
      zone: "America/New_York",
      from,
      as_of: from + 3_600_000,
      complete: true,
      mobile_bytes: apps.reduce((n, a) => n + a.bytes, 0) + 5 * MB,
      wifi_bytes: 900 * MB,
      apps,
      android_bytes: 5 * MB,
      removed_bytes: 0,
      hotspot_bytes: 0,
    });
    expect(
      (
        await deviceCall(t, phone.token, "mobile-data", {
          days: [
            day("2026-11-16", [{ package: "com.example.video", bytes: 30 * MB }, { package: "com.example.blocks", bytes: 10 * MB }], t.now()),
            day("2026-11-14", [{ package: "com.example.blocks", bytes: 20 * MB }], T0 - 2 * 86_400_000),
          ],
        })
      ).status,
    ).toBe(200);
    const read = await call("get_mobile_data", { device: "Alex's phone", from: "2026-11-14", to: "2026-11-16" });
    expect(read.isError).toBe(false);
    expect(read.json.days.map((d: Json) => d.day)).toEqual(["2026-11-16", "2026-11-15", "2026-11-14"]);
    expect(read.json.days[1]).toMatchObject({ not_sent: "Belay sent nothing for this day: unknown, not none" });
    expect(read.json.days[0]).toMatchObject({ mobile_data: { bytes: 45 * MB, words: "45 MB" }, android_calls_and_texting: { words: "5 MB" } });
    expect(read.json.days[0].apps[0]).toEqual({ mobile_data: { bytes: 30 * MB, words: "30 MB" }, untrusted: { label: "Video Tube", package: "com.example.video" } });
    expect(read.json.period.top_apps.map((a: Json) => a.untrusted.package)).toEqual(["com.example.blocks", "com.example.video"]);
    // A Wi-Fi-only app that used mobile data on a day that began after it was added.
    expect(read.json.wifi_only.apps).toMatchObject([{ untrusted: { package: "com.example.video" }, used_mobile_data_after: { words: "30 MB" } }]);
    expect(read.json.measuring).toContain("on:");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: true })[0]).toMatchObject({ action: "ai.read", detail: { what: "mobile data use from 2026-11-14 to 2026-11-16" } });
    // Without Apps: package names only.
    updateSettings(t.deps.db, { aiScopes: { apps: false } });
    const unnamed = await call("get_mobile_data", { device: "Alex's phone", from: "2026-11-16", to: "2026-11-16" });
    expect(unnamed.json.days[0].apps[0].untrusted).toEqual({ package: "com.example.video" });
    expect(unnamed.json.app_names).toContain("Hidden");
    // Without Mobile data: nothing.
    updateSettings(t.deps.db, { aiScopes: { mobile_data: false } });
    const off = await call("get_mobile_data", { device: "Alex's phone" });
    expect(off.isError).toBe(true);
    expect(off.text).toContain("turned off AI access to mobile data use");
    expect((await call("get_mobile_data", { device: "Alex's phone", from: "2026-10-01", to: "2026-11-16" })).isError).toBe(true);
  });

  it("get_policy says how many apps are Wi-Fi only, and which with the Apps category", async () => {
    const { phone, ctx, person, call } = await family();
    changeWifiOnly(ctx(), phone.deviceId, { add: ["com.example.video"], remove: [] }, person);
    const read = await call("get_policy", { device: "Alex's phone" });
    expect(read.json.summary).toContain("Mobile data: 1 app is Wi-Fi only; measuring off (only a parent turns it on or off). get_mobile_data has the use.");
    expect(read.json.apps.wifi_only).toEqual([{ untrusted: { label: "Video Tube", package: "com.example.video" } }]);
  });
});
