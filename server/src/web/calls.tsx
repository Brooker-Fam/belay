/**
 * Phase 5's parent pages: a phone's Calls tab. Mounted inside the parent pages (web/routes.tsx),
 * after the sign-in and CSRF checks, so every form here is a signed-in parent's, with the
 * session's CSRF token. Each change goes through family/calls/changes.ts, which checks it, logs
 * it and bumps the policy; a refused one (an emergency number to block, a number another contact
 * has…) shows the tab again with why.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.js";
import { blockNumber, removeContact, saveContact, setCalls, setPrivateNumber, unblockNumber } from "../family/calls/changes.js";
import { listCallRecords } from "../family/calls/records.js";
import { callSettings, listContacts, listNumbers } from "../family/calls/store.js";
import { getDevice } from "../family/devices.js";
import { parentNumbersFor } from "../family/kidside.js";
import { type PolicyContext, RuleRefused } from "../family/policy.js";
import { recentRequests } from "../family/requests.js";
import { getSettings } from "../settings.js";
import { CallsPage } from "./pages/calls.js";
import { all, first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;
type Form = Record<string, string | File | (string | File)[]>;

export interface CallsWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

const SAVED: Record<string, string> = {
  calls_on: "Calls are on: Belay becomes the phone app when the phone gets this, within seconds if it's online.",
  calls_off: "Calls are off: Belay stops being the phone app when the phone gets this.",
  rules: "Saved. The phone gets it within seconds if it's online.",
  contact: "Saved. The phone gets it within seconds if it's online.",
  contact_removed: "Removed.",
  blocked: "Blocked. The phone gets it within seconds if it's online.",
  unblocked: "Unblocked.",
  private: "Saved: Belay never records calls with that number, or with a contact who has it.",
  private_removed: "Removed from the private numbers.",
};

class FormProblem extends Error {}

const ACTIONS = new Set(["ring", "voicemail", "reject"]);

export function callsWebRoutes(deps: Deps, h: CallsWebHelpers): Hono<WebEnv> {
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

  const page = (c: WebContext, deviceId: string, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const now = deps.now();
    const settings = getSettings(db);
    const device = getDevice(db, deviceId, settings, now);
    if (!device) return noPhone(c);
    const contacts = listContacts(db, device.id);
    const numbers = new Set(contacts.flatMap((x) => x.numbers));
    return render(
      c,
      <CallsPage
        view={h.view(c)}
        data={{
          device,
          settings: callSettings(db, device.id),
          contacts,
          privateNumbers: listNumbers(db, device.id, "private"),
          blockedNumbers: listNumbers(db, device.id, "blocked"),
          records: listCallRecords(db, device.id, { from: now - 30 * 86_400_000, limit: 100 }),
          report: device.enforcement?.calls ?? null,
          cardNotContacts: parentNumbersFor(db, device.id).filter((p) => !numbers.has(p.number)),
          requests: recentRequests(db, now, { deviceId: device.id, kind: "contact", status: "pending" }).flatMap((r) => (r.kind === "contact" ? [r] : [])),
          callDays: settings.callDays,
        }}
        message={extra.error ? undefined : SAVED[c.req.query("saved") ?? ""]}
        error={extra.error}
      />,
      status,
    );
  };

  /** A change from a form: saved and back to the tab, or the tab again with why not. */
  const change = async (c: WebContext, apply: (body: Form, deviceId: string) => string, section: string) => {
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
    return c.redirect(`/devices/${device.id}/calls?saved=${saved}#${section}`);
  };

  app.get("/devices/:id/calls", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    return page(c, device.id);
  });

  /** The rules, recording included; with enabled=1, calls are turned on too. A box left unticked is off. */
  app.post("/devices/:id/calls", (c) =>
    change(
      c,
      (body, deviceId) => {
        const mode = first(body, "mode");
        const outgoing = first(body, "outgoing");
        const unknown = first(body, "unknown");
        const withheld = first(body, "withheld");
        if (mode !== "open" && mode !== "contacts") throw new FormProblem("Choose who can call: anyone, or only contacts.");
        if (outgoing !== "any" && outgoing !== "contacts") throw new FormProblem("Choose whom the kid can call: any number, or only contacts.");
        if (!ACTIONS.has(unknown) || !ACTIONS.has(withheld)) throw new FormProblem("Choose ring, voicemail or refused for callers who aren't contacts, and for callers with no caller ID.");
        const turningOn = first(body, "enabled") === "1";
        setCalls(
          ctx(),
          deviceId,
          {
            ...(turningOn ? { enabled: true } : {}),
            mode,
            outgoing,
            unknown: unknown as "ring" | "voicemail" | "reject",
            withheld: withheld as "ring" | "voicemail" | "reject",
            quiet: first(body, "quiet") === "1",
            log: first(body, "log") === "1",
          },
          asParent(c),
        );
        return turningOn ? "calls_on" : "rules";
      },
      "calls",
    ),
  );

  app.post("/devices/:id/calls/off", (c) =>
    change(
      c,
      (_body, deviceId) => {
        setCalls(ctx(), deviceId, { enabled: false }, asParent(c));
        return "calls_off";
      },
      "calls",
    ),
  );

  /** Adds a contact or changes one (with id). Numbers come one per box; empty boxes don't count. */
  app.post("/devices/:id/calls/contacts", (c) =>
    change(
      c,
      (body, deviceId) => {
        const id = first(body, "id");
        const numbers = all(body, "number")
          .map((n) => n.trim())
          .filter(Boolean);
        if (!numbers.length) throw new FormProblem("Give the contact a number, in international form, like +15555550100.");
        saveContact(
          ctx(),
          deviceId,
          {
            ...(id ? { id } : {}),
            name: first(body, "name"),
            numbers,
            calls: first(body, "calls") === "1",
            texts: first(body, "texts") === "1",
            parent: first(body, "parent") === "1",
          },
          asParent(c),
        );
        return "contact";
      },
      "contacts",
    ),
  );

  app.post("/devices/:id/calls/contacts/:cid/remove", (c) =>
    change(
      c,
      (_body, deviceId) => {
        removeContact(ctx(), deviceId, c.req.param("cid"), asParent(c));
        return "contact_removed";
      },
      "contacts",
    ),
  );

  app.post("/devices/:id/calls/blocked", (c) =>
    change(
      c,
      (body, deviceId) => {
        blockNumber(ctx(), deviceId, first(body, "number"), asParent(c));
        return "blocked";
      },
      "blocked",
    ),
  );

  app.post("/devices/:id/calls/blocked/remove", (c) =>
    change(
      c,
      (body, deviceId) => {
        unblockNumber(ctx(), deviceId, first(body, "number"), asParent(c));
        return "unblocked";
      },
      "blocked",
    ),
  );

  app.post("/devices/:id/calls/private", (c) =>
    change(
      c,
      (body, deviceId) => {
        setPrivateNumber(ctx(), deviceId, first(body, "number"), true, asParent(c));
        return "private";
      },
      "private",
    ),
  );

  app.post("/devices/:id/calls/private/remove", (c) =>
    change(
      c,
      (body, deviceId) => {
        setPrivateNumber(ctx(), deviceId, first(body, "number"), false, asParent(c));
        return "private_removed";
      },
      "private",
    ),
  );

  return app;
}
