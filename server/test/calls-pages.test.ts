/**
 * Phase 5 on the parent pages: a phone's Calls tab (turning calls on and off, with what that means
 * for 911 and 988; the rules; contacts; private and blocked numbers; recent calls with "Add as
 * contact" and "Block"), the kid's contact request on the Requests page, a calls proposal's details,
 * and Settings' retention and AI scope. Server-rendered, CSRF on every form. Made-up names and
 * 555-01xx numbers only.
 */
import { describe, expect, it } from "vitest";
import { Policy } from "../src/device/schemas.js";
import { saveContact, setCalls } from "../src/family/calls/changes.js";
import { patchOf, sideOf } from "../src/family/calls/patch.js";
import { buildPolicy } from "../src/family/policy.js";
import { createProposal } from "../src/family/proposals.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, postForm, signIn, testServer, T0 } from "./helpers.js";

const MOM = "+15555550100";
const COACH = "+15555550142";
const STRANGER = "+15555550199";

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const base = `/devices/${phone.deviceId}`;
  const form = (path: string, fields: Record<string, string | string[]>, csrf = true) => postForm(t, path, { ...(csrf ? { _csrf: sam.csrf } : {}), ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => {
    const res = await get(t, path, sam.cookie);
    return { status: res.status, html: await res.text() };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const ctx = () => ({ db: t.deps.db, now: t.now() });
  return { t, sam, phone, base, form, page, policy, parent, ctx };
}

const RULES = { mode: "contacts", unknown: "voicemail", withheld: "reject", outgoing: "any", quiet: "1", log: "1" };

describe("the Calls tab", () => {
  it("needs a parent signed in, and every form needs the CSRF token", async () => {
    const { t, base, form } = await family();
    const res = await get(t, `${base}/calls`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    for (const path of [
      `${base}/calls`,
      `${base}/calls/off`,
      `${base}/calls/contacts`,
      `${base}/calls/contacts/c-1/remove`,
      `${base}/calls/blocked`,
      `${base}/calls/blocked/remove`,
      `${base}/calls/private`,
      `${base}/calls/private/remove`,
    ]) {
      expect((await form(path, { ...RULES, enabled: "1", name: "X", number: STRANGER }, false)).status, path).toBe(403);
      expect((await postForm(t, path, { ...RULES, enabled: "1" })).status, path).toBe(401);
    }
  });

  it("off until a parent turns calls on, saying plainly what that means for 911 and 988; then the rules reach the phone", async () => {
    const { base, form, page, policy } = await family();
    const first = await page(`${base}/calls`);
    let { html } = first;
    expect(first.status).toBe(200);
    expect(html).toContain("Calls are off: Belay leaves calls alone on this phone.");
    expect(html).toContain("Belay then becomes the phone&#39;s phone app");
    expect(html).toContain("<strong>911, 988 and every emergency number always work</strong>: the kid can call them in every mode, even when the phone is paused or at bedtime");
    expect(html).toContain("a call from 911 or another emergency number always rings, unless the phone network says its caller ID is fake");
    expect(html).toContain("Belay never records calls with them.");
    expect(html).toContain("Turn calls on</button>");
    expect(html).toContain('href="' + base + '/calls" aria-current="page">Calls</a>');
    const on = await form(`${base}/calls`, { ...RULES, enabled: "1" });
    expect(on.status).toBe(302);
    expect(on.headers.get("location")).toBe(`${base}/calls?saved=calls_on#calls`);
    expect(policy().calls).toEqual({ mode: "contacts", unknown: "voicemail", withheld: "reject", outgoing: "any", quiet: true, log: true });
    ({ html } = await page(`${base}/calls?saved=calls_on`));
    expect(html).toContain("Calls are on: Belay becomes the phone app when the phone gets this");
    expect(html).toContain("Only contacts can call. Callers who aren&#39;t contacts go to voicemail.");
    expect(html).toContain("Turn calls off</button>");
    // Unticked boxes are off.
    expect((await form(`${base}/calls`, { mode: "open", unknown: "ring", withheld: "ring", outgoing: "contacts" })).headers.get("location")).toBe(`${base}/calls?saved=rules#calls`);
    expect(policy().calls).toEqual({ mode: "open", unknown: "ring", withheld: "ring", outgoing: "contacts", quiet: false, log: false });
    for (const bad of [{ ...RULES, mode: "everyone" }, { ...RULES, outgoing: "some" }, { ...RULES, unknown: "maybe" }]) {
      expect((await form(`${base}/calls`, bad)).status, JSON.stringify(bad)).toBe(400);
    }
    expect((await form(`${base}/calls/off`, {})).headers.get("location")).toBe(`${base}/calls?saved=calls_off#calls`);
    expect(policy().calls).toBeNull();
  });

  it("says when calls go through the phone's own app, with Belay's own words quoted", async () => {
    const { t, phone, base, form, page } = await family();
    await form(`${base}/calls`, { ...RULES, enabled: "1" });
    await deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: 1, calls: { dialer: false, problem: "<b>Role lost</b>" } } }) });
    const { html } = await page(`${base}/calls`);
    expect(html).toContain("Calls are going through the phone&#39;s own app, so Belay can&#39;t decide who rings or keep a record of calls.");
    expect(html).toContain("<blockquote>&lt;b&gt;Role lost&lt;/b&gt;</blockquote>");
    expect((await page(base)).html).toContain("Calls are going through the phone&#39;s own app");
  });

  it("contacts: added, edited and removed; names escaped; problems shown on the tab, nothing saved", async () => {
    const { base, form, page, policy } = await family();
    let res = await form(`${base}/calls/contacts`, { name: "<i>Coach</i>", number: [COACH, "", ""], calls: "1" });
    expect(res.headers.get("location")).toBe(`${base}/calls?saved=contact#contacts`);
    const [coach] = policy().contacts;
    expect(coach).toMatchObject({ name: "<i>Coach</i>", numbers: [COACH], calls: true, texts: false, parent: false });
    let { html } = await page(`${base}/calls`);
    expect(html).toContain("<strong>&lt;i&gt;Coach&lt;/i&gt;</strong>");
    expect(html).not.toContain("<i>Coach</i>");
    // Texts aren't built yet: the choice says so, and so does each contact's line. The field stays, for when they are.
    expect(html).toContain("Can text (not enforced yet: for now, texting works with anyone)");
    expect(html).toContain("calls · no texts, not enforced yet");
    await form(`${base}/calls/contacts`, { id: coach?.id ?? "", name: "Coach Lee", number: [COACH, "+15555550143"], calls: "1", texts: "1", parent: "" });
    expect(policy().contacts).toEqual([{ id: coach?.id, name: "Coach Lee", numbers: [COACH, "+15555550143"], calls: true, texts: true, parent: false }]);
    const problems: [Record<string, string | string[]>, string][] = [
      [{ name: "Dad", number: [COACH] }, "+15555550142 is already Coach Lee&#39;s number."],
      [{ name: "Dad", number: ["555-0100"] }, "555-0100 isn&#39;t a phone number in international form"],
      [{ name: "Dad", number: ["911"] }, "911 and every emergency number always work without being a contact"],
      [{ name: "Dad", number: [""] }, "Give the contact a number"],
      [{ name: "", number: [MOM] }, "Give the contact a name"],
    ];
    for (const [fields, words] of problems) {
      res = await form(`${base}/calls/contacts`, fields);
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(await res.text(), JSON.stringify(fields)).toContain(words);
    }
    expect(policy().contacts).toHaveLength(1);
    res = await form(`${base}/calls/contacts/${coach?.id ?? ""}/remove`, {});
    expect(res.headers.get("location")).toBe(`${base}/calls?saved=contact_removed#contacts`);
    expect(policy().contacts).toEqual([]);
    ({ html } = await page(`${base}/calls`));
    expect(html).toContain("No contacts yet.");
  });

  it("warns about emergency-card numbers that aren't contacts, with a button to add each as a parent", async () => {
    const { base, form, page, policy } = await family();
    await form("/settings/parent-numbers", { name: ["Mom"], number: [MOM] });
    let { html } = await page(`${base}/calls`);
    expect(html).toContain("On the kid&#39;s emergency card but not a contact:");
    expect(html).toContain("Add Mom (+15555550100) as a parent</button>");
    await form(`${base}/calls/contacts`, { name: "Mom", number: MOM, calls: "1", texts: "1", parent: "1" });
    expect(policy().contacts).toMatchObject([{ name: "Mom", numbers: [MOM], parent: true }]);
    ({ html } = await page(`${base}/calls`));
    expect(html).not.toContain("On the kid&#39;s emergency card but not a contact:");
  });

  it("blocked and private numbers: added and removed; 911 and 988 refused with why", async () => {
    const { base, form, page, policy } = await family();
    expect((await form(`${base}/calls/blocked`, { number: "+1 555 555 0199" })).headers.get("location")).toBe(`${base}/calls?saved=blocked#blocked`);
    expect(policy().blocked_numbers).toEqual([STRANGER]);
    for (const n of ["911", "988"]) {
      const res = await form(`${base}/calls/blocked`, { number: n });
      expect(res.status).toBe(400);
      expect(await res.text()).toContain(`Belay never blocks ${n === "911" ? "911 or any other emergency number" : "988"}`);
    }
    let { html } = await page(`${base}/calls`);
    expect(html).toContain("Blocking works only while calls are on.");
    expect(html).toContain('<strong class="pkg">+15555550199</strong>');
    expect((await form(`${base}/calls/blocked/remove`, { number: STRANGER })).headers.get("location")).toBe(`${base}/calls?saved=unblocked#blocked`);
    expect(policy().blocked_numbers).toEqual([]);
    expect((await form(`${base}/calls/private`, { number: "+15555550177" })).headers.get("location")).toBe(`${base}/calls?saved=private#private`);
    expect(policy().private_numbers).toEqual(["+15555550177"]);
    expect((await form(`${base}/calls/private`, { number: "988" })).status).toBe(400);
    ({ html } = await page(`${base}/calls`));
    expect(html).toContain("Only a parent sees which numbers they are: AI apps see how many.");
    // A private number isn't blocked while it's private: a parent takes it off them first.
    const helpline = await form(`${base}/calls/blocked`, { number: "+15555550177" });
    expect(helpline.status).toBe(400);
    expect(await helpline.text()).toContain("+15555550177 is one of the private numbers, which Belay never records, like a helpline the kid may call: take it off the private numbers first");
    expect(policy().blocked_numbers).toEqual([]);
    await form(`${base}/calls/private/remove`, { number: "+15555550177" });
    expect(policy().private_numbers).toEqual([]);
    expect((await form(`${base}/calls/blocked`, { number: "+15555550177" })).status).toBe(302);
    expect(policy().blocked_numbers).toEqual(["+15555550177"]);
  });

  it("recent calls, with Add as contact and Block beside a caller who isn't a contact", async () => {
    const { t, phone, base, form, page, policy, parent, ctx } = await family();
    await form(`${base}/calls`, { ...RULES, enabled: "1" });
    const mom = saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, parent).result.contact;
    await deviceCall(t, phone.token, "calls", {
      calls: [
        { id: "call-00000001", at: T0 - 3_600_000, direction: "out", contact_id: mom.id, duration_s: 125, outcome: "answered" },
        { id: "call-00000002", at: T0 - 1_800_000, direction: "in", number: STRANGER, duration_s: 0, outcome: "rejected", reason: "unknown" },
      ],
    });
    let { html } = await page(`${base}/calls`);
    expect(html).toContain("Outgoing: <strong>Mom</strong>");
    expect(html).toContain("answered");
    expect(html).toContain("2 minutes");
    expect(html).toContain('Incoming: <strong class="pkg">+15555550199</strong>');
    expect(html).toContain("refused · not a contact");
    expect(html).toContain("Add as contact</button>");
    expect(html).toContain("Block</button>");
    await form(`${base}/calls/contacts`, { name: "Neighbor", number: STRANGER, calls: "1", texts: "1" });
    expect(policy().contacts.map((c) => c.name)).toEqual(["Mom", "Neighbor"]);
    ({ html } = await page(`${base}/calls`));
    expect(html).not.toContain("Add as contact</button>");
  });
});

