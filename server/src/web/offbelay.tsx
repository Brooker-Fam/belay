/**
 * Phase 11's parent pages: stopping collecting one data category on a phone (after a confirmation
 * that lists exactly what goes), and handing a phone over (after the parent types its name, as for
 * hardening). Mounted inside the parent pages (web/routes.tsx), after the sign-in and CSRF checks,
 * so every form here is a signed-in parent's. Each change goes through family/collection.ts or
 * family/offbelay/changes.ts, which log it and bump the policy. AI apps have no way to any of it.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import { isCollected, keptAbout, keptFor, stopCollecting } from "../family/collection.js";
import { type DeviceView, getDevice } from "../family/devices.js";
import { cancelHandover, handOver } from "../family/offbelay/changes.js";
import { handoverOf } from "../family/offbelay/store.js";
import { activePause, currentDecisions, getRules, type PolicyContext, RuleRefused } from "../family/policy.js";
import { offBelayStage, phoneRules } from "../family/screentime/rules.js";
import { getSettings } from "../settings.js";
import { CollectionPage, type OffBelayData } from "./pages/offbelay.js";
import { first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;

export interface OffBelayWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

/** What still blocks on the phone, in words for "Belay still … on this phone". */
function blockingWords(db: DB, deviceId: string, now: number): string[] {
  const rules = getRules(db, deviceId);
  const screen = phoneRules(db, deviceId).rules;
  const present = new Set(db.prepare<[string], { package: string }>("SELECT package FROM apps WHERE device_id = ? AND present = 1").all(deviceId).map((a) => a.package));
  const blocked = [...currentDecisions(db, deviceId).values()].filter((d) => d.state === "blocked" && present.has(d.package)).length;
  return [
    ...(activePause(rules, now) ? ["pauses the phone"] : []),
    ...(rules.newApps === "ask" ? ["holds new apps for you"] : []),
    ...(blocked ? [`hides ${blocked === 1 ? "an app" : `${blocked} apps`} you blocked`] : []),
    ...(rules.privateDns || rules.chrome || rules.hideBrowsers ? ["filters the web"] : []),
    ...(screen.limits.length || screen.schedules.length ? ["has screen-time limits or schedules"] : []),
  ];
}

/** The phone page's Off belay section's data. */
export function offBelayData(db: DB, device: DeviceView, now: number): OffBelayData {
  return {
    device,
    kept: keptAbout(db, device.id, now),
    handover: handoverOf(db, device.id),
    stage: phoneRules(db, device.id).stage?.stage ?? null,
    offBelay: offBelayStage(db),
    blocking: blockingWords(db, device.id, now),
  };
}

export function offBelayWebRoutes(deps: Deps, h: OffBelayWebHelpers): Hono<WebEnv> {
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

  // ── Stop collecting ────────────────────────────────────────────────

  app.get("/devices/:id/collection/:category", (c) => {
    const device = deviceOf(c);
    const category = c.req.param("category");
    if (!device) return noPhone(c);
    if (!isCollected(category)) return h.message(c, "No such kind of data", "Choose one on the phone's page.", 404, { href: `/devices/${device.id}#collecting`, label: device.name });
    return render(c, <CollectionPage view={h.view(c)} device={device} kept={keptFor(db, device.id, category, deps.now())} />);
  });

  app.post("/devices/:id/collection/:category", async (c) => {
    const device = deviceOf(c);
    const category = c.req.param("category");
    if (!device) return noPhone(c);
    if (!isCollected(category)) return h.message(c, "No such kind of data", "Choose one on the phone's page.", 404, { href: `/devices/${device.id}#collecting`, label: device.name });
    const fingerprint = first(await c.req.parseBody({ all: true }), "fingerprint");
    try {
      stopCollecting(ctx(), device.id, category, asParent(c), fingerprint);
    } catch (error) {
      if (!(error instanceof RuleRefused)) throw error;
      return render(c, <CollectionPage view={h.view(c)} device={device} kept={keptFor(db, device.id, category, deps.now())} error={error.message} />, 409);
    }
    return c.redirect(`/devices/${device.id}?saved=collection_stopped#collecting`);
  });

  // ── Handing the phone over ─────────────────────────────────────────

  app.post("/devices/:id/handover", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const typed = first(await c.req.parseBody({ all: true }), "confirm");
    if (typed.toLowerCase() !== device.name.trim().toLowerCase()) {
      throw new RuleRefused(`Handing a phone over lifts its locks and clears reset protection. To do it, type the phone's name, ${device.name}, in the box.`);
    }
    handOver(ctx(), device.id, asParent(c));
    return c.redirect(`/devices/${device.id}?saved=handed_over#handover`);
  });

  app.post("/devices/:id/handover/cancel", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    cancelHandover(ctx(), device.id, asParent(c));
    return c.redirect(`/devices/${device.id}?saved=handover_cancelled#handover`);
  });

  return app;
}
