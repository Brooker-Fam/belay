/**
 * Phase 12 on the parent pages: the Caregivers page (docs/design/phase12-caregivers.md). Mounted
 * inside the parent pages (web/routes.tsx), after the sign-in and CSRF checks, so every form here
 * is a signed-in parent's. Each change goes through family/caregivers/changes.ts, which logs it and
 * gives the phones it touches new policies. Never an AI app's: there's no tool for any of it.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { Deps } from "../deps.js";
import { type CaregiverInput, addCaregiver, changeCaregiver, endCaregiver, newCaregiverLink, removeCaregiver, renewCaregiver } from "../family/caregivers/changes.js";
import { CAREGIVER_CAN, LINK_TTL_MS, SUGGESTED_ACCESS_MS, getCaregiver, listCaregivers } from "../family/caregivers/store.js";
import { listDevices } from "../family/devices.js";
import { type PolicyContext, RuleRefused } from "../family/policy.js";
import { getSettings } from "../settings.js";
import { parseWhen } from "../time.js";
import { CaregiverLinkPage, CaregiverPage, CaregiversPage } from "./pages/caregivers.js";
import { all, first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;
type Form = Record<string, string | File | (string | File)[]>;

export interface CaregiverWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

const SAVED: Record<string, string> = {
  changed: "Saved. Their phones get it within seconds if they're online.",
  renewed: "Renewed. Their phones show the new end within seconds if they're online.",
  again: "They have access again. Their phones list them within seconds if they're online; they sign in with the password they chose.",
  ended: "Their access ended: they're signed out, their notifications stopped, and their phones stop listing them within seconds if they're online.",
  removed: "Removed.",
};

/** A suggested end: three days from now, on the hour. */
const suggestedEnd = (now: number) => Math.ceil((now + SUGGESTED_ACCESS_MS) / 3_600_000) * 3_600_000;

export function caregiverWebRoutes(deps: Deps, h: CaregiverWebHelpers): Hono<WebEnv> {
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
  const phones = () => listDevices(db, getSettings(db), deps.now());
  const input = (body: Form): CaregiverInput => {
    const can = new Set(all(body, "can"));
    return { name: first(body, "name"), phones: all(body, "phone").slice(0, 100), can: Object.fromEntries(CAREGIVER_CAN.map((k) => [k, can.has(k)])) as CaregiverInput["can"] };
  };
  const until = (body: Form): number | null => parseWhen(first(body, "until"), getSettings(db).timezone);

  const listPage = (c: WebContext, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) =>
    render(
      c,
      <CaregiversPage
        view={h.view(c)}
        caregivers={listCaregivers(db)}
        phones={phones()}
        suggestedEnd={suggestedEnd(deps.now())}
        message={extra.error ? undefined : SAVED[c.req.query("saved") ?? ""]}
        error={extra.error}
      />,
      status,
    );
  const notHere = (c: WebContext) => h.message(c, "No such caregiver", "They may have been removed.", 404, { href: "/caregivers", label: "Back to Caregivers" });
  const onePage = (c: WebContext, id: string, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const caregiver = getCaregiver(db, id);
    if (!caregiver) return notHere(c);
    return render(
      c,
      <CaregiverPage
        view={h.view(c)}
        caregiver={caregiver}
        phones={phones()}
        suggestedEnd={suggestedEnd(deps.now())}
        message={extra.error ? undefined : SAVED[c.req.query("saved") ?? ""]}
        error={extra.error}
      />,
      status,
    );
  };
  const linkPage = (c: WebContext, id: string, link: string) => {
    const caregiver = getCaregiver(db, id);
    if (!caregiver) return notHere(c);
    const url = `${deps.config.publicUrl}/care/join/${link}`;
    return render(c, <CaregiverLinkPage view={h.view(c)} caregiver={caregiver} link={url} expiresAt={Math.min(deps.now() + LINK_TTL_MS, caregiver.endsAt)} />);
  };

  /** A change from a form: done, or the page again with why not (RuleRefused's words). */
  const attempt = async (c: WebContext, again: (error: string) => Promise<Response>, apply: () => Response | Promise<Response>) => {
    try {
      return await apply();
    } catch (error) {
      if (error instanceof RuleRefused) return again(error.message);
      throw error;
    }
  };

  app.get("/caregivers", (c) => listPage(c));

  app.post("/caregivers", async (c) => {
    const body = await c.req.parseBody({ all: true });
    return attempt(
      c,
      (error) => listPage(c, { error }, 400),
      () => {
        const made = addCaregiver(ctx(), { ...input(body), endsAt: until(body) ?? Number.NaN }, asParent(c));
        return linkPage(c, made.caregiver.id, made.link);
      },
    );
  });

  app.get("/caregivers/:id", (c) => onePage(c, c.req.param("id")));

  app.post("/caregivers/:id", async (c) => {
    const id = c.req.param("id");
    if (!getCaregiver(db, id)) return notHere(c);
    const body = await c.req.parseBody({ all: true });
    return attempt(
      c,
      (error) => onePage(c, id, { error }, 400),
      () => {
        changeCaregiver(ctx(), id, input(body), asParent(c));
        return c.redirect(`/caregivers/${id}?saved=changed`);
      },
    );
  });

  app.post("/caregivers/:id/renew", async (c) => {
    const id = c.req.param("id");
    const before = getCaregiver(db, id);
    if (!before) return notHere(c);
    const body = await c.req.parseBody({ all: true });
    return attempt(
      c,
      (error) => onePage(c, id, { error }, 400),
      () => {
        const wasEnded = before.endedAt !== null || before.endsAt <= deps.now();
        renewCaregiver(ctx(), id, until(body) ?? Number.NaN, asParent(c));
        return c.redirect(`/caregivers/${id}?saved=${wasEnded ? "again" : "renewed"}`);
      },
    );
  });

  app.post("/caregivers/:id/end", (c) => {
    const id = c.req.param("id");
    if (!getCaregiver(db, id)) return notHere(c);
    endCaregiver(ctx(), id, asParent(c));
    return c.redirect(`/caregivers/${id}?saved=ended`);
  });

  app.post("/caregivers/:id/link", (c) => {
    const id = c.req.param("id");
    if (!getCaregiver(db, id)) return notHere(c);
    return attempt(
      c,
      (error) => onePage(c, id, { error }, 400),
      () => linkPage(c, id, newCaregiverLink(ctx(), id, asParent(c))),
    );
  });

  app.post("/caregivers/:id/remove", (c) => {
    const id = c.req.param("id");
    if (!getCaregiver(db, id)) return notHere(c);
    return attempt(
      c,
      (error) => onePage(c, id, { error }, 400),
      () => {
        removeCaregiver(ctx(), id, asParent(c));
        return c.redirect("/caregivers?saved=removed");
      },
    );
  });

  return app;
}
