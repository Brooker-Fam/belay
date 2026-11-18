/**
 * Every parent page, and the states a form leaves it in, checked for the structure a screen reader
 * and a phone rely on: lang and a viewport, one h1 and no skipped heading level, no duplicate id, a
 * label for every field, a name for every button and link, words for every image (test/html.ts).
 * And the stylesheet's rules for phones and dark mode that once broke. Made-up apps and names only.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { createInvite, newSetupToken } from "../src/auth/parents.js";
import { addCaregiver } from "../src/family/caregivers/changes.js";
import { createProposal } from "../src/family/proposals.js";
import { listStages, phoneRules } from "../src/family/screentime/rules.js";
import { updateSettings } from "../src/settings.js";
import { browserFor, deviceCall, enrollPhone, event, fix, get, north, PASSWORD, pkg, postForm, signIn, snapshot, SPOT, testServer, T0, type TestServer } from "./helpers.js";
import { parseHtml, elements, structureProblems } from "./html.js";

let t: TestServer;
let cookie: string;
let form: (path: string, fields: Record<string, string | string[]>) => Response | Promise<Response>;
let base: string;
let stageId: string;
let invite: string;
/** Phase 12: a caregiver's link to join with, one who joined (their cookie), and their id. */
let careLink: string;
let careCookie: string;
let caregiverId: string;

