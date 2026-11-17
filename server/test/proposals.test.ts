/**
 * A proposal is checked again when a parent approves it: if what it was about changed since it
 * was made, it's out of date, and nothing is applied (the security review's "stale proposals").
 */
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { DNS_FILTERS, answerRequest, buildPolicy, currentDecision, decideApp, pausePhone, protect, setWeb, type PolicyContext } from "../src/family/policy.js";
import { approveProposal, createProposal, getProposal, type ProposalChange } from "../src/family/proposals.js";
import { deviceCall, enrollPhone, event, get, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

const MIN = 60_000;

async function family() {
  const t = testServer();
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Sam's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps", { label: "Trail Maps" }), pkg("com.example.chat", { label: "Chatter Box" })], T0));
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const claude = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
  const propose = (change: ProposalChange, reason = "x") => createProposal(t.deps.db, t.now(), phone.deviceId, change, reason, { parentId: sam.parent.id, clientName: "Claude" }).proposal;
  const approve = (id: string) => approveProposal(ctx(), id, sam.parent.id);
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, ctx, parent, claude, propose, approve, policy };
}

describe("approving a proposal that's out of date", () => {
  it("an old 'resume' doesn't end a different pause a parent set later", async () => {
    const { t, phone, ctx, parent, claude, propose, approve, policy } = await family();
    pausePhone(ctx(), phone.deviceId, { minutes: 30, note: "Lunch" }, claude);
    const stale = propose({ kind: "resume" }, "Lunch is over");
    t.advance(60 * MIN); // the AI's pause ended on its own
    pausePhone(ctx(), phone.deviceId, { minutes: null, note: "Grounded" }, parent);
    const version = policy().version;
    expect(approve(stale.id)).toEqual({ ok: false, outdated: true, reason: "The phone was paused again after this was proposed: it's a different pause now." });
    expect(policy()).toMatchObject({ version, pause: { until: null, note: "Grounded" } });
    expect(getProposal(t.deps.db, stale.id)).toMatchObject({ status: "outdated", decidedBy: "Sam", outdatedWhy: expect.stringContaining("different pause") as unknown });
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "proposal.outdated", detail: { change: "Resume the paused phone", client: "Claude" } });
    expect(approve(stale.id)).toEqual({ ok: false, reason: "It was already out of date." });
  });

  it("an old 'allow_app' doesn't unblock an app a parent blocked after it", async () => {
    const { t, phone, ctx, parent, propose, approve, policy } = await family();
    const stale = propose({ kind: "allow_app", package: "com.example.chat" }, "It's fine");
    t.advance(MIN);
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", parent, { note: "Strangers message kids here" });
    expect(approve(stale.id)).toMatchObject({ ok: false, outdated: true, reason: "The app's rule changed after this was proposed." });
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.chat")).toMatchObject({ state: "blocked", decidedBy: "parent" });
    expect(policy().apps.decisions).toEqual([{ package: "com.example.chat", state: "blocked" }]);
  });

  it("an 'allow_app' made after the block it would lift still applies", async () => {
    const { t, phone, ctx, claude, propose, approve } = await family();
    decideApp(ctx(), phone.deviceId, "com.example.chat", "blocked", claude);
    const fresh = propose({ kind: "allow_app", package: "com.example.chat" }, "It's the class chat");
    t.advance(60 * MIN);
    expect(approve(fresh.id).ok).toBe(true);
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.chat")).toMatchObject({ state: "allowed", decidedBy: "parent", proposalId: fresh.id });
  });

  it("an 'allow_app' for an app whose request a parent declined since is out of date", async () => {
    const { t, phone, ctx, parent, propose, approve } = await family();
    protect(ctx(), phone.deviceId, parent);
    await deviceCall(t, phone.token, "events", { events: [event("installed", "com.example.game", { to: { code: 1 }, happened_at: t.now() - 1000, detected_at: t.now() })] });
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "app", package: "com.example.game", label: "Block Party", asked_at: t.now() }] });
    const stale = propose({ kind: "allow_app", package: "com.example.game" });
    t.advance(MIN);
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", parent, "Not yet");
    expect(approve(stale.id)).toMatchObject({ ok: false, outdated: true, reason: "A parent answered the kid's request for this app after this was proposed." });
    expect(currentDecision(t.deps.db, phone.deviceId, "com.example.game")).toBeNull();
  });

  it("one that wouldn't loosen anything any more is out of date too", async () => {
    const { t, phone, ctx, claude, propose, approve } = await family();
    pausePhone(ctx(), phone.deviceId, { minutes: 30 }, claude);
    const resume = propose({ kind: "resume" });
    t.advance(31 * MIN);
    expect(approve(resume.id)).toMatchObject({ ok: false, outdated: true, reason: "The phone isn't paused." });
  });

  it("a 'web_filter_off' made before the parent changed filters is out of date", async () => {
    const { phone, ctx, parent, propose, approve, policy } = await family();
    protect(ctx(), phone.deviceId, parent);
    const stale = propose({ kind: "web_filter_off" });
    setWeb(ctx(), phone.deviceId, { privateDns: DNS_FILTERS.adguard.host }, parent);
    expect(approve(stale.id)).toMatchObject({ ok: false, outdated: true, reason: "The web filter changed after this was proposed." });
    expect(policy().web.private_dns).toBe(DNS_FILTERS.adguard.host);
    // A new one, about the filter there now, applies.
    expect(approve(propose({ kind: "web_filter_off" }).id).ok).toBe(true);
    expect(policy().web.private_dns).toBeNull();
  });

  it("the Proposals page warns before approving, and says why nothing changed after", async () => {
    const { t, sam, phone, ctx, parent, claude, propose, policy } = await family();
    pausePhone(ctx(), phone.deviceId, { minutes: 30 }, claude);
    const stale = propose({ kind: "resume" }, "Lunch is over");
    t.advance(60 * MIN);
    pausePhone(ctx(), phone.deviceId, { minutes: 120, note: "Homework" }, parent);
    let html = await (await get(t, "/proposals", sam.cookie)).text();
    expect(html).toContain("This is out of date: The phone was paused again after this was proposed: it&#39;s a different pause now. Approving it changes nothing");
    const res = await postForm(t, `/proposals/${stale.id}/approve`, { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(res.status).toBe(409);
    expect(await res.text()).toContain("Nothing changed: that proposal was out of date.");
    expect(policy().pause).toMatchObject({ note: "Homework" });
    html = await (await get(t, "/proposals", sam.cookie)).text();
    expect(html).toContain("Out of date");
    expect(html).toContain("not applied when Sam approved it");
    expect(html).toContain("Nothing is waiting for you.");
    expect(await (await get(t, "/activity", sam.cookie)).text()).toContain("approved Claude&#39;s proposal, but it was out of date, so nothing changed: Resume the paused phone (Sam&#39;s phone)");
  });
});
