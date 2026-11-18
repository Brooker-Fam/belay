/**
 * Phase 12: caregivers (docs/design/phase12-caregivers.md). A parent adds someone who looks after
 * the kid for a while, with their phones, what they may see and do, and an end at most 30 days
 * away; they join with a one-time link; they see and do only that, never anything that loosens;
 * the kid's policy lists them; every action is in the activity log; access ends at its time, or
 * at once when a parent ends it. Made-up names and places only.
 */
import { createECDH, randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { listAudit } from "../src/audit.js";
import { createFixWaiters } from "../src/device/fixwaiters.js";
import { Policy } from "../src/device/schemas.js";
import { getCaregiver, listCaregivers } from "../src/family/caregivers/store.js";
import { setLocation } from "../src/family/location/changes.js";
import { buildPolicy, getRules, pausePhone, resumePhone, type PolicyContext } from "../src/family/policy.js";
import { cleanUp } from "../src/maintenance.js";
import { updateSettings } from "../src/settings.js";
import { browserFor, device, deviceCall, enrollPhone, fix, get, PASSWORD, postForm, signIn, testServer, T0 } from "./helpers.js";

const MIN = 60_000;
const HOUR = 60 * MIN;
/** Thursday Nov 19 2026, 6:00 PM in New York: 3 days and 8 hours after T0. */
const THURSDAY_6PM = "2026-11-19T18:00";
const THURSDAY_6PM_MS = Date.UTC(2026, 10, 19, 23, 0, 0);

async function family() {
  const fetch = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(null, { status: 201 })));
  const t = testServer({ fetch: fetch as unknown as typeof globalThis.fetch });
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const other = await enrollPhone(t, "Jamie's phone");
  const form = (path: string, fields: Record<string, string | string[]> = {}) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const policy = (id = phone.deviceId) => Policy.parse(buildPolicy(t.deps.db, id, t.now()));
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  return { t, fetch, sam, phone, other, form, policy, ctx, parent };
}
type Family = Awaited<ReturnType<typeof family>>;

/** Adds a caregiver on the Caregivers page; the link it shows, and their id. */
async function add(f: Family, fields: Record<string, string | string[]> = {}) {
  const res = await f.form("/caregivers", { name: "Grandma", phone: [f.phone.deviceId], can: ["status", "pause", "help"], until: THURSDAY_6PM, ...fields });
  const html = await res.text();
  expect(res.status, html).toBe(200);
  const token = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(html)?.[1] ?? "";
  expect(token).not.toBe("");
  const id = listCaregivers(f.t.deps.db).find((c) => c.name === (typeof fields.name === "string" ? fields.name : "Grandma"))?.id ?? "";
  return { token, id, html };
}

/** The caregiver joins with their link: their cookie, CSRF token, and a way to post their forms. */
async function join(f: Family, token: string, username = "grandma") {
  const res = await postForm(f.t, `/care/join/${token}`, { username, password: PASSWORD, repeat: PASSWORD });
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("location")).toBe("/care");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  expect(cookie).toMatch(/^__Host-belay_care=/);
  const page = await (await get(f.t, "/care", cookie)).text();
  const csrf = /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? "";
  return {
    cookie,
    csrf,
    page: async (path = "/care") => {
      const r = await get(f.t, path, cookie);
      return { status: r.status, html: await r.text(), location: r.headers.get("location") };
    },
    form: (path: string, fields: Record<string, string | string[]> = {}) => postForm(f.t, path, { _csrf: csrf, ...fields }, { cookie }),
  };
}

const help = (id: string, at: number, over: Record<string, unknown> = {}) => ({ id, kind: "help", asked_at: at, ...over });