describe("the kid's contact request on the Requests page", () => {
  it("shows the kid's words escaped; approving with the parent's name and choices adds the contact", async () => {
    const { t, phone, base, form, page, policy } = await family();
    await deviceCall(t, phone.token, "requests", {
      requests: [{ id: "request-0001", kind: "contact", contact_name: "<b>Coach</b>", contact_number: COACH, reason: "My <i>coach</i>", asked_at: t.now() }],
    });
    let { html } = await page("/requests");
    expect(html).toContain("Add a contact</strong>");
    expect(html).toContain('<span class="kid">&lt;b&gt;Coach&lt;/b&gt;</span>');
    expect(html).toContain("My &lt;i&gt;coach&lt;/i&gt;");
    expect(html).toContain("Calls are off on this phone: the contact is kept for when you turn them on");
    expect(html).toContain("Can text (not enforced yet: for now, texting works with anyone)");
    const res = await form(`${base}/requests/request-0001/answer`, { back: "requests", answer: "approved", contact_form: "1", contact_name: "Coach Lee", contact_calls: "1", note: "OK" });
    expect(res.headers.get("location")).toBe("/requests?saved=answer_contact");
    expect(policy().contacts).toMatchObject([{ name: "Coach Lee", numbers: [COACH], calls: true, texts: false, parent: false }]);
    ({ html } = await page("/requests?saved=answer_contact"));
    expect(html).toContain("Approved, and they&#39;re a contact now.");
    // The history keeps the kid's own words.
    expect(html).toContain("Add &lt;b&gt;Coach&lt;/b&gt; (+15555550142) as a contact");
  });

  it("says when the number is a contact already, or blocked; a refused approval says why, and nothing changes", async () => {
    const { t, phone, base, form, page, policy } = await family();
    await form(`${base}/calls/contacts`, { name: "Coach Lee", number: "+15555550143", calls: "1", texts: "1" });
    await form(`${base}/calls/blocked`, { number: COACH });
    await deviceCall(t, phone.token, "requests", {
      requests: [
        { id: "request-0001", kind: "contact", contact_name: "Coach", contact_number: COACH, asked_at: t.now() },
        { id: "request-0002", kind: "contact", contact_name: "Coach", contact_number: "+15555550143", asked_at: t.now() },
      ],
    });
    const { html } = await page("/requests");
    expect(html).toContain("That number is blocked on this phone. Approving unblocks it.");
    expect(html).toContain("That number is already a contact: Coach Lee. Approving adds no one else.");
    const refused = await form(`${base}/requests/request-0001/answer`, { back: "requests", answer: "approved", contact_form: "1", contact_name: "Coach Lee", contact_calls: "1" });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Nothing changed. There&#39;s already a contact called Coach Lee.");
    expect(policy().blocked_numbers).toEqual([COACH]);
    const existing = await form(`${base}/requests/request-0002/answer`, { back: "requests", answer: "approved" });
    expect(existing.headers.get("location")).toBe("/requests?saved=answer_contact_existing");
    expect(policy().contacts).toHaveLength(1);
  });
});

