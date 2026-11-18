/**
 * The parent pages' two actions about the server: recording a restore drill, and the daily
 * summary's settings. Mounted inside the parent pages (web/routes.tsx), after the sign-in and
 * CSRF checks; both are audited.
 */
import { type Context, Hono } from "hono";
import { z } from "zod";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import type { WebEnv } from "../web/routes.js";
import { recordCheck } from "./backups.js";
import { setDigest } from "./notify.js";

const DigestForm = z.object({
  on: z.literal("1").optional(),
  hour: z
    .string()
    .regex(/^\d{1,2}$/)
    .transform(Number)
    .pipe(z.int().min(0).max(23)),
});

/**
 * `refused` shows the Settings page again with a form's problem, as the other settings forms do.
 */
export function opsWebRoutes(deps: Deps, refused: (c: Context<WebEnv>, error: string) => Response | Promise<Response>): Hono<WebEnv> {
  const { db } = deps;
  const app = new Hono<WebEnv>();

  const parentId = (session: WebEnv["Variables"]["session"]): string => {
    if (!session) throw new Error("no session");
    return session.parent.id;
  };

  app.post("/server/drill", (c) => {
    const now = deps.now();
    const id = parentId(c.var.session);
    recordCheck(db, { kind: "drill", at: now, file: null, ok: true, detail: null, parentId: id });
    audit(db, now, { kind: "parent", parentId: id }, "backup.drill");
    return c.redirect("/#server");
  });

  app.post("/settings/digest", async (c) => {
    const form = DigestForm.safeParse(await c.req.parseBody());
    if (!form.success) return refused(c, "Pick an hour from the list, then save again.");
    const id = parentId(c.var.session);
    const on = form.data.on === "1";
    setDigest(db, id, on, form.data.hour);
    audit(db, deps.now(), { kind: "parent", parentId: id }, "settings.digest", { detail: { on, hour: form.data.hour } });
    return c.redirect("/settings?saved=digest#digest");
  });

  return app;
}
