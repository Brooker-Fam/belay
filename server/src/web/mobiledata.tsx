/**
 * Phase 13's mobile data on the parent pages: a phone's Mobile data tab (web/pages/mobiledata.tsx),
 * the measuring switch and the Wi-Fi-only apps. Mounted inside the parent pages (web/routes.tsx),
 * after the sign-in and CSRF checks, so each change is a signed-in parent's, with the session's
 * CSRF token. They go through family/mobiledata/changes.ts, which logs them and bumps the policy;
 * an app it refuses (one the phone never blocks) shows the page again with why (routes.tsx's
 * onError). AI apps reach the Wi-Fi-only apps only through MCP, and measuring not at all.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.js";
import { packageName } from "../device/schemas.js";
import { type DeviceView, getDevice } from "../family/devices.js";
import { listApps } from "../family/apps.js";
import { changeWifiOnly, setMobileDataMeasure } from "../family/mobiledata/changes.js";
import { mobileDataCutoff, mobileDataDays, mobileDataKept, mobileDataSettings, wifiOnlyApps } from "../family/mobiledata/store.js";
import { type PolicyContext, RuleRefused, neverBlockedOn } from "../family/policy.js";
import { validDay } from "../family/screentime/days.js";
import { phoneLabels } from "../family/screentime/rules.js";
import { getSettings } from "../settings.js";
import { MobileDataPage } from "./pages/mobiledata.js";
import { first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;

export interface MobileDataWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

/** What the tab says after a change, by `saved`. */
const SAVED: Record<string, string> = {
  measure_on: "Measuring is on. The phone starts sending how much mobile data each app uses when it gets this, within seconds if it's online.",
  measure_off: "Measuring is off. The phone stops sending it when it gets this, within seconds if it's online.",
  wifi_only: "Saved: the phone keeps it off mobile data when it gets this, within seconds if it's online.",
  wifi_only_already: "It was Wi-Fi only already.",
  wifi_only_removed: "Saved: it may use mobile data again once the phone gets this, within seconds if it's online.",
};

/** The days the tab shows: the last 30. */
const DAYS_SHOWN = 30;

export function mobileDataWebRoutes(deps: Deps, h: MobileDataWebHelpers): Hono<WebEnv> {
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
  const disconnected = (c: WebContext, device: DeviceView) =>
    h.message(c, "Nothing changed", "This phone is disconnected.", 400, { href: `/devices/${device.id}/mobile-data`, label: device.name });

  app.get("/devices/:id/mobile-data", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const now = deps.now();
    const settings = getSettings(db);
    const days = mobileDataDays(db, device.id, { from: mobileDataCutoff(now, settings.mobileDataDays), limit: DAYS_SHOWN });
    const asked = c.req.query("day") ?? "";
    const selected = validDay(asked) ? (days.find((d) => d.day === asked) ?? mobileDataDays(db, device.id, { from: asked, to: asked })[0] ?? null) : (days[0] ?? null);
    const wifiOnly = wifiOnlyApps(db, device.id);
    const listed = new Set(wifiOnly.map((w) => w.package));
    const never = neverBlockedOn(db, device.id);
    // Android's own parts (system apps without an icon) are never Wi-Fi only on the phone, like the apps it never blocks.
    const present = listApps(db, device.id, { includeSystem: true });
    return render(
      c,
      <MobileDataPage
        view={h.view(c)}
        message={SAVED[c.req.query("saved") ?? ""]}
        data={{
          device,
          settings: mobileDataSettings(db, device.id),
          wifiOnly,
          report: device.enforcement?.mobile_data ?? null,
          candidates: present
            .filter((a) => !listed.has(a.package) && never(a.package) === null && (a.launchable || !a.system))
            .map((a) => ({ package: a.package, label: a.label })),
          installed: new Set(present.map((a) => a.package)),
          never,
          days,
          selected,
          labels: phoneLabels(db, device.id),
          mobileDataDays: settings.mobileDataDays,
          aiReads: settings.aiScopes.mobile_data,
          keptDays: mobileDataKept(db, device.id).days,
        }}
      />,
    );
  });

  /** Measuring: on=1 turns it on, on=0 off. A parent's alone. */
  app.post("/devices/:id/mobile-data/measure", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const on = first(await c.req.parseBody({ all: true }), "on");
    if (on !== "1" && on !== "0") return h.message(c, "Nothing changed", "Use the switch on the phone's Mobile data page.", 400, { href: `/devices/${device.id}/mobile-data`, label: device.name });
    setMobileDataMeasure(ctx(), device.id, on === "1", asParent(c));
    return c.redirect(`/devices/${device.id}/mobile-data?saved=${on === "1" ? "measure_on" : "measure_off"}#measuring`);
  });

  /** Makes an app Wi-Fi only: one the phone never blocks is refused, with why. `back`: the day it was chosen on. */
  app.post("/devices/:id/mobile-data/wifi-only", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return disconnected(c, device);
    const body = await c.req.parseBody({ all: true });
    const pkg = first(body, "package").trim();
    if (!packageName.safeParse(pkg).success) throw new RuleRefused("Give the app's package name, like com.example.app.");
    const done = changeWifiOnly(ctx(), device.id, { add: [pkg], remove: [] }, asParent(c));
    const back = first(body, "back");
    const day = validDay(back) ? `&day=${back}` : "";
    return c.redirect(`/devices/${device.id}/mobile-data?saved=${done.result.added.length ? "wifi_only" : "wifi_only_already"}${day}#wifi-only`);
  });

  /** Lets an app use mobile data again: a parent's (an AI app only proposes it). */
  app.post("/devices/:id/mobile-data/wifi-only/remove", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return disconnected(c, device);
    const pkg = first(await c.req.parseBody({ all: true }), "package").trim();
    if (!packageName.safeParse(pkg).success) throw new RuleRefused("That isn't an app's package name.");
    changeWifiOnly(ctx(), device.id, { add: [], remove: [pkg] }, asParent(c));
    return c.redirect(`/devices/${device.id}/mobile-data?saved=wifi_only_removed#wifi-only`);
  });

  return app;
}