describe("a calls proposal, Settings and the activity log", () => {
  it("the Proposals page lists each change with its effect", async () => {
    const { t, sam, phone, page, parent, ctx } = await family();
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    const current = sideOf(t.deps.db, phone.deviceId);
    const patch = patchOf(current, { ...current, rules: { ...current.rules, quiet: true, outgoing: "contacts" }, blockedNumbers: [STRANGER], contacts: [{ id: "c-gran-000001", name: "<Grandma>", numbers: ["+15555550123"], calls: true, texts: true, parent: false }] });
    createProposal(t.deps.db, t.now(), phone.deviceId, { kind: "calls", patch }, "Grandma got a phone", { parentId: sam.parent.id, clientName: "Claude" });
    const { html } = await page("/proposals");
    expect(html).toContain("Change calls: the kid can call only contacts (and 3 more changes)");
    expect(html).toContain('Add &quot;&lt;Grandma&gt;&quot; (+15555550123) as a contact, who can call and text <span class="chip blocked">loosens</span>');
    expect(html).toContain('Block +15555550199 <span class="chip allowed">tightens</span>');
  });

  it("Settings: how long call records are kept, and the Calls category, off until a parent ticks it", async () => {
    const { form, page } = await family();
    let { html } = await page("/settings");
    expect(html).toContain('name="call_days" min="1" max="365" required="" value="90"');
    expect(html).toContain('value="calls"/> Calls: who the kid calls and who calls them');
    expect(html).not.toContain('value="calls" checked');
    const res = await form("/settings", { timezone: "America/New_York", silent_hours: "12", call_days: "30", ai_scope: ["apps", "calls"] });
    expect(res.status).toBe(302);
    expect((await form("/settings", { timezone: "America/New_York", silent_hours: "12", call_days: "0" })).status).toBe(400);
    ({ html } = await page("/settings"));
    expect(html).toContain('value="30"');
    expect(html).toContain('value="calls" checked=""');
  });

  it("the activity log says who turned calls on and what changed", async () => {
    const { base, form, page } = await family();
    await form(`${base}/calls`, { ...RULES, enabled: "1" });
    await form(`${base}/calls/blocked`, { number: STRANGER });
    const { html } = await page("/activity");
    expect(html).toContain("Sam on the web</strong> changed calls (Alex&#39;s phone): Block +15555550199");
    expect(html).toContain("Sam on the web</strong> turned calls on (Alex&#39;s phone)");
  });
});
