/**
 * When the database can't be opened or upgraded (a migration failed, it's from a newer Belay,
 * the disk refuses), the server doesn't crash in a loop with nobody told why. It keeps
 * listening and says so: /healthz answers 200 with the reason (503 with ?strict=1), the parent
 * pages show a plain notice, and the device API, OAuth and MCP answer 503 with Retry-After.
 * Phones keep enforcing their rules on their own meanwhile. It tries again every 5 minutes and
 * starts normally once the database opens. The notice names no paths, SQL or family data; the
 * server's log has the details.
 */
import { type ServerType, serve } from "@hono/node-server";
import { Hono } from "hono";
import { html } from "hono/html";
import type { Config } from "../config.js";
import { MigrationError, openDatabase } from "../db.js";
import { formatDuration } from "../time.js";
import { diskSpace } from "./backups.js";
import { healthzAnswer, isStrict, serverProblems } from "./health.js";

export const RETRY_MS = 5 * 60_000;

/** What went wrong, in a sentence for the parents. */
export function databaseProblem(error: unknown): string {
  if (error instanceof MigrationError) return `Belay couldn't upgrade its database (step ${error.version}, ${error.migration}).`;
  if (error instanceof Error && error.message.includes("from a newer Belay")) return "The database is from a newer version of Belay than this server.";
  return "Belay couldn't open its database.";
}

/** The whole server while the database can't be opened. */
export function degradedApp(config: Config, problem: string, now: () => number = Date.now): Hono {
  const app = new Hono();
  app.get("/healthz", (c) => {
    let disk = null;
    try {
      disk = config.dataDir === ":memory:" ? null : diskSpace(config.dataDir);
    } catch {
      // Unknown.
    }
    c.header("Cache-Control", "no-store");
    const answer = healthzAnswer(serverProblems({ now: now(), tz: "UTC", disk, db: null, backups: null, phoneSkews: [], database: problem }), isStrict(c));
    return c.json(answer.body, answer.status);
  });
  app.all("*", (c) => {
    c.header("Retry-After", String(RETRY_MS / 1000));
    c.header("Cache-Control", "no-store");
    const path = c.req.path;
    if (path.startsWith("/api/") || path.startsWith("/mcp") || path.startsWith("/oauth/") || path.startsWith("/.well-known/")) {
      return c.json({ error: "unavailable", error_description: "Belay's server can't open its database right now. Try again later." }, 503);
    }
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
    return c.html(
      html`<!doctype html>
        <html lang="en">
          <head>
            <meta charset="utf-8" />
            <meta name="viewport" content="width=device-width, initial-scale=1" />
            <meta name="robots" content="noindex" />
            <title>Belay isn't working</title>
          </head>
          <body>
            <main>
              <h1>Belay isn't working right now</h1>
              <p>${problem}</p>
              <p>
                The phones keep enforcing their rules on their own until it's back. For whoever runs this server: its log has the details. If this
                started with an upgrade, go back to the version before (docs/server.md, "Upgrades"), or restore a backup. Belay tries again every 5
                minutes.
              </p>
            </main>
          </body>
        </html>`,
      503,
    );
  });
  return app;
}

export interface Degraded {
  /** The port it listens on. */
  port: Promise<number>;
  close(): Promise<void>;
}

/**
 * Serves the notice in place of the server and tries the database again every `retryMs`; once
 * it opens, stops and calls `recovered` (index.ts starts the server normally). With
 * `handleSignals`, SIGTERM and SIGINT stop it.
 */
export function serveDegraded(config: Config, error: unknown, recovered: () => void, opts: { retryMs?: number; handleSignals?: boolean; log?: (line: string) => void } = {}): Degraded {
  const log =
    opts.log ??
    ((line: string) => {
      console.error(line);
    });
  const problem = databaseProblem(error);
  const detail = (e: unknown) => (e instanceof Error ? e.message : String(e));
  log(`${problem} Until it can, every page says so and /healthz gives the reason; it tries again every ${formatDuration(opts.retryMs ?? RETRY_MS)}. ${detail(error)}`);
  let server: ServerType | null = null;
  const port = new Promise<number>((resolve) => {
    server = serve({ fetch: degradedApp(config, problem).fetch, hostname: config.host, port: config.port }, (info) => {
      resolve(info.port);
    });
  });
  let lastError = detail(error);
  const close = () =>
    new Promise<void>((resolve) => {
      clearInterval(retry);
      if (opts.handleSignals) {
        process.off("SIGTERM", onSignal);
        process.off("SIGINT", onSignal);
      }
      if (server) {
        server.close(() => {
          resolve();
        });
      } else resolve();
    });
  const retry = setInterval(() => {
    try {
      openDatabase(config.dataDir).close();
    } catch (again) {
      if (detail(again) !== lastError) log(`The database still can't be opened: ${detail(again)}`);
      lastError = detail(again);
      return;
    }
    log("The database opens now: starting normally.");
    void close().then(recovered);
  }, opts.retryMs ?? RETRY_MS);
  const onSignal = () => {
    void close().then(() => process.exit(0));
  };
  if (opts.handleSignals) {
    process.on("SIGTERM", onSignal);
    process.on("SIGINT", onSignal);
  }
  return { port, close };
}
