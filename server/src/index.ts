/** Starts the Belay server. Configuration comes from the environment (docs/server.md). */
import { serve } from "@hono/node-server";
import { createApp } from "./app.js";
import { parentCount, newSetupToken } from "./auth/parents.js";
import { ConfigError, loadConfig } from "./config.js";
import { type DB, openDatabase } from "./db.js";
import { makeDeps } from "./deps.js";
import { cleanAgentTemp } from "./family/agent.js";
import { cleanUp } from "./maintenance.js";
import { serveDegraded } from "./ops/degraded.js";
import { startOps } from "./ops/jobs.js";

function main(): void {
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }
  let db: DB;
  try {
    db = openDatabase(config.dataDir);
  } catch (error) {
    // Say why on every page and on /healthz, instead of crashing in a loop, and keep trying (ops/degraded.ts).
    serveDegraded(config, error, main, { handleSignals: true });
    return;
  }
  const deps = makeDeps(config, db);
  const app = createApp(deps);

  if (parentCount(db) === 0) {
    const token = newSetupToken(db, Date.now());
    console.log(`No parent account yet. Open this link within 24 hours to create the first one:\n\n  ${config.publicUrl}/setup?token=${token}\n`);
  }
  if (config.publicUrl.startsWith("http:")) {
    console.warn("BELAY_PUBLIC_URL is plain http: fine for testing on your own network, but phones and claude.ai need https.");
  }

  cleanUp(db, Date.now());
  cleanAgentTemp(config.agentsDir, Date.now());
  const timer = setInterval(() => {
    cleanUp(db, Date.now());
    cleanAgentTemp(config.agentsDir, Date.now());
  }, 3_600_000);
  timer.unref();
  // Daily backups, the server's own health, and telling the parents about it (ops/jobs.ts).
  const stopOps = startOps(deps);

  const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    console.log(`Belay is listening on ${info.address}:${info.port} for ${config.publicUrl}`);
  });
  const stop = () => {
    clearInterval(timer);
    stopOps();
    // Phones holding a long-poll are answered now; they ask again when the server is back.
    deps.waiters.close();
    deps.fixWaiters.close();
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

main();
