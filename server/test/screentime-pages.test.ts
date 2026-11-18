/**
 * Phase 3's parent pages: a phone's Screen time and Screen-time rules tabs, stages, the family
 * agreement and locking now. Server-rendered, CSRF on every form. Made-up apps and names only.
 */
import { describe, expect, it } from "vitest";
import { Policy } from "../src/device/schemas.js";
import { buildPolicy } from "../src/family/policy.js";
import { listStages } from "../src/family/screentime/rules.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, enrollPhone, get, pkg, postForm, signIn, snapshot, testServer, T0 } from "./helpers.js";

const HOUR = 3_600_000;

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.blocks", { label: "Block <b>Party</b>" }), pkg("com.example.chat", { label: "Chatter" })], T0));
  const base = `/devices/${phone.deviceId}/screen-time`;
  const form = (path: string, fields: Record<string, string | string[]>, csrf = true) => postForm(t, path, { ...(csrf ? { _csrf: sam.csrf } : {}), ...fields }, { cookie: sam.cookie });
  const page = async (path: string) => {
    const res = await get(t, path, sam.cookie);
    return { status: res.status, html: await res.text() };
  };
  const policy = () => Policy.parse(buildPolicy(t.deps.db, phone.deviceId, t.now()));
  return { t, sam, phone, base, form, page, policy };
}

const LIMIT = { scope: "apps", app: "com.example.blocks", name: "Games", minutes: "45" };

