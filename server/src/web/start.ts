/**
 * The Getting started card's two actions (family/start.ts): a parent hides it on their own Phones
 * page, or brings it back from Settings. Mounted inside the parent pages (web/routes.tsx), after the
 * sign-in and CSRF checks; both are in the activity log. Neither form has a field of its own: the
 * parent is the session's, and the CSRF token is checked before these run.
 */
import { Hono } from "hono";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import { hideStart, showStart } from "../family/start.js";
import type { WebEnv } from "./routes.js";

export function startWebRoutes(deps: Deps): Hono<WebEnv> {
  const { db } = deps;
  const app = new Hono<WebEnv>();

  const parentId = (session: WebEnv["Variables"]["session"]): string => {
    if (!session) throw new Error("no session");
    return session.parent.id;
  };

  app.post("/start/hide", (c) => {
    const id = parentId(c.var.session);
    const now = deps.now();
    if (hideStart(db, id, now)) audit(db, now, { kind: "parent", parentId: id }, "start.hidden");
    return c.redirect("/");
  });

  app.post("/start/show", (c) => {
    const id = parentId(c.var.session);
    if (showStart(db, id)) audit(db, deps.now(), { kind: "parent", parentId: id }, "start.shown");
    return c.redirect("/#start");
  });

  return app;
}
