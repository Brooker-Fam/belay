/**
 * Phase 5's contact request (docs/protocol.md, "Request", kind `contact`): the kid's name for the
 * contact and their reason are their words (untrusted, cleaned), the number E.164; one for a number
 * already waiting takes its place; withdrawn as other kinds are; parents hear about it; and a parent
 * approving it adds the contact with the calls and texts they chose (or names the contact that has
 * the number already, or unblocks a blocked one), while declining or "let's talk" adds no one. No
 * AI app answers it. Made-up names and 555-01xx numbers only.
 */
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { blockNumber, saveContact } from "../src/family/calls/changes.js";
import { answerRequest, buildPolicy, RuleRefused, type PolicyContext } from "../src/family/policy.js";
import { getRequest, listRequests } from "../src/family/requests.js";
import { browserFor, deviceCall, enrollPhone, signIn, testServer, type TestServer } from "./helpers.js";

const COACH = "+15555550142";

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const browser = browserFor(t, sam.parent.id, () => fetch.mock.calls);
  return { t, sam, phone, ctx, parent, fetch, policy, browser };
}

const send = (t: TestServer, token: string, ...requests: Record<string, unknown>[]) => deviceCall(t, token, "requests", { requests });
const ask = (t: TestServer, id: string, over: Record<string, unknown> = {}) => ({
  id,
  kind: "contact",
  contact_name: "Coach Lee",
  contact_number: COACH,
  reason: "My soccer coach",
  asked_at: t.now(),
  ...over,
});

