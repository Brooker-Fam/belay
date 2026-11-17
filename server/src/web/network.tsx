/**
 * Phase 3's network logging on the parent pages: the switch (on the phone's page, under Web) and
 * the phone's Network tab. Mounted inside the parent pages (web/routes.tsx), after the sign-in and
 * CSRF checks, so the switch is a signed-in parent's, with the session's CSRF token. It goes
 * through family/network/changes.ts, which logs it and bumps the policy. AI apps have no way to it.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import { type DeviceView, getDevice } from "../family/devices.js";
import { setNetworkLog } from "../family/network/changes.js";
import { networkCutoff, networkDays, networkKept, networkSettings } from "../family/network/store.js";
import type { PolicyContext } from "../family/policy.js";
import { phoneLabels } from "../family/screentime/rules.js";
import { getSettings } from "../settings.js";
import { type NetworkCardData, NetworkPage } from "./pages/network.js";
import { first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;

export interface NetworkWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

/** The phone page's network logging card's data. */
export function networkCardData(db: DB, device: DeviceView): NetworkCardData {
  const settings = getSettings(db);
  return {
    device,
    settings: networkSettings(db, device.id),
    report: device.enforcement?.network_log ?? null,
    keptDays: networkKept(db, device.id).days,
    networkDays: settings.networkDays,
    aiReads: settings.aiScopes.network,
  };
}

export function networkWebRoutes(deps: Deps, h: NetworkWebHelpers): Hono<WebEnv> {
  const { db } = deps;
  const app = new Hono<WebEnv>();
  const ctx = (): PolicyContext => ({
    db,
    now: deps.now(),
    changed: (id) => {
      deps.waiters.changed(id);
    },
  });
  const asParent = (c: WebContext) => {
    const session = c.var.session;
    if (!session) throw new Error("no session");
    return { kind: "parent", parentId: session.parent.id } as const;
  };
  const deviceOf = (c: WebContext) => getDevice(db, c.req.param("id") ?? "", getSettings(db), deps.now());
  const noPhone = (c: WebContext) => h.message(c, "No such phone", "It may have been deleted.", 404, { href: "/", label: "Back to phones" });

  app.get("/devices/:id/network", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const now = deps.now();
    return render(
      c,
      <NetworkPage
        view={h.view(c)}
        data={{
          ...networkCardData(db, device),
          days: networkDays(db, device.id, { from: networkCutoff(now, getSettings(db).networkDays) }),
          labels: phoneLabels(db, device.id),
        }}
      />,
    );
  });

  /** The switch: on=1 turns network logging on, on=0 off. */
  app.post("/devices/:id/network", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const on = first(await c.req.parseBody({ all: true }), "on");
    if (on !== "1" && on !== "0") return h.message(c, "Nothing changed", "Use the switch on the phone's page.", 400, { href: `/devices/${device.id}#network`, label: device.name });
    setNetworkLog(ctx(), device.id, on === "1", asParent(c));
    return c.redirect(`/devices/${device.id}?saved=${on === "1" ? "network_on" : "network_off"}#network`);
  });

  return app;
}
