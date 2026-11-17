import { readFileSync } from "node:fs";
import type { Env, Hono } from "hono";
import { sha256 } from "../crypto.js";

const FILES = {
  "app.css": "text/css; charset=utf-8",
  "app.js": "text/javascript; charset=utf-8",
} as const;

export interface Assets {
  /** URLs with a content hash, so browsers can cache them. */
  urls: { css: string; js: string };
  mount<E extends Env>(app: Hono<E>): void;
}

export function loadAssets(): Assets {
  const files = Object.entries(FILES).map(([name, type]) => {
    const body = readFileSync(new URL(`../static/${name}`, import.meta.url), "utf8");
    return { name, type, body, version: sha256(body).slice(0, 12) };
  });
  const url = (name: string) => `/static/${name}?v=${files.find((f) => f.name === name)?.version ?? "0"}`;
  return {
    urls: { css: url("app.css"), js: url("app.js") },
    mount(app) {
      for (const f of files) {
        app.get(`/static/${f.name}`, (c) => {
          c.header("Content-Type", f.type);
          c.header("Cache-Control", "public, max-age=31536000, immutable");
          c.header("X-Content-Type-Options", "nosniff");
          return c.body(f.body);
        });
      }
    },
  };
}