describe("the Screen-time rules tab", () => {
  it("needs a parent signed in, and every form needs the CSRF token", async () => {
    const { t, base, form } = await family();
    const res = await get(t, `${base}/rules`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("/login");
    for (const path of [`${base}/rules/limits`, `${base}/rules/schedules`, `${base}/rules/other`, `${base}/rules/settings`, `${base}/rules/stage`, `${base}/extra`, "/stages"]) {
      expect((await form(path, LIMIT, false)).status, path).toBe(403);
    }
  });

  it("adds, changes and removes a limit; the phone gets each within seconds", async () => {
    const { base, form, page, policy } = await family();
    const added = await form(`${base}/rules/limits`, LIMIT);
    expect(added.status).toBe(302);
    expect(added.headers.get("location")).toBe(`${base}/rules?saved=limit#limits`);
    const [limit] = policy().screen_time?.limits ?? [];
    expect(limit).toMatchObject({ name: "Games", packages: ["com.example.blocks"], minutes: 45, by_day: null });
    // Weekends get more.
    await form(`${base}/rules/limits`, { ...LIMIT, id: limit?.id ?? "", minutes: "60", day_sat: "120", day_sun: "120" });
    expect(policy().screen_time?.limits[0]).toMatchObject({ minutes: 60, by_day: { sat: 120, sun: 120 } });
    const { html } = await page(`${base}/rules`);
    expect(html).toContain("1 h a day; 2 h on Saturday and Sunday");
    expect(html).toContain("Block &lt;b&gt;Party&lt;/b&gt;");
    expect(html).toContain("With these rules, a day (Monday) has apps open all day. Within that: 1 h of Games.");
    // A daily total, and an app the phone never pauses refused.
    await form(`${base}/rules/limits`, { scope: "total", minutes: "180" });
    expect(policy().screen_time?.limits[1]).toMatchObject({ name: "Screen time", packages: ["*"], minutes: 180 });
    const dialer = await form(`${base}/rules/limits`, { scope: "apps", app_more: "com.google.android.dialer", minutes: "30" });
    expect(dialer.status).toBe(400);
    expect(await dialer.text()).toContain("can&#39;t have a time limit");
    expect((await form(`${base}/rules/limits`, { ...LIMIT, minutes: "1441" })).status).toBe(400);
    expect((await form(`${base}/rules/limits`, { ...LIMIT, app: "not a package" })).status).toBe(400);
    await form(`${base}/rules/limits/${limit?.id ?? ""}/remove`, {});
    expect(policy().screen_time?.limits.map((l) => l.name)).toEqual(["Screen time"]);
  });

  it("schedules with a weekday picker, the other rules, and measuring and days", async () => {
    const { base, form, page, policy } = await family();
    const res = await form(`${base}/rules/schedules`, { kind: "bedtime", name: "", days: ["sun", "mon", "tue", "wed", "thu"], start: "21:00", end: "07:00", lock: "1", allow: "com.example.chat", skip: "2026-11-26" });
    expect(res.status).toBe(302);
    expect(policy().screen_time?.schedules).toMatchObject([
      { kind: "bedtime", name: "Bedtime", days: ["mon", "tue", "wed", "thu", "sun"], start: "21:00", end: "07:00", lock: true, allow: ["com.example.chat"], skip: ["2026-11-26"] },
    ]);
    expect((await form(`${base}/rules/schedules`, { kind: "custom", days: [], start: "21:00", end: "07:00" })).status).toBe(400);
    expect((await form(`${base}/rules/schedules`, { kind: "custom", days: ["mon"], start: "9pm", end: "07:00" })).status).toBe(400);
    await form(`${base}/rules/other`, { exempt: "com.example.chat", self_serve: "1", self_minutes: "10", self_times: "2", if_unmeasured: "keep_open", warn_before: "3" });
    expect(policy().screen_time).toMatchObject({ exempt: ["com.example.chat"], self_serve: { minutes: 10, times: 2 }, if_unmeasured: "keep_open", warn_before: 3 });
    await form(`${base}/rules/settings`, { measure: "1", zone: "phone", day_starts: "04:00" });
    expect(policy().screen_time).toMatchObject({ measure: true, zone: "phone", day_starts: "04:00" });
    expect((await form(`${base}/rules/settings`, { zone: "Mars/Olympus", day_starts: "04:00" })).status).toBe(400);
    const { html } = await page(`${base}/rules`);
    expect(html).toContain("9:00 pm to 7:00 am the next day, Sunday to Thursday; locks the screen; Chatter stays open; not on 2026-11-26");
    expect(html).toContain('<input type="checkbox" name="days" value="sat"/>');
  });

  it("extra time today, for a limit or every one", async () => {
    const { base, form, policy } = await family();
    await form(`${base}/rules/limits`, LIMIT);
    const id = policy().screen_time?.limits[0]?.id ?? "";
    expect((await form(`${base}/extra`, { limit: id, minutes: "15" })).status).toBe(302);
    expect(policy().screen_time?.extra).toMatchObject([{ limit_id: id, minutes: 15, day: "2026-11-16", request_id: null }]);
    expect((await form(`${base}/extra`, { limit: "l-nope", minutes: "15" })).status).toBe(400);
    expect((await form(`${base}/extra`, { limit: "*", minutes: "999" })).status).toBe(400);
  });
});

describe("the Screen time tab", () => {
  it("today and the last 7 days as bars, each app, and gaps shown as gaps", async () => {
    const { t, phone, base, form, page } = await family();
    await form(`${base}/rules/settings`, { measure: "1", zone: "phone", day_starts: "00:00" });
    const usage = (day: string, minutes: number, over: Record<string, unknown> = {}) => ({
      day,
      zone: "America/New_York",
      as_of: T0,
      complete: day !== "2026-11-16",
      screen_minutes: minutes,
      unlocks: 9,
      by_hour: Array.from({ length: 24 }, (_, h) => (h === 9 ? Math.min(minutes, 60) : 0)),
      apps: [
        { package: "com.example.blocks", minutes: 40, opens: 3 },
        { package: "com.example.chat", minutes: 10, opens: 1 },
      ],
      gaps: [],
      ...over,
    });
    await deviceCall(t, phone.token, "usage", {
      days: [usage("2026-11-16", 50, { gaps: [{ from: T0 - 3 * HOUR, to: T0 - 2 * HOUR, reason: "no_usage_access" }] }), usage("2026-11-14", 100)],
    });
    const { status, html } = await page(base);
    expect(status).toBe(200);
    // The busiest day fills the bar; a day the phone sent nothing for is unknown, not zero.
    expect(html).toContain('<i class="w100"></i>');
    expect(html).toContain('<i class="w50"></i>');
    expect(html).toContain("Not sent: unknown, not zero");
    expect(html).toContain("50 min so far");
    // The hours: one column, the hour Belay couldn't count hatched, and a table besides.
    expect(html).toContain('<path class="col"');
    expect(html).toContain('<rect class="gap-band"');
    expect(html).toContain("<title>7 am: 0 min. Belay couldn&#39;t count part of this hour</title>");
    expect(html).toContain("<summary>As a table</summary>");
    expect(html).toContain("Belay couldn&#39;t count 1 h");
    expect(html).toContain("usage access for Belay was off");
    // Apps, most used first, their names escaped.
    expect(html.indexOf("Block &lt;b&gt;Party&lt;/b&gt;")).toBeLessThan(html.indexOf("Chatter"));
    expect(html).toContain("40 min · 3 opens");
    // Another day's apps.
    const other = await page(`${base}?day=2026-11-14`);
    expect(other.html).toContain("1 h 40 min, 9 unlocks");
    expect((await page(`${base}?day=2026-11-15`)).html).toContain("The phone sent nothing for this day");
  });

  it("says when measuring is off, and shows the phone's report for today", async () => {
    const { t, phone, base, page } = await family();
    expect((await page(base)).html).toContain("Measuring is off");
    await deviceCall(t, phone.token, "checkin", {
      status: device({ enforcement: { policy_version: 1, screen_time: { day: "2026-11-16", measured: false, limits: [{ id: "l-games", state: "used_up" }] } } }),
    });
    expect((await page(base)).html).toContain("Usage access for Belay is turned off on the phone");
  });

  it("locks the phone now, and shows a failed lock in the phone's words", async () => {
    const { t, phone, sam, base, form, page, policy } = await family();
    expect((await form(`/devices/${phone.deviceId}/lock`, { minutes: "30" }, false)).status).toBe(403);
    expect((await form(`/devices/${phone.deviceId}/lock`, { minutes: "7" })).status).toBe(400);
    expect((await form(`/devices/${phone.deviceId}/lock`, { minutes: "30", note: "Dinner" })).status).toBe(302);
    const p = policy();
    expect(p.pause).toEqual({ until: t.now() + 30 * 60_000, note: "Dinner" });
    expect(p.commands).toMatchObject([{ kind: "lock_now", expires_at: t.now() + 10 * 60_000 }]);
    await deviceCall(t, phone.token, "checkin", {
      status: device({ enforcement: { policy_version: p.version, commands: [{ id: p.commands[0]?.id ?? "", result: "failed", at: t.now(), problem: "Android lets Belay lock the screen only after the phone restarts once with this version of Belay." }] } }),
    });
    const { html } = await page(base);
    expect(html).toContain("the phone couldn&#39;t lock its screen");
    expect(html).toContain("<blockquote>Android lets Belay lock the screen only after the phone restarts once with this version of Belay.</blockquote>");
    expect(sam.parent.name).toBe("Sam");
  });
});

describe("stages", () => {
  it("are made, edited and put on a phone, which then shows what the next one changes", async () => {
    const { t, phone, base, form, page, policy } = await family();
    await form(`${base}/rules/limits`, LIMIT);
    // A stage from the phone's rules now, and another after it.
    expect((await form("/stages", { name: "Starter", from: `phone:${phone.deviceId}` })).status).toBe(302);
    await form("/stages", { name: "Explorer", how: "A month of kept limits", from: "" });
    const [starter, explorer] = listStages(t.deps.db);
    expect([starter?.name, explorer?.name]).toEqual(["Starter", "Explorer"]);
    expect(starter?.rules.limits).toMatchObject([{ name: "Games", minutes: 45 }]);
    // Explorer gets Games at 90 minutes.
    await form(`/stages/${explorer?.id ?? ""}/limits`, { scope: "apps", app_more: "com.example.blocks", name: "Games", minutes: "90" });
    expect((await page(`/stages/${explorer?.id ?? ""}`)).html).toContain("Games: 1 h 30 min a day instead of 45 min, every day");
    // The phone moves onto Starter.
    expect((await form(`${base}/rules/stage`, { stage: starter?.id ?? "" })).status).toBe(302);
    expect(policy().stage).toMatchObject({ name: "Starter", next: { name: "Explorer", how: "A month of kept limits" } });
    const rules = await page(`${base}/rules`);
    expect(rules.html).toContain("What the next stage, <strong>Explorer</strong>, changes, as the kid sees it:");
    expect(rules.html).toContain("Games: 1 h 30 min a day instead of 45 min, every day");
    // A stage with a phone on it can't be deleted.
    const refused = await form(`/stages/${starter?.id ?? ""}/delete`, {});
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("Alex&#39;s phone is on this stage");
    expect((await page("/stages")).html).toContain("On it: Alex&#39;s phone");
    await form(`/stages/${starter?.id ?? ""}`, { name: "Starter", number: "2", how: "" });
    // Every family's list ends with Off belay (Phase 11).
    expect(listStages(t.deps.db).map((s) => s.name)).toEqual(["Explorer", "Starter", "Off belay"]);
  });
});

describe("an AI app's screen-time proposal on the Proposals page", () => {
  it("lists every change with whether it tightens or loosens, and approving applies it", async () => {
    const { t, sam, phone, base, form, page, policy } = await family();
    await form(`${base}/rules/limits`, LIMIT);
    const current = policy().screen_time?.limits[0];
    if (!current) throw new Error("no limit");
    const { createProposal } = await import("../src/family/proposals.js");
    const made = createProposal(
      t.deps.db,
      t.now(),
      phone.deviceId,
      { kind: "screen_time", patch: { limits: [{ id: current.id, before: current, after: { ...current, minutes: 90 } }], schedules: [], exempt: { before: [], after: ["com.example.chat"] } } },
      "They finished the project.",
      { parentId: sam.parent.id, clientName: "Claude" },
    );
    const { html } = await page("/proposals");
    expect(html).toContain("Change screen time: Games: 1 h 30 min a day instead of 45 min, every day (and 1 more change)");
    expect(html).toContain('Chatter never counts toward a limit <span class="chip blocked">loosens</span>');
    const res = await form(`/proposals/${made.proposal.id}/approve`, {});
    expect(res.headers.get("location")).toBe("/proposals?saved=proposal_approved");
    expect(policy().screen_time).toMatchObject({ limits: [{ minutes: 90 }], exempt: ["com.example.chat"] });
  });
});

describe("the family agreement", () => {
  it("is written in sections, and a new version asks the kid again", async () => {
    const { phone, form, page, policy } = await family();
    const path = `/devices/${phone.deviceId}/agreement`;
    expect((await form(path, { title: ["Phones at dinner"], text: ["In the basket."] }, false)).status).toBe(403);
    expect((await form(path, { title: ["Phones at dinner", ""], text: ["In the basket.", ""] })).status).toBe(302);
    expect(policy().agreement).toMatchObject({ version: 1, sections: [{ title: "Phones at dinner", text: "In the basket." }], kid_agreed_at: null });
    const { html } = await page(path);
    expect(html).toContain("Version 1");
    expect(html).toContain("The kid hasn&#39;t answered yet.");
    await form(path, { title: ["Phones at dinner", "Bedtime"], text: ["In the basket.", "Phones charge in the kitchen."] });
    expect(policy().agreement).toMatchObject({ version: 2, sections: [{ title: "Phones at dinner" }, { title: "Bedtime" }] });
    expect((await page(path)).html).toContain("Earlier versions");
    // The activity log names the agreement's own version, not the rules' version beside it.
    const activity = (await page("/activity")).html;
    expect(activity).toContain("wrote version 2 of the family agreement");
    expect(activity).toContain("wrote version 1 of the family agreement");
    expect((await form(path, { title: [""], text: [""] })).status).toBe(400);
  });
});
