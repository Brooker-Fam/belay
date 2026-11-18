/**
 * Phase 4 and 7's parent pages: a phone's Location and help tab, and marking a help request seen.
 * Mounted inside the parent pages (web/routes.tsx), after the sign-in and CSRF checks, so every
 * form here is a signed-in parent's, with the session's CSRF token. Each change goes through
 * family/location/changes.ts or family/kidside-changes.ts, which log it and bump the policy.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.js";
import { LOCATE_NOW_MS } from "../family/commands.js";
import { getDevice } from "../family/devices.js";
import { phoneHelp } from "../family/kidside.js";
import { markHelpSeen, setKidNumber, setPhoneParentNumbers } from "../family/kidside-changes.js";
import { type LocationChange, locateNow, removePlace, savePlace, setLost, setLocation } from "../family/location/changes.js";
import { describeFix, mapLink } from "../family/location/describe.js";
import { checkOutcome, latestFix, listChecks, listPlaceEvents } from "../family/location/fixes.js";
import { type Notify, listPlaces, locationSettings } from "../family/location/store.js";
import { type PolicyContext, RuleRefused } from "../family/policy.js";
import { unseenHelp } from "../family/requests.js";
import { getSettings } from "../settings.js";
import { LocationPage } from "./pages/location.js";
import type { Where } from "./pages/help.js";
import { all, first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;

export interface LocationWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

const SAVED: Record<string, string> = {
  sharing: "Saved. The phone gets it within seconds if it's online.",
  place: "Saved. The phone gets it within seconds if it's online.",
  place_removed: "Removed.",
  lost_on: "Lost mode is on. The phone gets it within seconds if it's online.",
  lost_off: "Lost mode is off.",
  kid_number: "Saved.",
  numbers: "Saved. The phone's emergency card gets them within seconds if it's online.",
  seen: "Marked seen. The kid's phone shows that you saw it.",
};

class FormProblem extends Error {}

/** "40.1, -73.2" (or with a space, as maps copy them): a latitude and a longitude. */
export function parseCenter(text: string): { lat: number; lng: number } | null {
  const match = /^\s*(-?\d{1,2}(?:\.\d+)?)\s*[,\s]\s*(-?\d{1,3}(?:\.\d+)?)\s*$/.exec(text);
  if (!match) return null;
  const lat = Number(match[1]);
  const lng = Number(match[2]);
  return Math.abs(lat) <= 90 && Math.abs(lng) <= 180 ? { lat, lng } : null;
}

/** How the parent pages describe a fix: by the phone's places, and a link to the family's map site. */
export function whereFor(deps: Deps): Where {
  const { db } = deps;
  const site = getSettings(db).mapSite;
  return {
    describe: (deviceId, fix) => describeFix(fix, listPlaces(db, deviceId)).words,
    mapLink: (fix) => mapLink(site, fix.lat, fix.lng),
  };
}

