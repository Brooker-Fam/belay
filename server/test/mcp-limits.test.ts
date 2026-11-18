/**
 * What an AI app does that reaches the kid is limited per connection and phone: checks of where
 * the phone is (each posts a notice on the kid's phone), and pauses and locks, together. Past a
 * few an hour the tool refuses, saying when to try again, and the activity log says so once an
 * hour. A parent, on the parent page, isn't limited. Made-up names only.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { setLocation } from "../src/family/location/changes.js";
import { buildPolicy, type PolicyContext, RuleRefused } from "../src/family/policy.js";
import { approveProposal, listProposals } from "../src/family/proposals.js";
import { setPhoneRules } from "../src/family/screentime/changes.js";
import { NO_RULES, phoneRules, type Schedule } from "../src/family/screentime/rules.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { AI_PER_HOUR } from "../src/ratelimit.js";
import { updateSettings } from "../src/settings.js";
import { enrollPhone, get, postForm, signIn, testServer, type TestServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const MINUTE = 60_000;

async function connect(t: TestServer, parentId: string, name: string) {
  const { token } = createPersonalToken(t.deps.db, t.now(), parentId, name, MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return async (tool: string, args: Record<string, unknown>) => {
    const res = await client.callTool({ name: tool, arguments: args });
    return { text: (res.content as { text: string }[])[0]?.text ?? "", isError: res.isError === true };
  };
}

async function family() {
  // A check waits for its fix; these phones never answer, so it shouldn't wait long.
  const t = testServer({ locateWaitMs: 5 });
  updateSettings(t.deps.db, { timezone: "America/New_York", aiScopes: { location: true } });
  const sam = await signIn(t);
  const alex = await enrollPhone(t, "Alex's phone");
  const jo = await enrollPhone(t, "Jo's phone");
  const ctx = (): PolicyContext => ({
    db: t.deps.db,
    now: t.now(),
    changed: (id) => {
      t.deps.waiters.changed(id);
    },
  });
  const person = { kind: "parent", parentId: sam.parent.id } as const;
  for (const phone of [alex, jo]) setLocation(ctx(), phone.deviceId, { mode: "on_demand" }, person);
  const claude = await connect(t, sam.parent.id, "Claude");
  const commands = (deviceId: string, kind: string) =>
    (t.deps.db.prepare("SELECT COUNT(*) AS n FROM commands WHERE device_id = ? AND kind = ?").get(deviceId, kind) as { n: number }).n;
  const limited = () => listAudit(t.deps.db, { limit: 500, includeReads: false }).filter((e) => e.action === "ai.limited");
  const form = (path: string, fields: Record<string, string | string[]>) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const activity = async () => (await get(t, "/activity", sam.cookie)).text();
  return { t, sam, alex, jo, ctx, person, claude, commands, limited, form, activity };
}

describe("an AI app's checks of where the phone is", () => {
  it(`at most ${AI_PER_HOUR.checks} an hour per connection and phone; then it says when to try again, and the activity log says so once`, async () => {
    const { t, alex, claude, commands, limited, activity } = await family();
    for (let i = 0; i < AI_PER_HOUR.checks; i++) {
      const res = await claude("locate_now", { device: "Alex's phone" });
      expect(res.isError, `check ${i + 1}`).toBe(false);
      expect(res.text).toContain("using Claude");
      t.advance(9 * MINUTE);
    }
    // 54 minutes after the first check: the first one counts for 6 minutes more.
    const refused = await claude("locate_now", { device: "Alex's phone" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toBe(
      "Not checked: an AI app may check where Alex's phone is at most 6 times an hour through one connection (the kid's phone shows a notice for each check), and this one has. Try again in 6 minutes, at 2026-11-16T11:00:00-05:00. A parent can check at any time, on the phone's Location page.",
    );
    expect(commands(alex.deviceId, "locate_now")).toBe(AI_PER_HOUR.checks);
    t.advance(MINUTE);
    expect((await claude("locate_now", { device: "Alex's phone" })).text).toContain("Try again in 5 minutes");
    // However often it tries, the activity log says it once, with the phone and the app.
    expect(limited()).toHaveLength(1);
    expect(limited()[0]).toMatchObject({ actor: "ai", clientName: "Claude", deviceName: "Alex's phone", detail: { what: "checks", limit: AI_PER_HOUR.checks } });
    expect(await activity()).toContain("was refused: it tried to check where the phone is more than 6 times in an hour (Alex");
    // Once the first check is an hour old, there's room for one more.
    t.advance(5 * MINUTE);
    expect((await claude("locate_now", { device: "Alex's phone" })).isError).toBe(false);
    expect((await claude("locate_now", { device: "Alex's phone" })).isError).toBe(true);
    expect(commands(alex.deviceId, "locate_now")).toBe(AI_PER_HOUR.checks + 1);
  });

  it("each connection and each phone has its own count; a refused check isn't sent, nor counted", async () => {
    const { t, sam, alex, jo, claude, commands } = await family();
    for (let i = 0; i < AI_PER_HOUR.checks; i++) await claude("locate_now", { device: "Alex's phone" });
    expect((await claude("locate_now", { device: "Alex's phone" })).isError).toBe(true);
    // Another phone, through the same connection.
    expect((await claude("locate_now", { device: "Jo's phone" })).isError).toBe(false);
    // The same phone, through another connection the parent made.
    const code = await connect(t, sam.parent.id, "Claude Code");
    expect((await code("locate_now", { device: "Alex's phone" })).isError).toBe(false);
    expect(commands(alex.deviceId, "locate_now")).toBe(AI_PER_HOUR.checks + 1);
    expect(commands(jo.deviceId, "locate_now")).toBe(1);
    // A check that isn't possible (location off) isn't sent, so it doesn't count either.
    setLocation({ db: t.deps.db, now: t.now() }, jo.deviceId, { mode: "off" }, { kind: "parent", parentId: sam.parent.id });
    for (let i = 0; i < AI_PER_HOUR.checks + 2; i++) expect((await claude("locate_now", { device: "Jo's phone" })).text).toContain("Location is off");
    setLocation({ db: t.deps.db, now: t.now() }, jo.deviceId, { mode: "on_demand" }, { kind: "parent", parentId: sam.parent.id });
    for (let i = 1; i < AI_PER_HOUR.checks; i++) expect((await claude("locate_now", { device: "Jo's phone" })).isError).toBe(false);
    expect((await claude("locate_now", { device: "Jo's phone" })).isError).toBe(true);
  });

  it("a parent's Check now, on the parent page, isn't limited", async () => {
    const { alex, form, commands } = await family();
    for (let i = 0; i < AI_PER_HOUR.checks * 2; i++) expect((await form(`/devices/${alex.deviceId}/location/check`, {})).status).toBe(302);
    expect(commands(alex.deviceId, "locate_now")).toBe(AI_PER_HOUR.checks * 2);
  });
});

describe("an AI app's pauses and locks", () => {
  it(`at most ${AI_PER_HOUR.locks} an hour per connection and phone, pauses and locks together`, async () => {
    const { t, alex, claude, commands, limited } = await family();
    for (let i = 0; i < AI_PER_HOUR.locks / 2; i++) {
      // Each pause longer than the lock before it, so each changes the pause.
      expect((await claude("pause_phone", { device: "Alex's phone", minutes: 30 + i * 60 })).isError).toBe(false);
      expect((await claude("lock_phone", { device: "Alex's phone", minutes: 60 + i * 60 })).isError).toBe(false);
      t.advance(MINUTE);
    }
    for (const [tool, args] of [
      ["pause_phone", { minutes: 300 }],
      ["pause_phone", {}],
      ["lock_phone", { minutes: 240 }],
    ] as const) {
      const res = await claude(tool, { device: "Alex's phone", ...args });
      expect(res.isError, tool).toBe(true);
      expect(res.text).toBe(
        "Not done: an AI app may pause or lock Alex's phone at most 6 times an hour through one connection, pauses and locks together, and this one has. Try again in 57 minutes, at 2026-11-16T11:00:00-05:00. A parent can pause or lock it at any time, on the parent page.",
      );
    }
    expect(commands(alex.deviceId, "lock_now")).toBe(AI_PER_HOUR.locks / 2);
    expect(limited()).toHaveLength(1);
    expect(limited()[0]).toMatchObject({ actor: "ai", deviceName: "Alex's phone", detail: { what: "locks", limit: AI_PER_HOUR.locks } });
    // Jo's phone has its own count.
    expect((await claude("lock_phone", { device: "Jo's phone", minutes: 30 })).isError).toBe(false);
  });

  it("a pause that changes nothing (one at least as long is running) doesn't count", async () => {
    const { claude } = await family();
    expect((await claude("pause_phone", { device: "Alex's phone" })).isError).toBe(false);
    for (let i = 0; i < AI_PER_HOUR.locks * 2; i++) {
      const res = await claude("pause_phone", { device: "Alex's phone", minutes: 30 });
      expect(res.isError).toBe(false);
      expect(res.text).toContain("nothing changed");
    }
    for (let i = 1; i < AI_PER_HOUR.locks; i++) expect((await claude("lock_phone", { device: "Alex's phone", minutes: 30 })).isError).toBe(false);
    expect((await claude("lock_phone", { device: "Alex's phone", minutes: 30 })).isError).toBe(true);
  });

  it("a parent's pause and lock, on the parent page, aren't limited", async () => {
    const { alex, form, commands } = await family();
    for (let i = 0; i < AI_PER_HOUR.locks * 2; i++) {
      expect((await form(`/devices/${alex.deviceId}/pause`, { minutes: "30" })).status).toBe(302);
      expect((await form(`/devices/${alex.deviceId}/lock`, { minutes: "15" })).status).toBe(302);
    }
    expect(commands(alex.deviceId, "lock_now")).toBe(AI_PER_HOUR.locks * 2);
  });
});

describe("an AI app's schedules can't lock the screen past the limit", () => {
  const pad = (n: number) => String(n).padStart(2, "0");
  const at = (minutes: number) => `${pad(Math.floor(minutes / 60) % 24)}:${pad(minutes % 60)}`;
  /** `count` schedules every 3 minutes from 15:00, each `length` minutes long, every day. */
  const every3 = (count: number, length: number, lock: boolean) =>
    Array.from({ length: count }, (_, i) => ({ start: at(15 * 60 + 3 * i), end: at(15 * 60 + 3 * i + length), lock }));
  const schedules = (t: TestServer, deviceId: string) => Policy.parse(buildPolicy(t.deps.db, deviceId, t.now())).screen_time?.schedules ?? [];
  const bedtime: Schedule = { id: "s-bed", kind: "bedtime", name: "Bedtime", days: ["sun", "mon", "tue", "wed", "thu"], start: "21:00", end: "07:00", allow: [], lock: true, skip: [] };

  it("after lock_phone is refused, twenty one-minute locking schedules are refused too, not even proposed, and the activity log says so once", async () => {
    const { t, alex, claude, activity } = await family();
    for (let i = 0; i < AI_PER_HOUR.locks; i++) expect((await claude("lock_phone", { device: "Alex's phone", minutes: 5 })).isError).toBe(false);
    expect((await claude("lock_phone", { device: "Alex's phone", minutes: 5 })).text).toContain(`at most ${AI_PER_HOUR.locks} times an hour`);
    // The third review's way around it: one change_screen_time, twenty schedules that lock the screen as each starts.
    for (const lock of [true, false]) {
      const res = await claude("change_screen_time", { device: "Alex's phone", change: { schedules: every3(20, 1, lock) }, reason: "Homework hour" });
      expect(res.isError).toBe(true);
      expect(res.text).toBe(
        "Not changed: a schedule an AI app adds or changes runs at least 15 minutes, and 3:00 pm to 3:01 pm is 1 minute. A parent can make a shorter one on the parent page.",
      );
    }
    expect(schedules(t, alex.deviceId)).toEqual([]);
    expect(listProposals(t.deps.db, { status: "pending" })).toEqual([]);
    // However often it tries, one line an hour, naming no rule.
    const refused = () => listAudit(t.deps.db, { limit: 50, includeReads: false }).filter((e) => e.action === "ai.refused");
    expect(refused()).toHaveLength(1);
    expect(refused()[0]).toMatchObject({ actor: "ai", clientName: "Claude", deviceName: "Alex's phone", detail: { tool: "change_screen_time", why: "short_schedule" } });
    expect(await activity()).toContain("was refused: it tried to add or change a schedule shorter than 15 minutes (Alex");
    // An hour on, a schedule just short of 15 minutes is refused the same way, and logged again.
    t.advance(61 * MINUTE);
    const fourteen = await claude("change_screen_time", { device: "Alex's phone", change: { schedules: [{ start: "15:00", end: "15:14" }] }, reason: "x" });
    expect(fourteen.text).toContain("3:00 pm to 3:14 pm is 14 minutes");
    expect(refused()).toHaveLength(2);
  });

  it("a schedule that locks the screen is a proposal, even one that only tightens: new, lock turned on, or a locking one changed", async () => {
    const { t, sam, alex, ctx, person, claude } = await family();
    const call = async (change: Record<string, unknown>) => {
      const res = await claude("change_screen_time", { device: "Alex's phone", change, reason: "The parent asked." });
      return JSON.parse(res.text) as { status: string; why?: string; changes: { effect: string; untrusted: { change: string } }[] };
    };
    // Fifteen minutes is long enough, but each of these locks: a parent decides.
    const many = await call({ schedules: every3(20, 15, true) });
    expect(many.status).toBe("proposed: waiting for a parent to approve or reject it");
    expect(many.why).toBe("A schedule that locks the screen is a parent's to approve, even one that only tightens: an AI app locks the phone only with lock_phone, at most 6 times an hour.");
    expect(many.changes).toHaveLength(20);
    expect(many.changes.every((c) => c.effect === "tightens")).toBe(true);
    expect(many.changes[0]?.untrusted.change).toBe("New: Schedule from 3:00 pm to 3:15 pm, every day, locking the screen when it starts");
    expect(schedules(t, alex.deviceId)).toEqual([]);
    // A parent's bedtime that locks: moving its start earlier, or adding a day, is a new start the phone would lock for.
    setPhoneRules(ctx(), alex.deviceId, { ...NO_RULES, schedules: [bedtime, { ...bedtime, id: "s-school", kind: "school", name: "School", start: "08:00", end: "15:00", lock: false }] }, person);
    for (const change of [{ id: "s-bed", start: "20:30" }, { id: "s-bed", days: ["sun", "mon", "tue", "wed", "thu", "fri"] }, { id: "s-school", lock: true }]) {
      const res = await call({ schedules: [change] });
      expect(res.status, JSON.stringify(change)).toBe("proposed: waiting for a parent to approve or reject it");
    }
    expect(phoneRules(t.deps.db, alex.deviceId).rules.schedules.map((s) => [s.id, s.start, s.days.length, s.lock])).toEqual([
      ["s-bed", "21:00", 5, true],
      ["s-school", "08:00", 5, false],
    ]);
    // What doesn't lock still tightens at once: a longer school day, a new schedule that doesn't lock.
    expect((await call({ schedules: [{ id: "s-school", end: "16:00" }] })).status).toBe("done: it only tightens, so it applies at once");
    expect((await call({ schedules: every3(1, 15, false) })).status).toBe("done: it only tightens, so it applies at once");
    expect(schedules(t, alex.deviceId).map((s) => [s.start, s.end, s.lock])).toEqual([
      ["21:00", "07:00", true],
      ["08:00", "16:00", false],
      ["15:00", "15:15", false],
    ]);
    // A parent approves the earlier bedtime: it applies, in their name.
    const earlier = listProposals(t.deps.db, { status: "pending" }).find((p) => p.change.kind === "screen_time" && p.change.patch.schedules[0]?.after?.start === "20:30");
    expect(approveProposal(ctx(), earlier?.id ?? "", sam.parent.id)).toMatchObject({ ok: true });
    expect(schedules(t, alex.deviceId)[0]).toMatchObject({ id: "s-bed", start: "20:30", lock: true });
  });

  it("checked again where the change is made: an AI app's locking or short schedule never applies", async () => {
    const { t, sam, alex, ctx } = await family();
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as const;
    const custom = (over: Partial<Schedule>): Schedule => ({ id: "s-x", kind: "custom", name: "Schedule", days: ["mon"], start: "15:00", end: "16:00", allow: [], lock: false, skip: [], ...over });
    expect(() => setPhoneRules(ctx(), alex.deviceId, { ...NO_RULES, schedules: [custom({ lock: true })] }, ai)).toThrow("An AI app can't make a schedule lock the screen");
    expect(() => setPhoneRules(ctx(), alex.deviceId, { ...NO_RULES, schedules: [custom({ end: "15:05" })] }, ai)).toThrow(RuleRefused);
    expect(schedules(t, alex.deviceId)).toEqual([]);
    expect(setPhoneRules(ctx(), alex.deviceId, { ...NO_RULES, schedules: [custom({})] }, ai).changed).toBe(true);
  });

  it("a parent isn't limited: a one-minute schedule that locks, from the parent page", async () => {
    const { t, alex, form } = await family();
    const res = await form(`/devices/${alex.deviceId}/screen-time/rules/schedules`, { kind: "custom", name: "Look up", days: ["mon", "tue"], start: "15:00", end: "15:01", lock: "1" });
    expect(res.status).toBe(302);
    expect(schedules(t, alex.deviceId)).toMatchObject([{ name: "Look up", start: "15:00", end: "15:01", lock: true }]);
  });
});