describe("adding a caregiver", () => {
  it("lists them in the phone's policy, with what they may do and until when, and shows their link once", async () => {
    const f = await family();
    const before = f.policy().version;
    const { html, id } = await add(f);
    expect(html).toContain("This is shown only once");
    expect(f.policy().caregivers).toEqual([{ name: "Grandma", until: THURSDAY_6PM_MS, can: ["status", "pause", "help"] }]);
    expect(f.policy().version).toBeGreaterThan(before);
    // Only the phones it covers.
    expect(f.policy(f.other.deviceId).caregivers).toEqual([]);
    const entry = listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0];
    expect(entry).toMatchObject({ actor: "parent", action: "caregiver.added", detail: { caregiver: "Grandma", phones: ["Alex's phone"], can: ["status", "pause", "help"], until: THURSDAY_6PM_MS } });
    expect(getCaregiver(f.t.deps.db, id)).toMatchObject({ joined: false, accessFrom: T0, endsAt: THURSDAY_6PM_MS, endedAt: null });
    // The Caregivers page lists them; the menu has it.
    const page = await (await get(f.t, "/caregivers", f.sam.cookie)).text();
    expect(page).toContain("Grandma");
    expect(page).toContain('href="/caregivers" aria-current="page"');
  });

  it("refuses a name that's too long, taken, or none; no phone; nothing to do; an end past 30 days or before now", async () => {
    const f = await family();
    await add(f);
    const tries: [Record<string, string | string[]>, string][] = [
      [{ name: "" }, "Name them in 1 to 40 characters"],
      [{ name: "G".repeat(41) }, "Name them in 1 to 40 characters"],
      [{ name: "grandma" }, "Another caregiver has that name already"],
      [{ name: "Coach Lee", phone: [] }, "Choose at least one phone"],
      [{ name: "Coach Lee", phone: ["no-such-phone"] }, "Choose phones from the list"],
      [{ name: "Coach Lee", can: [] }, "Choose at least one thing they may do"],
      [{ name: "Coach Lee", until: "2026-12-17T11:00" }, "Access lasts at most 30 days"],
      [{ name: "Coach Lee", until: "2026-11-16T09:00" }, "Choose an end later than now"],
      [{ name: "Coach Lee", until: "soon" }, "Choose when their access ends"],
    ];
    for (const [fields, words] of tries) {
      const res = await f.form("/caregivers", { name: "Coach Lee", phone: [f.phone.deviceId], can: ["status"], until: THURSDAY_6PM, ...fields });
      expect(res.status, JSON.stringify(fields)).toBe(400);
      expect(await res.text(), JSON.stringify(fields)).toContain(words);
    }
    expect(listCaregivers(f.t.deps.db).map((c) => c.name)).toEqual(["Grandma"]);
    // Exactly 30 days is fine.
    expect((await f.form("/caregivers", { name: "Coach Lee", phone: [f.phone.deviceId], can: ["status"], until: "2026-12-16T10:00" })).status).toBe(200);
  });

  it("cleans the name the kid sees: one line, nothing that hides or reorders text", async () => {
    const f = await family();
    await add(f, { name: "Gran‮ma​" });
    expect(f.policy().caregivers[0]?.name).toBe("Granma");
  });

  it("is a parent's alone: without a parent's session or CSRF token, nothing is made", async () => {
    const f = await family();
    const fields = { name: "Grandma", phone: [f.phone.deviceId], can: ["status"], until: THURSDAY_6PM };
    expect((await postForm(f.t, "/caregivers", fields)).status).toBe(401);
    expect((await postForm(f.t, "/caregivers", fields, { cookie: f.sam.cookie })).status).toBe(403);
    expect((await postForm(f.t, "/caregivers", { _csrf: f.sam.csrf, ...fields }, { cookie: f.sam.cookie, origin: "https://elsewhere.example" })).status).toBe(403);
    expect(listCaregivers(f.t.deps.db)).toEqual([]);
  });
});

