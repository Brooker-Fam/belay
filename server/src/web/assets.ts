import { readFileSync } from "node:fs";
import type { Env, Hono } from "hono";
import { sha256 } from "../crypto.js";

/** Under /static/, with a content hash in the URL so browsers can cache them for good. */
const FILES = {
  "app.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
  "icon.svg": "image/svg+xml",
} as const;

/**
 * At the site's root and never cached: a service worker controls the pages under its own path,
 * and browsers check both of these for updates.
 */
const ROOT_FILES = {
  "sw.js": "text/javascript; charset=utf-8",
  "manifest.webmanifest": "application/manifest+json",
  // Phase 12: the caregiver pages' own, opening /care from a Home Screen.
  "care.webmanifest": "application/manifest+json",
} as const;

export interface Assets {
  /** URLs with a content hash, so browsers can cache them. */
  urls: { css: string; js: string; icon: string };
  mount<E extends Env>(app: Hono<E>): void;
}

function read(name: string): string {
  return readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");
}

export function loadAssets(): Assets {
  const files = Object.entries(FILES).map(([name, type]) => {
    const body = read(name);
    return { name, type, body, version: sha256(body).slice(0, 12) };
  });
  const rootFiles = Object.entries(ROOT_FILES).map(([name, type]) => ({ name, type, body: read(name) }));
  const url = (name: string) => `/static/${name}?v=${files.find((f) => f.name === name)?.version ?? "0"}`;
  return {
    urls: { css: url("app.css"), js: url("app.js"), icon: url("icon.svg") },
    mount(app) {
      for (const f of files) {
        app.get(`/static/${f.name}`, (c) => {
          c.header("Content-Type", f.type);
          c.header("Cache-Control", "public, max-age=31536000, immutable");
          c.header("X-Content-Type-Options", "nosniff");
          return c.body(f.body);
        });
      }
      for (const f of rootFiles) {
        app.get(`/${f.name}`, (c) => {
          c.header("Content-Type", f.type);
          c.header("Cache-Control", "no-cache");
          c.header("X-Content-Type-Options", "nosniff");
          // The service worker needs nothing: it fetches nothing and shows text only.
          if (f.name === "sw.js") c.header("Content-Security-Policy", "default-src 'none'");
          return c.body(f.body);
        });
      }
    },
  };
}