export function locationWebRoutes(deps: Deps, h: LocationWebHelpers): Hono<WebEnv> {
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

  const page = (c: WebContext, deviceId: string, extra: { error?: string; checked?: string } = {}, status: ContentfulStatusCode = 200) => {
    const now = deps.now();
    const device = getDevice(db, deviceId, getSettings(db), now);
    if (!device) return noPhone(c);
    const checkedId = extra.checked ?? c.req.query("check");
    // Only this check's answer, or one of a check that took its place in its 2 minutes, as a caregiver's (the eighth review's K6).
    const checked = checkedId ? { command: checkedId, outcome: checkOutcome(db, device.id, checkedId, { withinMs: LOCATE_NOW_MS }) } : null;
    return render(
      c,
      <LocationPage
        view={h.view(c)}
        data={{
          device,
          settings: locationSettings(db, device.id),
          places: listPlaces(db, device.id),
          latest: latestFix(db, device.id),
          checks: listChecks(db, device.id, now),
          events: listPlaceEvents(db, device.id, { from: now - 7 * 86_400_000 }),
          report: device.enforcement?.location ?? null,
          help: phoneHelp(db, device.id),
          familyNumbers: getSettings(db).parentNumbers,
          unseenHelp: unseenHelp(db, device.id),
          where: whereFor(deps),
          checked,
        }}
        message={extra.error ? undefined : SAVED[c.req.query("saved") ?? ""]}
        error={extra.error}
      />,
      status,
    );
  };

  /** A change from a form: saved and back to the tab, or the tab again with why not. */
  const change = async (c: WebContext, apply: (body: Record<string, string | File | (string | File)[]>, deviceId: string) => string, section: string) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    let saved: string;
    try {
      saved = apply(body, device.id);
    } catch (error) {
      if (error instanceof FormProblem || error instanceof RuleRefused) return page(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/location?saved=${saved}#${section}`);
  };

  app.get("/devices/:id/location", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    return page(c, device.id);
  });

  app.post("/devices/:id/location", (c) =>
    change(
      c,
      (body, deviceId) => {
        const mode = first(body, "mode");
        if (mode !== "off" && mode !== "on_demand" && mode !== "periodic") throw new FormProblem("Choose off, on demand or periodic.");
        const provider = first(body, "provider") || "gps";
        if (provider !== "gps" && provider !== "fused") throw new FormProblem("Choose GPS only, or Android's combined provider.");
        const start = first(body, "hours_start");
        const end = first(body, "hours_end");
        if ((start === "") !== (end === "")) throw new FormProblem("Give both hours, or neither for all day.");
        const everyText = first(body, "every");
        const update: LocationChange = {
          mode,
          provider,
          fallbackFused: first(body, "fallback_fused") === "1",
          keepOn: first(body, "keep_on") === "1",
          hours: start === "" ? null : { start, end },
          ...(everyText === "" ? {} : { everyMinutes: Number(everyText) }),
        };
        setLocation(ctx(), deviceId, update, asParent(c));
        return "sharing";
      },
      "sharing",
    ),
  );

  /**
   * Check now: the phone gets a check within seconds; this waits up to a minute for its answer,
   * the fix or its word that it couldn't (or got the check too late), and stops as soon as either
   * comes. Then the page shows it.
   */
  app.post("/devices/:id/location/check", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    if (device.revokedAt !== null) return page(c, device.id, { error: "This phone is disconnected, so it can't answer." }, 400);
    let command: string;
    try {
      command = locateNow(ctx(), device.id, asParent(c)).result.command;
    } catch (error) {
      if (error instanceof RuleRefused) return page(c, device.id, { error: error.message }, 400);
      throw error;
    }
    await deps.fixWaiters.wait(device.id, () => checkOutcome(db, device.id, command, { withinMs: LOCATE_NOW_MS }) !== null, deps.locateWaitMs, c.req.raw.signal);
    return c.redirect(`/devices/${device.id}/location?check=${encodeURIComponent(command)}#where`);
  });

  app.post("/devices/:id/location/places", (c) =>
    change(
      c,
      (body, deviceId) => {
        const useFix = first(body, "use_fix") === "1";
        let center: { lat: number; lng: number } | null;
        if (useFix) {
          // Never one Android says an app made up.
          const fix = latestFix(db, deviceId, { real: true });
          if (!fix) throw new FormProblem("Belay has no fix for this phone yet: paste the coordinates instead.");
          center = { lat: fix.lat, lng: fix.lng };
        } else {
          center = parseCenter(first(body, "center"));
          if (!center) throw new FormProblem("Paste the center as a latitude and a longitude, like 40.10000, -73.20000, or use where the phone is now.");
        }
        const radius = Number(first(body, "radius"));
        const notify = all(body, "notify").filter((n): n is Notify => n === "arrive" || n === "leave");
        const id = first(body, "id");
        savePlace(ctx(), deviceId, { ...(id ? { id } : {}), name: first(body, "name"), lat: center.lat, lng: center.lng, radiusM: radius, notify }, asParent(c));
        return "place";
      },
      "places",
    ),
  );

  app.post("/devices/:id/location/places/:pid/remove", (c) =>
    change(
      c,
      (_body, deviceId) => {
        removePlace(ctx(), deviceId, c.req.param("pid"), asParent(c));
        return "place_removed";
      },
      "places",
    ),
  );

  app.post("/devices/:id/location/lost", (c) =>
    change(
      c,
      (body, deviceId) => {
        if (first(body, "off") === "1") {
          setLost(ctx(), deviceId, null, asParent(c));
          return "lost_off";
        }
        setLost(ctx(), deviceId, { message: first(body, "message"), number: first(body, "number") || null }, asParent(c));
        return "lost_on";
      },
      "lost",
    ),
  );

  app.post("/devices/:id/numbers/kid", (c) =>
    change(
      c,
      (body, deviceId) => {
        const number = first(body, "number").replace(/[\s().-]/g, "");
        setKidNumber(ctx(), deviceId, number || null, asParent(c));
        return "kid_number";
      },
      "numbers",
    ),
  );

  app.post("/devices/:id/numbers/parents", (c) =>
    change(
      c,
      (body, deviceId) => {
        if (first(body, "family") === "1") {
          setPhoneParentNumbers(ctx(), deviceId, null, asParent(c));
          return "numbers";
        }
        const names = all(body, "name");
        const numbers = all(body, "number");
        const list = names.map((name, i) => ({ name: name.trim(), number: (numbers[i] ?? "").trim() })).filter((p) => p.name || p.number);
        if (list.some((p) => !p.name || !p.number)) throw new FormProblem("Give each number a name, and each name a number.");
        setPhoneParentNumbers(ctx(), deviceId, list, asParent(c));
        return "numbers";
      },
      "numbers",
    ),
  );

  /** "I've seen it", on a help request: the kid's phone shows that a parent saw it. */
  app.post("/devices/:id/requests/:requestId/seen", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    const note = first(body, "note");
    const done = markHelpSeen(ctx(), device.id, c.req.param("requestId"), asParent(c), note || null);
    if (!done.result) return h.message(c, "No such help request", "It may have been deleted with its phone.", 404, { href: "/requests", label: "Back to requests" });
    const back = first(body, "back");
    if (back === "location") return c.redirect(`/devices/${device.id}/location?saved=seen`);
    if (back === "device") return c.redirect(`/devices/${device.id}`);
    return c.redirect("/requests?saved=seen");
  });

  return app;
}