describe("joining and signing in", () => {
  it("joins once with the link, choosing a username and password; signs in afterwards", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const page = await (await get(f.t, `/care/join/${token}`)).text();
    expect(page).toContain("Hello, Grandma");
    // Whose family it is: the parent who added them, and the phones.
    expect(page).toContain("Sam gave you some access to Alex&#39;s phone");
    // What they may do, in words for them; the parent's form has the parent's.
    expect(page).toContain("with the kid&#39;s number if a parent added it. Only what the kid asks from when a parent gave you this for that phone.");
    expect(page).not.toContain("if you added it");
    expect(await (await get(f.t, "/caregivers", f.sam.cookie)).text()).toContain("with the kid&#39;s number if you added it");
    expect(page).not.toContain("Check where the phone is now");
    // Before joining there's nothing to sign in with: no username, no password.
    expect((await postForm(f.t, "/care/login", { username: "grandma", password: PASSWORD })).status).toBe(401);
    expect((await postForm(f.t, "/care/login", { username: "", password: "" })).status).toBe(401);
    // A short password, or two that differ, isn't taken.
    expect((await postForm(f.t, `/care/join/${token}`, { username: "grandma", password: "short", repeat: "short" })).status).toBe(400);
    const care = await join(f, token);
    expect(getCaregiver(f.t.deps.db, id)).toMatchObject({ joined: true, username: "grandma", joinedAt: T0 });
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "caregiver", caregiverName: "Grandma", action: "caregiver.joined" });
    // The link works once.
    expect((await get(f.t, `/care/join/${token}`)).status).toBe(400);
    expect((await postForm(f.t, `/care/join/${token}`, { username: "someone", password: PASSWORD, repeat: PASSWORD })).status).toBe(400);
    // Signed in: their page. Then out, and in again.
    expect((await care.page()).status).toBe(200);
    expect((await care.form("/care/logout")).status).toBe(302);
    expect((await care.page()).location).toBe("/care/login?next=%2Fcare");
    expect((await postForm(f.t, "/care/login", { username: "grandma", password: "not the password" })).status).toBe(401);
    const ok = await postForm(f.t, "/care/login", { username: "Grandma", password: PASSWORD, next: "/settings" });
    expect(ok.status).toBe(302);
    // Never a parent page afterwards.
    expect(ok.headers.get("location")).toBe("/care");
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "caregiver", action: "caregiver.signed_in" });
  });

  it("limits sign-in tries per address and username, as a parent's", async () => {
    const f = await family();
    const { token } = await add(f);
    await join(f, token);
    for (let i = 0; i < 10; i++) expect((await postForm(f.t, "/care/login", { username: "grandma", password: "wrong" })).status).toBe(401);
    expect((await postForm(f.t, "/care/login", { username: "grandma", password: PASSWORD })).status).toBe(429);
  });

  it("a new link from a parent sets a new password and signs them out elsewhere; the old link stops", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    const res = await f.form(`/caregivers/${id}/link`);
    const fresh = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await res.text())?.[1] ?? "";
    expect(fresh).not.toBe("");
    const second = await f.form(`/caregivers/${id}/link`);
    const newest = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await second.text())?.[1] ?? "";
    expect((await get(f.t, `/care/join/${fresh}`)).status).toBe(400);
    const page = await (await get(f.t, `/care/join/${newest}`)).text();
    expect(page).toContain("Set my new password");
    await join(f, newest);
    expect((await care.page()).location).toMatch(/^\/care\/login/);
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "caregiver.joined", detail: { again: true } });
  });

  it("another caregiver's username isn't taken; a parent's sign-in page doesn't take a caregiver's", async () => {
    const f = await family();
    const grandma = await add(f);
    await join(f, grandma.token, "gran");
    const coach = await add(f, { name: "Coach Lee" });
    const res = await postForm(f.t, `/care/join/${coach.token}`, { username: "GRAN", password: PASSWORD, repeat: PASSWORD });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("Another caregiver has that username");
    expect((await postForm(f.t, "/login", { username: "gran", password: PASSWORD })).status).toBe(401);
  });
});

describe("what a caregiver sees", () => {
  it("their phones' status, as a parent chose: online, battery, paused, the schedule now; never another phone", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    // The phone asks for its rules (the long-poll): online.
    await f.t.app.request(`/api/v1/policy?have=-1`, { headers: { authorization: `Bearer ${f.phone.token}` } });
    let home = await care.page();
    expect(home.html).toContain("Alex&#39;s phone");
    expect(home.html).toContain("Yes, now");
    expect(home.html).toContain("81%");
    expect(home.html).not.toContain("Jamie&#39;s phone");
    f.t.advance(20 * MIN);
    home = await care.page();
    expect(home.html).toContain("Not now: last heard from 20 minutes ago");
    // A parent's pause shows, without saying who else paused it.
    pausePhone(f.ctx(), f.phone.deviceId, { minutes: 60, note: "Homework first" }, f.parent);
    home = await care.page();
    expect(home.html).toMatch(/Yes, until <time[^>]*>Nov 16, 2026, 11:20 AM<\/time>/);
    expect(home.html).not.toContain("Homework first");
    // Never the apps, screen time, calls or where the phone is.
    for (const path of [`/devices/${f.phone.deviceId}`, `/devices/${f.phone.deviceId}/location`, "/requests", "/activity", "/settings"]) {
      expect((await care.page(path)).location, path).toMatch(/^\/login/);
    }
  });

  it("without status, none of it; without pause, no pause form, and a pause is refused", async () => {
    const f = await family();
    const { token } = await add(f, { can: ["help"] });
    const care = await join(f, token);
    const home = await care.page();
    expect(home.html).not.toContain("Battery");
    expect(home.html).not.toContain("Pause and lock the screen now");
    const res = await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "30", lock: "0" });
    expect(res.status).toBe(403);
    expect(getRules(f.t.deps.db, f.phone.deviceId).pause).toBeNull();
  });

  it("another family phone is no such phone, for every action", async () => {
    const f = await family();
    const { token } = await add(f, { can: ["status", "pause", "help", "locate"] });
    const care = await join(f, token);
    expect((await care.form(`/care/phones/${f.other.deviceId}/pause`, { minutes: "30", lock: "1" })).status).toBe(404);
    expect((await care.form(`/care/phones/${f.other.deviceId}/locate`)).status).toBe(404);
    expect((await care.page(`/care/phones/${f.other.deviceId}/checks/anything`)).status).toBe(404);
    expect(getRules(f.t.deps.db, f.other.deviceId).pause).toBeNull();
  });

  it("refuses their forms without their CSRF token, or from another site", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    const path = `/care/phones/${f.phone.deviceId}/pause`;
    expect((await postForm(f.t, path, { minutes: "30" }, { cookie: care.cookie })).status).toBe(403);
    expect((await postForm(f.t, path, { _csrf: care.csrf, minutes: "30" }, { cookie: care.cookie, origin: "https://elsewhere.example" })).status).toBe(403);
    expect(getRules(f.t.deps.db, f.phone.deviceId).pause).toBeNull();
  });
});

