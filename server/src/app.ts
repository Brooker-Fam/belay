import { Hono } from "hono";
import { routePath } from "hono/route";
import type { Deps } from "./deps.js";
import { deviceRoutes } from "./device/routes.js";
import type { Bindings } from "./http.js";

export function createApp(deps: Deps): Hono<{ Bindings: Bindings }> {
  const app = new Hono<{ Bindings: Bindings }>();

  app.get("/healthz", (c) => c.json({ ok: true }));
  app.route("/api/v1", deviceRoutes(deps));

  app.onError((err, c) => {
    deps.log(`Error on ${c.req.method} ${routePath(c)}: ${err.stack ?? err.message}`);
    return c.json({ error: "server_error", error_description: "Something went wrong on the server" }, 500);
  });
  return app;
}
