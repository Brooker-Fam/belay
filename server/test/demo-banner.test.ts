/**
 * The demo banner (docs/demo.md): "Demo: a made-up family. Nothing here is real." on every page
 * of a server with BELAY_DEMO_BANNER=1, which only `npm run demo` sets, and on no other server's.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { get, signIn, testServer } from "./helpers.js";
import { structureProblems } from "./html.js";

const BANNER = "Demo: a made-up family. Nothing here is real.";

describe("the demo banner", () => {
  it("is on only when BELAY_DEMO_BANNER is 1", () => {
    const config = (value?: string) => loadConfig({ BELAY_PUBLIC_URL: "http://localhost:8080", ...(value === undefined ? {} : { BELAY_DEMO_BANNER: value }) }).demoBanner;
    expect(config("1")).toBe(true);
    for (const value of [undefined, "", "0", "true", "yes"]) expect(config(value), String(value)).toBe(false);
  });

  it("is on every page of a server that sets it, signed in or out, and the title says demo", async () => {
    const t = testServer({ config: { demoBanner: true } });
    const parent = await signIn(t);
    for (const [path, signedIn] of [
      ["/login", false],
      ["/oauth/authorize", false],
      ["/requests", true],
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

  it("is on no other server's pages", async () => {
    const t = testServer();
    expect(t.deps.config.demoBanner).toBe(false);
    const parent = await signIn(t);
    for (const [path, words, signedIn] of [
      ["/login", "Sign in", false],
      ["/add", "Add a phone", true],
      ["/settings", "Settings", true],
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