describe("pausing and locking", () => {
  it("pauses with an end and no note, naming the caregiver for the kid; only ever longer; never resumes", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    const res = await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "30", lock: "0" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/care?saved=paused#phone-${f.phone.deviceId}`);
    expect(f.policy().pause).toEqual({ until: T0 + 30 * MIN, note: null, caregiver: "Grandma" });
    const entry = listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0];
    expect(entry).toMatchObject({ actor: "caregiver", caregiverName: "Grandma", action: "phone.paused", deviceName: "Alex's phone" });
    // Shorter isn't a change.
    await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "15", lock: "0" });
    expect(f.policy().pause).toEqual({ until: T0 + 30 * MIN, note: null, caregiver: "Grandma" });
    // A parent's longer pause, with a note, is the parent's: the kid's phone no longer names Grandma.
    pausePhone(f.ctx(), f.phone.deviceId, { minutes: 120, note: "Dinner" }, f.parent);
    expect(f.policy().pause).toEqual({ until: T0 + 120 * MIN, note: "Dinner" });
    // Grandma's shorter one keeps it; her longer one keeps the parent's note and names her.
    await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "60", lock: "0" });
    expect(f.policy().pause).toEqual({ until: T0 + 120 * MIN, note: "Dinner" });
    await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "240", lock: "0" });
    expect(f.policy().pause).toEqual({ until: T0 + 240 * MIN, note: "Dinner", caregiver: "Grandma" });
    // A note in the form is ignored, and a length that isn't offered is refused.
    expect((await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "480", lock: "0" })).status).toBe(400);
    // There's no resume for a caregiver: the path is no caregiver page.
    expect((await care.form(`/care/phones/${f.phone.deviceId}/resume`)).status).toBe(404);
    expect((await care.form(`/devices/${f.phone.deviceId}/resume`)).status).toBe(401);
    expect(f.policy().pause).not.toBeNull();
    // The parent's page says who set it; a parent resumes.
    expect(await (await get(f.t, `/devices/${f.phone.deviceId}`, f.sam.cookie)).text()).toContain("by Grandma (a caregiver");
    resumePhone(f.ctx(), f.phone.deviceId, f.parent);
    expect(f.policy().pause).toBeNull();
    expect(getCaregiver(f.t.deps.db, id)?.endedAt).toBeNull();
  });

  it("locks the screen now with a lock_now naming the caregiver, and a pause", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    const res = await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "60", lock: "1" });
    expect(res.headers.get("location")).toBe(`/care?saved=locked#phone-${f.phone.deviceId}`);
    expect(f.policy().pause).toEqual({ until: T0 + 60 * MIN, note: null, caregiver: "Grandma" });
    expect(f.policy().commands).toEqual([expect.objectContaining({ kind: "lock_now", via: null, caregiver: "Grandma", expires_at: T0 + 10 * MIN })]);
    expect(listAudit(f.t.deps.db, { limit: 2, includeReads: false }).map((e) => [e.actor, e.action])).toEqual([
      ["caregiver", "command.issued"],
      ["caregiver", "phone.paused"],
    ]);
  });

  it("at most 6 pauses and locks an hour per phone, and the activity log says so once", async () => {
    const f = await family();
    const { token } = await add(f);
    const care = await join(f, token);
    for (let i = 0; i < 6; i++) {
      f.t.advance(MIN);
      expect((await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "240", lock: i % 2 ? "1" : "0" })).status).toBe(302);
    }
    for (let i = 0; i < 3; i++) {
      const res = await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "240", lock: "1" });
      expect(res.status).toBe(429);
      expect(await res.text()).toContain("at most 6 times an hour");
    }
    expect(listAudit(f.t.deps.db, { limit: 100, includeReads: false }).filter((e) => e.action === "caregiver.limited")).toHaveLength(1);
    f.t.advance(HOUR);
    expect((await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "240", lock: "1" })).status).toBe(302);
  });
});