describe("Please add this contact", () => {
  it("is saved with the kid's words, cleaned; the parents hear the name, never the number", async () => {
    const { t, phone, fetch, browser } = await family();
    const res = await send(t, phone.token, ask(t, "request-0001", { contact_name: "Coach‮ Lee\nthe best", reason: "Practice moved‮ to 5" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({
      kind: "contact",
      status: "pending",
      contactName: "Coach Lee the best",
      contactNumber: COACH,
      contactId: null,
      reason: "Practice moved to 5",
    });
    await vi.waitFor(() => {
      expect(fetch).toHaveBeenCalledTimes(1);
    });
    expect(browser.notices()).toEqual([{ title: "Belay", body: 'Alex\'s phone asks to add a contact: "Coach Lee the best": "Practice moved to 5"', url: "/requests", urgency: "normal" }]);
    expect(browser.notices()[0]?.body).not.toContain("555");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "phone", action: "request.made", detail: { kind: "contact", contact: "Coach Lee the best" } });
  });

  it("checks the request: a name of 1 to 60 characters and an E.164 number", async () => {
    const { t, phone } = await family();
    for (const bad of [
      ask(t, "request-0001", { contact_name: "" }),
      ask(t, "request-0001", { contact_name: "x".repeat(61) }),
      ask(t, "request-0001", { contact_number: "555-0142" }),
      ask(t, "request-0001", { contact_number: "911" }),
      ask(t, "request-0001", { package: "com.example.app" }),
    ]) {
      expect((await send(t, phone.token, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("a new one for the same number takes the waiting one's place, with its words; withdrawn as any other", async () => {
    const { t, phone, policy } = await family();
    await send(t, phone.token, ask(t, "request-0001"));
    await send(t, phone.token, ask(t, "request-0002", { contact_name: "Coach", reason: null }));
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("superseded");
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")).toMatchObject({ status: "pending", contactName: "Coach", reason: "My soccer coach" });
    expect(listRequests(t.deps.db, { deviceId: phone.deviceId, kind: "contact" }).map((r) => r.id)).toEqual(["request-0002"]);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]?.detail).toMatchObject({ kind: "contact", again: true });
    await send(t, phone.token, ask(t, "request-0002", { contact_name: "Coach", withdrawn_at: t.now() }));
    expect(getRequest(t.deps.db, phone.deviceId, "request-0002")?.status).toBe("withdrawn");
    expect(policy().requests).toEqual([]);
  });

  it("at most 60 can wait per phone; past that, new ones are answered 429", async () => {
    const { t, phone } = await family();
    const many = Array.from({ length: 60 }, (_, i) => ask(t, `request-${String(i).padStart(4, "0")}`, { contact_number: `+155555501${String(i).padStart(2, "0")}` }));
    expect((await send(t, phone.token, ...many)).status).toBe(200);
    expect((await send(t, phone.token, ask(t, "request-0100", { contact_number: "+15555550199" }))).status).toBe(429);
  });

  it("approving adds the contact with the parent's choices; it's in the policy and the activity log", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    await send(t, phone.token, ask(t, "request-0001"));
    const done = answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, "Sure!", { contact: { name: "Coach Lee (soccer)", calls: true, texts: false } });
    expect(done.result?.contact).toMatchObject({ name: "Coach Lee (soccer)", existing: false, unblocked: [] });
    const id = done.result?.contact?.id ?? "";
    expect(policy()).toMatchObject({
      version: done.version,
      requests: [{ id: "request-0001", status: "approved", note: "Sure!" }],
      contacts: [{ id, name: "Coach Lee (soccer)", numbers: [COACH], calls: true, texts: false, parent: false }],
    });
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")).toMatchObject({ status: "approved", contactId: id });
    expect(listAudit(t.deps.db, { limit: 2, includeReads: false }).map((e) => [e.action, e.detail?.kind ?? e.detail?.request])).toEqual([
      ["request.answered", "contact"],
      ["calls.changed", "request-0001"],
    ]);
    // Answering again adds no one.
    answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, null);
    expect(policy().contacts).toHaveLength(1);
  });

  it("without choices, the kid's name and calls and texts on; a contact with the number already adds no one", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    await send(t, phone.token, ask(t, "request-0001"));
    expect(answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, null).result?.contact?.name).toBe("Coach Lee");
    expect(policy().contacts).toMatchObject([{ name: "Coach Lee", calls: true, texts: true }]);
    await send(t, phone.token, ask(t, "request-0002", { contact_name: "Coach again" }));
    const again = answerRequest(ctx(), phone.deviceId, "request-0002", "approved", parent, null);
    expect(again.result?.contact).toMatchObject({ name: "Coach Lee", existing: true });
    expect(policy().contacts).toHaveLength(1);
  });

  it("approving a blocked number unblocks it; a name another contact has is refused, and nothing changes", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    blockNumber(ctx(), phone.deviceId, COACH, parent);
    saveContact(ctx(), phone.deviceId, { name: "Coach Lee", numbers: ["+15555550143"], calls: true, texts: true, parent: false }, parent);
    await send(t, phone.token, ask(t, "request-0001"));
    expect(() => answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, null)).toThrow(RuleRefused);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("pending");
    const done = answerRequest(ctx(), phone.deviceId, "request-0001", "approved", parent, null, { contact: { name: "Coach Lee (new)" } });
    expect(done.result?.contact?.unblocked).toEqual([COACH]);
    expect(policy()).toMatchObject({ blocked_numbers: [] });
    expect(policy().contacts.map((c) => c.name)).toEqual(["Coach Lee", "Coach Lee (new)"]);
  });

  it("declining or let's talk adds no one; the kid sees the answer", async () => {
    const { t, phone, ctx, parent, policy } = await family();
    await send(t, phone.token, ask(t, "request-0001"), ask(t, "request-0002", { contact_number: "+15555550143" }));
    answerRequest(ctx(), phone.deviceId, "request-0001", "declined", parent, "Not this one");
    answerRequest(ctx(), phone.deviceId, "request-0002", "talk", parent, null);
    expect(policy()).toMatchObject({ contacts: [] });
    expect(policy().requests.map((r) => [r.id, r.status])).toEqual(
      expect.arrayContaining([
        ["request-0001", "declined"],
        ["request-0002", "talk"],
      ]),
    );
  });

  it("only a person answers it", async () => {
    const { t, sam, phone, ctx } = await family();
    await send(t, phone.token, ask(t, "request-0001"));
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
    expect(() => answerRequest(ctx(), phone.deviceId, "request-0001", "approved", ai as never, null)).toThrow(/can't loosen/);
    expect(getRequest(t.deps.db, phone.deviceId, "request-0001")?.status).toBe("pending");
  });
});