beforeAll(async () => {
  t = testServer();
  const db = t.deps.db;
  updateSettings(db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  cookie = sam.cookie;
  form = (path, fields) => postForm(t, path, { _csrf: sam.csrf, ...fields }, { cookie: sam.cookie });
  const phone = await enrollPhone(t, "Alex's phone");
  base = `/devices/${phone.deviceId}`;
  const call = (path: string, body: unknown) => deviceCall(t, phone.token, path, body);
  await call("inventory", snapshot([pkg("com.example.blocks", { label: "Block Party", permissions: ["camera"] }), pkg("com.example.chat", { label: "Chatter" }), pkg("com.example.busmap", { label: "Bus Map" })], T0));
  await form(`${base}/protect`, {});
  await call("events", { events: [event("installed", "com.example.racers", { label: "Space Racers", app: pkg("com.example.racers", { label: "Space Racers" }) })] });
  // Screen time: a limit, a schedule, measuring and a day of it.
  await form(`${base}/screen-time/rules/settings`, { measure: "1", zone: "phone", day_starts: "00:00" });
  await form(`${base}/screen-time/rules/limits`, { scope: "apps", name: "Games", app: "com.example.blocks", minutes: "45" });
  await form(`${base}/screen-time/rules/schedules`, { kind: "bedtime", name: "Bedtime", days: ["sun", "mon"], start: "21:00", end: "07:00", lock: "1" });
  const games = phoneRules(db, phone.deviceId).rules.limits[0]?.id ?? "";
  const byHour = Array.from({ length: 24 }, (_, h) => (h >= 7 && h < 10 ? 20 : 0));
  await call("usage", {
    days: [{ day: "2026-11-16", zone: "America/New_York", as_of: T0, complete: false, screen_minutes: 60, unlocks: 9, by_hour: byHour, apps: [{ package: "com.example.blocks", minutes: 40, opens: 3 }], gaps: [] }],
  });
  await form("/stages", { name: "Starter", how: "", from: `phone:${phone.deviceId}` });
  stageId = listStages(db).find((s) => s.name === "Starter")?.id ?? "";
  await form(`${base}/agreement`, { title: ["Bedtime"], text: ["The phone sleeps in the kitchen."] });
  // Location: periodic, a place, a fix.
  await form(`${base}/location`, { mode: "periodic", every: "20", hours_start: "07:00", hours_end: "21:00", provider: "gps", keep_on: "1" });
  await form(`${base}/location/places`, { name: "School", center: "40.10000, -73.20000", radius: "150", notify: ["arrive", "leave"] });
  await call("locations", { fixes: [fix({ ...north(SPOT, 500) })], place_events: [] });
  await form(`${base}/numbers/kid`, { number: "+15555550123" });
  // Calls: on, a contact, a call from someone who isn't one.
  await form(`${base}/calls`, { mode: "contacts", unknown: "voicemail", withheld: "reject", outgoing: "any", quiet: "1", log: "1", enabled: "1" });
  await form(`${base}/calls/contacts`, { name: "Grandma", number: ["+15555550110", "", ""], calls: "1", texts: "1" });
  await form(`${base}/calls/blocked`, { number: "+15555550199" });
  await call("calls", { calls: [{ id: "call-00000001", at: T0 - 600_000, direction: "in", number: "+15555550188", duration_s: 0, outcome: "voicemail", reason: "unknown" }] });
  // Network logging, and a day of it.
  await form(`${base}/network`, { on: "1" });
  await call("network", { days: [{ day: "2026-11-16", zone: "America/New_York", as_of: T0, entries: [{ package: "com.example.chat", domain: "chat.example.com", lookups: 12 }], dropped: 0 }] });
  // The kid's requests, one of each, and an AI app's proposal.
  await call("requests", {
    requests: [
      { id: "request-0001", kind: "app", package: "com.example.racers", label: "Space Racers", reason: "My homework's done", asked_at: T0 },
      { id: "request-0002", kind: "more_time", limit_id: games, minutes: 15, package: "com.example.blocks", reason: "One more level", asked_at: T0 },
      { id: "request-0003", kind: "talk", reason: "About my bedtime", asked_at: T0 },
      { id: "request-0004", kind: "contact", contact_name: "Coach Lee", contact_number: "+15555550142", asked_at: T0 },
      { id: "request-0005", kind: "help", reason: "I missed the bus", location: fix({ reason: "help" }), asked_at: T0 },
      { id: "request-0006", kind: "agreement", version: 1, answer: "talk", reason: "Can it be later on Fridays?", asked_at: T0 },
    ],
  });
  createProposal(db, t.now(), phone.deviceId, { kind: "allow_app", package: "com.example.racers" }, "A racing game the kid asked for.", { parentId: sam.parent.id, clientName: "Claude" });
  browserFor(t, sam.parent.id, () => []);
  invite = createInvite(db, t.now(), sam.parent.id);
  // Phase 12: two caregivers, one who joined (every choice on) and one who hasn't yet.
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  const all = { status: true, pause: true, help: true, locate: true };
  const grandma = addCaregiver({ db, now: t.now() }, { name: "Grandma", phones: [phone.deviceId], can: all, endsAt: t.now() + 3 * 86_400_000 }, parent);
  caregiverId = grandma.caregiver.id;
  careLink = addCaregiver({ db, now: t.now() }, { name: "Coach Lee", phones: [phone.deviceId], can: { ...all, locate: false }, endsAt: t.now() + 86_400_000 }, parent).link;
  const joined = await postForm(t, `/care/join/${grandma.link}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD });
  careCookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
});

const page = async (path: string, withCookie = true) => {
  const res = await get(t, path, withCookie ? cookie : undefined);
  expect(res.status, path).toBeLessThan(500);
  return res.text();
};
const after = async (path: string, fields: Record<string, string | string[]>) => {
  const res = await form(path, fields);
  expect(res.status, path).toBeLessThan(500);
  expect(res.headers.get("location"), `${path} should show a page, not redirect`).toBeNull();
  return res.text();
};

const PAGES: [string, () => Promise<string>][] = [
  ["Phones", () => page("/")],
  ["a phone", () => page(base)],
  ["an app waiting, with the kid's request", () => page(`${base}/apps/com.example.racers`)],
  ["an app", () => page(`${base}/apps/com.example.blocks`)],
  ["Screen time", () => page(`${base}/screen-time`)],
  ["Screen-time rules", () => page(`${base}/screen-time/rules`)],
  ["Agreement", () => page(`${base}/agreement`)],
  ["Location and help", () => page(`${base}/location`)],
  ["Calls", () => page(`${base}/calls`)],
  ["Network", () => page(`${base}/network`)],
  ["Stop collecting", () => page(`${base}/collection/location`)],
  ["Requests", () => page("/requests")],
  ["Proposals", () => page("/proposals")],
  ["Stages", () => page("/stages")],
  ["a stage", () => page(`/stages/${stageId}`)],
  ["Off belay", () => page("/stages/off-belay")],
  ["Timeline", () => page("/timeline")],
  ["Add a phone", () => page("/add")],
  ["Settings", () => page("/settings")],
  ["Activity", () => page("/activity?reads=1")],
  ["no such phone", () => page("/devices/no-such-phone")],
  ["an enrollment code", () => after("/add", { name: "Jamie's tablet" })],
  ["Add a phone, with a problem", () => after("/add", { name: "" })],
  ["a phone, with a problem", () => after(`${base}/hardening`, { factory_reset: "1", confirm: "" })],
  ["a recovery key", () => after(`${base}/recovery-key`, {})],
  ["an invite to show once", () => after("/settings/invite", {})],
  ["Sign in", () => page("/login", false)],
  ["Join", () => page(`/invite/${invite}`, false)],
  ["Caregivers", () => page("/caregivers")],
  ["a caregiver", () => page(`/caregivers/${caregiverId}`)],
  ["a caregiver's link to show once", () => after(`/caregivers/${caregiverId}/link`, {})],
  ["Caregivers, with a problem", () => after("/caregivers", { name: "", until: "" })],
  ["a caregiver's sign-in", () => page("/care/login", false)],
  ["a caregiver joining", () => page(`/care/join/${careLink}`, false)],
  [
    "a caregiver's own page",
    async () => {
      const res = await get(t, "/care", careCookie);
      expect(res.status).toBe(200);
      return res.text();
    },
  ],
  [
    "Sign in, with a problem",
    async () => {
      const res = await postForm(t, "/login", { username: "sam", password: "not the right password" });
      return res.text();
    },
  ],
  [
    "Set up, and a link that doesn't work",
    async () => {
      const fresh = testServer();
      const token = newSetupToken(fresh.deps.db, fresh.now());
      const setup = await (await get(fresh, `/setup?token=${token}`)).text();
      const broken = await (await get(fresh, "/setup?token=wrong")).text();
      expect(structureProblems(broken)).toEqual([]);
      return setup;
    },
  ],
];

describe("every parent page's structure", () => {
  it.each(PAGES)("%s", async (_name, render) => {
    expect(structureProblems(await render())).toEqual([]);
  });

  it("signed in, a page starts with a way past the menu, to its main part", async () => {
    const all = elements(parseHtml(await page("/requests")));
    const skip = all.find((e) => e.tag === "a" && e.attrs.get("class") === "skip");
    expect(skip?.attrs.get("href")).toBe("#main");
    expect(all.find((e) => e.tag === "main")?.attrs.get("id")).toBe("main");
    expect(all.indexOf(skip ?? all[0]!)).toBeLessThan(all.findIndex((e) => e.tag === "header"));
  });

  it("typing the phone's name to confirm gets no capitals or corrections from a phone's keyboard", async () => {
    const all = elements(parseHtml(await page(base)));
    for (const id of ["confirm", "handover-confirm"]) {
      const box = all.find((e) => e.attrs.get("id") === id);
      expect(box?.attrs.get("autocapitalize"), id).toBe("off");
      expect(box?.attrs.get("autocorrect"), id).toBe("off");
      expect(box?.attrs.get("spellcheck"), id).toBe("false");
      expect(box?.attrs.get("inputmode"), id).toBe("text");
    }
  });

  it("a form's error is an alert, and the warnings that stand don't take the focus from it", async () => {
    const all = elements(parseHtml(await after(`${base}/hardening`, { factory_reset: "1", confirm: "" })));
    const error = all.find((e) => e.attrs.get("class") === "notice error");
    expect(error?.attrs.get("role")).toBe("alert");
    expect(error?.attrs.has("data-standing")).toBe(false);
  });
});

/** The stylesheet's custom properties, light and dark. */
function themes(css: string): { light: Record<string, string>; dark: Record<string, string> } {
  const vars = (block: string) => Object.fromEntries([...block.matchAll(/(--[\w-]+):\s*(#[0-9a-f]{6})\b/gi)].map((m) => [m[1] ?? "", (m[2] ?? "").toLowerCase()]));
  const light = vars(/:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "");
  const dark = vars(/@media \(prefers-color-scheme: dark\)\s*\{\s*:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "");
  return { light, dark: { ...light, ...dark } };
}

function contrast(a: string, b: string): number {
  const lum = (hex: string) => {
    const [r, g, b2] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b2 ?? 0);
  };
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

describe("the stylesheet", () => {
  const css = readFileSync(new URL("../src/static/app.css", import.meta.url), "utf8");

  it("follows the reader's text size: the root's isn't in px", () => {
    const root = /:root\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(root).toMatch(/font-size:\s*100%/);
  });

  it("keeps the screen-time chart's bar height off the header's inner .bar", () => {
    // A bare `.bar { … height … }` squeezed the header on every page.
    for (const rule of css.matchAll(/(^|\})\s*([^{}]*\.bar\b[^{}]*)\{([^}]*)\}/g)) {
      if (/height/.test(rule[3] ?? "")) expect(rule[2]?.trim(), "a .bar rule with a height").toMatch(/\.barrow > \.bar/);
    }
  });

  it("lets the hidden attribute hide a button", () => {
    expect(css).toMatch(/\[hidden\]\s*\{\s*display:\s*none\s*!important;\s*\}/);
  });

  it.each(["light", "dark"] as const)("has the contrast WCAG asks for, %s", (theme) => {
    const c = themes(css)[theme];
    const need = (fg: string, bg: string, min: number) => {
      expect(contrast(c[fg] ?? "", c[bg] ?? ""), `${fg} on ${bg}`).toBeGreaterThanOrEqual(min);
    };
    for (const bg of ["--bg", "--card"]) {
      need("--text", bg, 4.5);
      need("--muted", bg, 4.5);
      need("--accent", bg, 4.5);
      need("--bad", bg, 4.5);
      need("--warn", bg, 4.5);
      need("--ok", bg, 4.5);
      need("--off", bg, 4.5);
      // A field's border, and a focus ring, against what's around them (WCAG 1.4.11).
      need("--field", bg, 3);
      need("--focus", bg, 3);
    }
    need("--text", "--chip", 4.5);
    need("--muted", "--chip", 4.5);
    need("--accent-text", "--accent", 4.5);
    expect(contrast("#ffffff", c["--bad-fill"] ?? ""), "white on --bad-fill").toBeGreaterThanOrEqual(4.5);
  });
});