describe("checking where the phone is", () => {
  it("only with locate on and the phone's location on; names the caregiver for the kid; shows that one fix, a short while", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    // Off for this caregiver: no form, refused.
    expect((await care.page()).html).not.toContain("Check where Alex&#39;s phone is now");
    expect((await care.form(`/care/phones/${f.phone.deviceId}/locate`)).status).toBe(403);
    await f.form(`/caregivers/${id}`, { name: "Grandma", phone: [f.phone.deviceId], can: ["status", "pause", "help", "locate"] });
    // On for the caregiver, but location is off for the phone: the policy doesn't say they can, and they can't.
    expect(f.policy().caregivers[0]?.can).toEqual(["status", "pause", "help"]);
    expect((await care.page()).html).toContain("Location is off for Alex&#39;s phone");
    expect((await care.form(`/care/phones/${f.phone.deviceId}/locate`)).status).toBe(400);
    setLocation(f.ctx(), f.phone.deviceId, { mode: "on_demand" }, f.parent);
    expect(f.policy().caregivers[0]?.can).toEqual(["status", "pause", "help", "locate"]);
    // The check: the phone doesn't answer within the (test's short) wait.
    const res = await care.form(`/care/phones/${f.phone.deviceId}/locate`);
    expect(res.status).toBe(302);
    const at = res.headers.get("location") ?? "";
    expect(at).toMatch(new RegExp(`^/care/phones/${f.phone.deviceId}/checks/`));
    const command = f.policy().commands.find((c) => c.kind === "locate_now");
    expect(command).toMatchObject({ via: null, caregiver: "Grandma" });
    expect((await care.page(at)).html).toContain("The phone hasn&#39;t answered in a minute");
    // The phone answers: the fix shows, by the family's words.
    await deviceCall(f.t, f.phone.token, "locations", { fixes: [fix({ reason: "on_demand", command_id: command?.id })], place_events: [] });
    expect((await care.page(at)).html).toContain("Open in a map");
    expect(listAudit(f.t.deps.db, { limit: 10, includeReads: false }).find((e) => e.action === "command.issued")).toMatchObject({ actor: "caregiver", caregiverName: "Grandma" });
    // The parents' Location page names her among the checks, never as the server's command line.
    const checks = await (await get(f.t, `/devices/${f.phone.deviceId}/location`, f.sam.cookie)).text();
    expect(checks).toContain("Grandma (a caregiver)");
    expect(checks).not.toContain("the server&#39;s command line");
    // A parent's later check never answers the caregiver's, and after 15 minutes nothing shows.
    f.t.advance(16 * MIN);
    expect((await care.page(at)).html).toContain("That check was a while ago");
    expect((await care.page(at)).html).not.toContain("Open in a map");
    // Another caregiver's check is no check of theirs.
    const coach = await add(f, { name: "Coach Lee", can: ["locate"] });
    const lee = await join(f, coach.token, "lee");
    expect((await lee.page(at)).status).toBe(404);
  });

  it("stops waiting as soon as the phone says it couldn't, and shows the phone's words, escaped; never a parent's later check's", async () => {
    const f = await family();
    const { token } = await add(f, { can: ["status", "pause", "help", "locate"] });
    const care = await join(f, token);
    setLocation(f.ctx(), f.phone.deviceId, { mode: "on_demand" }, f.parent);
    // A real server's minute, and a poll of an hour: only the phone's answer ends the wait.
    f.t.deps.locateWaitMs = 60_000;
    f.t.deps.fixWaiters = createFixWaiters({ pollMs: 3_600_000 });
    const checkin = (commands: { id: string; result: "failed" | "expired"; problem?: string }[]) =>
      deviceCall(f.t, f.phone.token, "checkin", { status: device({ enforcement: { policy_version: f.policy().version, commands: commands.map((c) => ({ at: f.t.now(), ...c })) } }) });
    const started = Date.now();
    const pending = care.form(`/care/phones/${f.phone.deviceId}/locate`);
    await vi.waitFor(() => {
      expect(f.policy().commands.filter((c) => c.kind === "locate_now")).toHaveLength(1);
    });
    const command = f.policy().commands.find((c) => c.kind === "locate_now");
    await checkin([{ id: command?.id ?? "", result: "failed", problem: "Location is <i>off</i> in the phone's settings" }]);
    const res = await pending;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.t.deps.fixWaiters.size).toBe(0);
    const at = res.headers.get("location") ?? "";
    expect(at).toBe(`/care/phones/${f.phone.deviceId}/checks/${command?.id ?? ""}`);
    const { html } = await care.page(at);
    expect(html).toContain("The phone answered: it couldn&#39;t find where it is. Belay on the phone says:");
    expect(html).toContain("<blockquote>Location is &lt;i&gt;off&lt;/i&gt; in the phone&#39;s settings</blockquote>");
    expect(html).not.toContain("hasn&#39;t answered in a minute");
    // A parent's check much later, and what the phone says of it, is never her check's answer.
    f.t.advance(5 * MIN);
    const parentCheck = f.form(`/devices/${f.phone.deviceId}/location/check`);
    await vi.waitFor(() => {
      expect(f.policy().commands.filter((c) => c.kind === "locate_now")).toHaveLength(1);
    });
    const theirs = f.policy().commands.find((c) => c.kind === "locate_now");
    expect(theirs?.id).not.toBe(command?.id);
    expect(theirs?.caregiver ?? null).toBeNull();
    await checkin([{ id: theirs?.id ?? "", result: "expired" }]);
    expect((await parentCheck).status).toBe(302);
    const later = (await care.page(at)).html;
    expect(later).toContain("Belay on the phone says:");
    expect(later).not.toContain("too late");
  });
});

