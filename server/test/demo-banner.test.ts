/**
 * The demo banner (docs/demo.md): "Demo: a made-up family. Nothing here is real." on every page
 * of a server with BELAY_DEMO_BANNER=1, which only `npm run demo` sets, whose database is the
 * demo's own (the seventh review's J3), and on no other server's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { markDatabase } from "../demo/dir.js";
import { loadConfig } from "../src/config.js";
import { isDemoDatabase, updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, get, PASSWORD, postForm, signIn, testServer } from "./helpers.js";
import { structureProblems } from "./html.js";

const BANNER = "Demo: a made-up family. Nothing here is real.";

/** A server as `npm run demo` starts it: BELAY_DEMO_BANNER=1, on a database the demo marked as its own. */
function demoServer() {
  const t = testServer({ config: { demoBanner: true } });
  markDatabase(t.deps.db, "0123456789abcdef0123456789abcdef", t.now());
  return t;
}

describe("the demo banner", () => {
  it("is on only when BELAY_DEMO_BANNER is 1", () => {
    const config = (value?: string) => loadConfig({ BELAY_PUBLIC_URL: "http://localhost:8080", ...(value === undefined ? {} : { BELAY_DEMO_BANNER: value }) }).demoBanner;
    expect(config("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(config(value), String(value)).toBe(false);
  });

  it("is on every page of a server that sets it, signed in or out, and the title says demo", async () => {
    const t = demoServer();
    const parent = await signIn(t);
    for (const [path, signedIn] of [
      ["/login", false],
      ["/oauth/authorize", false],
      ["/requests", true],
      ["/caregivers", true],
      ["/stages", true],
      ["/timeline", true],
      ["/add", true],
      ["/settings", true],
      ["/activity", true],
    ] as const) {
      const html = await (await get(t, path, signedIn ? parent.cookie : undefined)).text();
      expect(html, path).toContain(BANNER);
      expect(html, path).toMatch(/<title>[^<]* · Belay demo<\/title>/);
      expect(structureProblems(html), path).toEqual([]);
    }
  });

  it("is on a caregiver's pages too, signed in or out", async () => {
    const t = demoServer();
    updateSettings(t.deps.db, { timezone: "America/New_York" });
    const parent = await signIn(t);
    const phone = await enrollPhone(t, "A made-up phone");
    // A parent adds a caregiver (made up), who joins with the link the page shows.
    const added = await postForm(t, "/caregivers", { _csrf: parent.csrf, name: "Grandma", phone: [phone.deviceId], can: ["status", "pause", "help"], until: "2026-11-19T18:00" }, { cookie: parent.cookie });
    const token = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await added.text())?.[1] ?? "";
    expect(token).not.toBe("");
    const joinPage = await (await get(t, `/care/join/${token}`)).text();
    const joined = await postForm(t, `/care/join/${token}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD });
    expect(joined.headers.get("location")).toBe("/care");
    const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    for (const [path, html] of [
      ["/care/login", await (await get(t, "/care/login")).text()],
      [`/care/join/${token}`, joinPage],
      ["/care", await (await get(t, "/care", cookie)).text()],
    ] as const) {
      expect(html, path).toContain(BANNER);
      expect(html, path).toMatch(/<title>[^<]* · Belay demo<\/title>/);
      expect(structureProblems(html), path).toEqual([]);
    }
  });

  it("with BELAY_DEMO_BANNER=1 on a real family's database (no demo mark), is on none of its pages", async () => {
    const t = testServer({ config: { demoBanner: true } });
    expect(isDemoDatabase(t.deps.db)).toBe(false);
    updateSettings(t.deps.db, { timezone: "America/New_York" });
    const parent = await signIn(t);
    const phone = await enrollPhone(t, "Alex's phone");
    await deviceCall(t, phone.token, "requests", { requests: [{ id: "request-0001", kind: "help", asked_at: t.now(), reason: "A real one" }] });
    const added = await postForm(t, "/caregivers", { _csrf: parent.csrf, name: "Grandma", phone: [phone.deviceId], can: ["status", "help"], until: "2026-11-19T18:00" }, { cookie: parent.cookie });
    const token = /\/care\/join\/([A-Za-z0-9_-]{43})/.exec(await added.text())?.[1] ?? "";
    const joined = await postForm(t, `/care/join/${token}`, { username: "grandma", password: PASSWORD, repeat: PASSWORD });
    const cookie = (joined.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    for (const [path, as] of [
      ["/login", undefined],
      ["/oauth/authorize", undefined],
      ["/requests", parent.cookie],
      ["/settings", parent.cookie],
      ["/care/login", undefined],
      ["/care", cookie],
    ] as const) {
      const html = await (await get(t, path, as)).text();
      expect(html, path).not.toContain("made-up family");
      expect(html, path).not.toContain("Belay demo");
    }
    // A database marked with something else, or an id that isn't one, isn't the demo's either.
    t.deps.db.prepare("INSERT INTO settings (key, value) VALUES ('demo', ?)").run(JSON.stringify({ id: "not an id" }));
    expect(isDemoDatabase(t.deps.db)).toBe(false);
  });

  it("is on no other server's pages", async () => {
    const t = testServer();
    expect(t.deps.config.demoBanner).toBe(false);
    const parent = await signIn(t);
    for (const [path, words, signedIn] of [
      ["/login", "Sign in", false],
      ["/add", "Add a phone", true],
      ["/settings", "Settings", true],
      ["/care/login", "Caregiver sign-in", false],
    ] as const) {
      const html = await (await get(t, path, signedIn ? parent.cookie : undefined)).text();
      expect(html, path).toContain(words);
      expect(html, path).not.toContain("made-up family");
      expect(html, path).not.toContain("demo-banner");
      expect(html, path).not.toContain("Belay demo");
    }
  });

  it("is painted readably, the same in light and dark", () => {
    const css = readFileSync(join(import.meta.dirname, "../src/static/app.css"), "utf8");
    const rule = /\.demo-banner\s*\{([^}]*)\}/.exec(css)?.[1] ?? "";
    const color = (prop: string) => new RegExp(`(?:^|;)\\s*${prop}:\\s*(#[0-9a-f]{6})`, "i").exec(rule)?.[1] ?? "";
    const lum = (hex: string) => {
      const [r = 0, g = 0, b = 0] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const [hi = 0, lo = 0] = [lum(color("background")), lum(color("color"))].sort((x, y) => y - x);
    expect((hi + 0.05) / (lo + 0.05)).toBeGreaterThanOrEqual(4.5);
    // Fixed colors, not the theme's: no dark-mode rule changes them.
    expect(css.match(/\.demo-banner/g)?.length).toBe(1);
  });
});
