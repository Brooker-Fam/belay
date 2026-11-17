import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { routePath } from "hono/route";
import type { Deps } from "./deps.js";
import { deviceRoutes } from "./device/routes.js";
import type { Bindings } from "./http.js";
import { mcpRoutes } from "./mcp/routes.js";
import { oauthRoutes } from "./oauth/routes.js";
import { loadAssets } from "./web/assets.js";
import { webRoutes } from "./web/routes.js";

export function createApp(deps: Deps): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();
  const assets = loadAssets();

  app.get("/healthz", (c) => c.json({ ok: true }));
  assets.mount(app);
  // The device API sets its own limits per endpoint, and the parent pages theirs.
  const tooLarge = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "too_large", error_description: "The request is too large" }, 413) });
  app.use("/oauth/*", tooLarge);
  app.use("/mcp", bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Request too large" } }, 413) }));
  app.route("/api/v1", deviceRoutes(deps));
  app.route("/", oauthRoutes(deps, assets));
  app.route("/", mcpRoutes(deps));
  // The parent pages last: their middleware covers every path the routes above don't answer.
  app.route("/", webRoutes(deps, assets));

  app.onError((err, c) => {
    deps.log(`Error on ${c.req.method} ${routePath(c)}: ${err.stack ?? err.message}`);
    return c.json({ error: "server_error", error_description: "Something went wrong on the server" }, 500);
  });
  return app;
}