describe("help requests", () => {
  it("push to a caregiver with help on, at once, and show on their page from when their access began", async () => {
    const f = await family();
    // A help request from before their access: never theirs to see.
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0001", f.t.now(), { reason: "An old one" })] });
    f.t.advance(MIN);
    const { token, id } = await add(f);
    const coach = await add(f, { name: "Coach Lee", can: ["status"] });
    // Help on, but for the other phone only.
    const aunt = await add(f, { name: "Aunt Robin", phone: [f.other.deviceId], can: ["help"] });
    const care = await join(f, token);
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    const leeBrowser = browserFor(f.t, coach.id, () => f.fetch.mock.calls, "caregiver");
    const auntBrowser = browserFor(f.t, aunt.id, () => f.fetch.mock.calls, "caregiver");
    const parentBrowser = browserFor(f.t, f.sam.parent.id, () => f.fetch.mock.calls);
    f.fetch.mockClear();
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0002", f.t.now(), { reason: "I missed the bus", location: fix({ reason: "help" }) })] });
    await vi.waitFor(() => {
      expect(f.fetch).toHaveBeenCalledTimes(2);
    });
    expect(browser.notices()).toEqual([{ title: "Belay: help", body: 'Alex\'s phone needs help: "I missed the bus". They shared where the phone is.', url: "/care#help", urgent: true, urgency: "high" }]);
    expect(parentBrowser.notices()[0]?.url).toBe("/requests#help");
    expect(leeBrowser.notices()).toEqual([]);
    expect(auntBrowser.notices()).toEqual([]);
    const home = (await care.page()).html;
    expect(home).toContain("I missed the bus");
    expect(home).toContain("Where the phone was, shared by the kid");
    expect(home).toContain("No parent has seen it yet");
    expect(home).not.toContain("An old one");
    // No "I've seen it" for a caregiver.
    expect(home).not.toContain("I've seen it");
  });

  it("notifications only with help on; turning them on and off is in the activity log, apart from the parents' browsers", async () => {
    const f = await family();
    const keys = createECDH("prime256v1");
    keys.generateKeys();
    const fields = { endpoint: "https://fcm.googleapis.com/fcm/send/grandmas-phone", p256dh: keys.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
    const lee = await join(f, (await add(f, { name: "Coach Lee", can: ["status"] })).token, "lee");
    expect((await lee.page()).html).not.toContain("push-on");
    expect((await lee.form("/care/push/subscribe", fields)).status).toBe(403);
    const care = await join(f, (await add(f)).token);
    expect((await care.page()).html).toContain('action="/care/push/subscribe" id="push-on"');
    expect((await care.form("/care/push/subscribe", { ...fields, endpoint: "https://elsewhere.example/push" })).status).toBe(400);
    expect((await care.form("/care/push/subscribe", fields)).headers.get("location")).toBe("/care?saved=push_on#notifications");
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_push").get()).toEqual({ n: 1 });
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get()).toEqual({ n: 0 });
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "caregiver", caregiverName: "Grandma", action: "push.subscribed" });
    // A test notice goes to their browser only.
    f.fetch.mockClear();
    expect((await care.form("/care/push/test")).status).toBe(200);
    expect(f.fetch.mock.calls.map(([url]) => (url instanceof Request ? url.url : url.toString()))).toEqual([fields.endpoint]);
    await care.form("/care/push/unsubscribe", { endpoint: fields.endpoint });
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_push").get()).toEqual({ n: 0 });
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "caregiver", action: "push.unsubscribed" });
  });
});

describe("ending access", () => {
  it("stops at its end time by itself: their pages, actions and notices; the hourly clean-up ends it", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    const browser = browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    const version = f.policy().version;
    f.t.advance(THURSDAY_6PM_MS - T0);
    // At that moment: signed out, nothing works.
    expect((await care.page()).location).toMatch(/^\/care\/login/);
    expect((await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "30", lock: "0" })).status).toBe(401);
    expect((await postForm(f.t, "/care/login", { username: "grandma", password: PASSWORD })).status).toBe(403);
    f.fetch.mockClear();
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0003", f.t.now())] });
    await new Promise((r) => setTimeout(r, 50));
    expect(browser.notices()).toEqual([]);
    // The phone stops listing them at their until by its own clock; the clean-up gives it a policy without them.
    expect(f.policy().caregivers).toHaveLength(1);
    cleanUp(f.t.deps.db, f.t.now());
    expect(f.policy().caregivers).toEqual([]);
    expect(f.policy().version).toBeGreaterThan(version);
    expect(getCaregiver(f.t.deps.db, id)).toMatchObject({ endedAt: THURSDAY_6PM_MS, endedBy: null });
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_push").get()).toEqual({ n: 0 });
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_sessions").get()).toEqual({ n: 0 });
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "caregiver.access_ended", detail: { caregiver: "Grandma" } });
    // Running it again does nothing more.
    const after = f.policy().version;
    cleanUp(f.t.deps.db, f.t.now());
    expect(f.policy().version).toBe(after);
  });

  it("a parent ends it at once: sessions and browsers go, the phone's policy drops them", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    browserFor(f.t, id, () => f.fetch.mock.calls, "caregiver");
    await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "60", lock: "0" });
    const res = await f.form(`/caregivers/${id}/end`);
    expect(res.headers.get("location")).toBe(`/caregivers/${id}?saved=ended`);
    expect((await care.page()).location).toMatch(/^\/care\/login/);
    expect(f.policy().caregivers).toEqual([]);
    expect(f.t.deps.db.prepare("SELECT COUNT(*) AS n FROM caregiver_push").get()).toEqual({ n: 0 });
    expect(listAudit(f.t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "caregiver.ended" });
    // A pause they set stays, for its time: it only tightened. A parent can resume it.
    expect(f.policy().pause).toEqual({ until: T0 + 60 * MIN, note: null, caregiver: "Grandma" });
    // A new link isn't made for an ended one.
    expect((await f.form(`/caregivers/${id}/link`)).status).toBe(400);
  });

  it("renews, or gives access again from now (earlier help requests don't show); removes an ended one, the log keeping the name", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    expect((await f.form(`/caregivers/${id}/renew`, { until: "2026-11-25T18:00" })).headers.get("location")).toBe(`/caregivers/${id}?saved=renewed`);
    expect(f.policy().caregivers[0]?.until).toBe(Date.UTC(2026, 10, 25, 23, 0, 0));
    expect((await care.page()).status).toBe(200);
    // Ended, a help request, then access again: that request isn't theirs.
    await f.form(`/caregivers/${id}/end`);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0004", f.t.now(), { reason: "While no one else had access" })] });
    f.t.advance(MIN);
    expect((await f.form(`/caregivers/${id}/remove`)).status).toBe(302);
    expect(getCaregiver(f.t.deps.db, id)).toBeNull();
    // Removing a current one is refused.
    const lee = await add(f, { name: "Coach Lee" });
    expect((await f.form(`/caregivers/${lee.id}/remove`)).status).toBe(400);
    // The activity page keeps Grandma's entries under her name.
    const activity = await (await get(f.t, "/activity", f.sam.cookie)).text();
    expect(activity).toContain("Grandma (caregiver)");
    expect(activity).toContain("removed the caregiver Grandma");
  });

  it("gives access again from now: help requests from between don't show", async () => {
    const f = await family();
    const { token, id } = await add(f);
    await f.form(`/caregivers/${id}/end`);
    await deviceCall(f.t, f.phone.token, "requests", { requests: [help("request-0005", f.t.now(), { reason: "While Grandma had no access" })] });
    f.t.advance(MIN);
    const res = await f.form(`/caregivers/${id}/renew`, { until: THURSDAY_6PM });
    expect(res.headers.get("location")).toBe(`/caregivers/${id}?saved=again`);
    expect(getCaregiver(f.t.deps.db, id)).toMatchObject({ endedAt: null, accessFrom: T0 + MIN });
    expect(f.policy().caregivers).toHaveLength(1);
    // The old link went when access ended; a new one works.
    expect((await get(f.t, `/care/join/${token}`)).status).toBe(400);
    const fresh = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await (await f.form(`/caregivers/${id}/link`)).text())?.[1] ?? "";
    const care = await join(f, fresh);
    expect((await care.page()).html).not.toContain("While Grandma had no access");
  });
});

describe("the activity log", () => {
  it("shows what a parent did about caregivers, and what each caregiver did, under their name", async () => {
    const f = await family();
    const { token, id } = await add(f);
    const care = await join(f, token);
    await care.form(`/care/phones/${f.phone.deviceId}/pause`, { minutes: "30", lock: "1" });
    await f.form(`/caregivers/${id}`, { name: "Grandma Jo", phone: [f.phone.deviceId, f.other.deviceId], can: ["status"] });
    await f.form(`/caregivers/${id}/end`);
    const page = await (await get(f.t, "/activity", f.sam.cookie)).text();
    expect(page).toContain("added Grandma as a caregiver for Alex&#39;s phone until Nov 19, 2026, 6:00 PM, with the phone&#39;s status, pause and lock, help requests");
    expect(page).toContain("Grandma (caregiver)");
    expect(page).toContain("locked the phone&#39;s screen (Alex&#39;s phone)");
    expect(page).toContain("changed the caregiver Grandma Jo (before: Grandma): Alex&#39;s phone, Jamie&#39;s phone, with the phone&#39;s status");
    expect(page).toContain("ended Grandma Jo&#39;s access");
    // The other phone got a policy listing them, then one without.
    expect(f.policy(f.other.deviceId).caregivers).toEqual([]);
  });
});

describe("the policy's caregivers", () => {
  it("parse as the phone takes them, soonest end first, at most 20; and leave pause and commands as they were without one", async () => {
    const f = await family();
    await add(f, { name: "Coach Lee", until: "2026-11-25T18:00" });
    await add(f, { name: "Grandma", until: THURSDAY_6PM });
    const policy = f.policy();
    expect(policy.caregivers.map((c) => c.name)).toEqual(["Grandma", "Coach Lee"]);
    pausePhone(f.ctx(), f.phone.deviceId, { minutes: 30 }, f.parent);
    expect(Object.keys(f.policy().pause ?? {})).toEqual(["until", "note"]);
    expect(f.policy().caregivers.every((c) => c.until > f.t.now())).toBe(true);
    const many = await family();
    for (let i = 0; i < 20; i++) await add(many, { name: `Helper ${i}` });
    expect(many.policy().caregivers).toHaveLength(20);
    const res = await many.form("/caregivers", { name: "One more", phone: [many.phone.deviceId], can: ["status"], until: THURSDAY_6PM });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("at most 20 caregivers");
  });

  it("drops a phone that's deleted from a caregiver's phones", async () => {
    const f = await family();
    const { id } = await add(f, { phone: [f.phone.deviceId, f.other.deviceId] });
    await f.form(`/devices/${f.other.deviceId}/disconnect`);
    await f.form(`/devices/${f.other.deviceId}/delete`);
    expect(getCaregiver(f.t.deps.db, id)?.phones).toEqual([f.phone.deviceId]);
  });
});
