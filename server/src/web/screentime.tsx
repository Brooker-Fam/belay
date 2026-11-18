/**
 * Phase 3's parent pages: a phone's Screen time and Screen-time rules tabs, its family agreement,
 * and the family's stages. Mounted inside the parent pages (web/routes.tsx), after the sign-in
 * and CSRF checks, so every form here is a signed-in parent's, with the session's CSRF token.
 * Each change goes through family/screentime/changes.ts, which logs it and bumps the policy.
 */
import { type Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { DB } from "../db.js";
import type { Deps } from "../deps.js";
import { packageName } from "../device/schemas.js";
import { listApps } from "../family/apps.js";
import { getDevice } from "../family/devices.js";
import { listCommands } from "../family/commands.js";
import { LIMITS, type PolicyContext, RuleRefused, lockPhone } from "../family/policy.js";
import { recentRequests, type MoreTimeView } from "../family/requests.js";
import { agreementVersions } from "../family/screentime/agreement.js";
import { deleteStage, giveExtraTime, moveToStage, resetToStage, saveAgreement, saveStage, setPhoneRules, setPhoneSettings } from "../family/screentime/changes.js";
import { stageChanges } from "../family/screentime/classify.js";
import { WEEKDAYS, type Weekday, addDays, clockMinutes, validDay } from "../family/screentime/days.js";
import {
  NO_RULES,
  type Limit,
  type RuleSet,
  type Schedule,
  extraSince,
  familyLabels,
  getStage,
  listStages,
  newRuleId,
  phoneDay,
  phoneLabels,
  phoneRules,
  phoneZone,
  phonesOnStage,
  stageFor,
} from "../family/screentime/rules.js";
import { oneEach, usageDays } from "../family/screentime/usage.js";
import { type Labels, changeSentence } from "../family/screentime/words.js";
import { getSettings } from "../settings.js";
import { oneLine } from "../text.js";
import { timeZones } from "../time.js";
import { AgreementPage } from "./pages/agreement.js";
import { type AppChoice, RulesPage, ScreenTimePage } from "./pages/screentime.js";
import { StagePage, StagesPage } from "./pages/stages.js";
import { all, first, render, type WebEnv } from "./routes.js";
import type { View } from "./ui.js";

type WebContext = Context<WebEnv>;
type Form = Record<string, string | File | (string | File)[]>;

export interface ScreenTimeWebHelpers {
  view: (c: WebContext) => View;
  message: (c: WebContext, title: string, text: string, status?: ContentfulStatusCode, link?: { href: string; label: string }) => Promise<Response>;
}

const SAVED: Record<string, string> = {
  limit: "Saved. The phone gets it within seconds if it's online.",
  schedule: "Saved. The phone gets it within seconds if it's online.",
  removed: "Removed. The phone gets it within seconds if it's online.",
  other: "Saved. The phone gets it within seconds if it's online.",
  settings: "Saved. The phone gets it within seconds if it's online.",
  moved: "Moved. The phone gets its new stage's rules within seconds if it's online.",
  reset: "Put back: the phone gets the stage's rules again.",
  extra: "Given. The phone gets the extra time within seconds if it's online.",
  locked: "Paused, and the screen locks when the phone gets it, within seconds if it's online (during a call, once the call ends).",
  agreement: "Saved as a new version. The phone asks the kid again.",
  stage: "Saved. Every phone on this stage gets it within seconds if it's online.",
  stage_created: "Stage added.",
  stage_deleted: "Stage deleted.",
};

class FormProblem extends Error {}

/** Apps by package from ticked boxes (`name`) and a list typed in (`name_more`), each a package name. */
function packagesFrom(body: Form, name: string): string[] {
  const picked = all(body, name);
  const typed = first(body, `${name}_more`)
    .split(/[\s,]+/)
    .map((p) => p.trim())
    .filter(Boolean);
  const out = [...new Set([...picked, ...typed])];
  const bad = out.find((p) => !packageName.safeParse(p).success);
  if (bad) throw new FormProblem(`"${oneLine(bad, 60)}" isn't a package name. They look like com.example.app.`);
  return out;
}

const minutesFrom = (text: string, what: string, max = 1440): number => {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n > max) throw new FormProblem(`${what} is a whole number of minutes, 0 to ${max}.`);
  return n;
};

/** A limit from its form: a new one, or the one with the form's id. */
function limitFrom(body: Form, rules: RuleSet, labels: Labels): RuleSet {
  const id = first(body, "id");
  const existing = id ? rules.limits.find((l) => l.id === id) : undefined;
  if (id && !existing) throw new FormProblem("That limit isn't there any more. Reload the page.");
  const total = first(body, "scope") === "total";
  const packages = total ? ["*"] : packagesFrom(body, "app");
  if (!packages.length) throw new FormProblem("Choose at least one app, or Every app for a daily total.");
  const minutes = minutesFrom(first(body, "minutes"), "Minutes a day");
  const byDay: Partial<Record<Weekday, number>> = {};
  for (const d of WEEKDAYS) {
    const text = first(body, `day_${d}`);
    if (text !== "") byDay[d] = minutesFrom(text, "Each day's minutes");
  }
  const name = oneLine(first(body, "name"), 60) || (total ? "Screen time" : packages.length === 1 ? oneLine(labels(packages[0] ?? ""), 60) || "App" : "Apps");
  const limit: Limit = { id: existing?.id ?? newRuleId("l"), name, packages, minutes, by_day: Object.keys(byDay).length ? byDay : null };
  return { ...rules, limits: existing ? rules.limits.map((l) => (l.id === limit.id ? limit : l)) : [...rules.limits, limit] };
}

const KIND_NAMES = { school: "School", bedtime: "Bedtime", custom: "Schedule" } as const;

function scheduleFrom(body: Form, rules: RuleSet): RuleSet {
  const id = first(body, "id");
  const existing = id ? rules.schedules.find((s) => s.id === id) : undefined;
  if (id && !existing) throw new FormProblem("That schedule isn't there any more. Reload the page.");
  const kind = first(body, "kind");
  if (kind !== "school" && kind !== "bedtime" && kind !== "custom") throw new FormProblem("Choose school, bedtime or custom.");
  const days = all(body, "days").filter((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d));
  if (!days.length) throw new FormProblem("Choose at least one day.");
  const start = first(body, "start");
  const end = first(body, "end");
  if (clockMinutes(start) === null || clockMinutes(end) === null) throw new FormProblem("Times are like 21:00.");
  const skip = first(body, "skip")
    .split(/[\s,]+/)
    .filter(Boolean);
  if (skip.some((d) => !validDay(d))) throw new FormProblem("Days it doesn't start are dates like 2026-11-26, one per line.");
  if (skip.length > 366) throw new FormProblem("List at most 366 days it doesn't start.");
  const schedule: Schedule = {
    id: existing?.id ?? newRuleId("s"),
    kind,
    name: oneLine(first(body, "name"), 60) || KIND_NAMES[kind],
    days: WEEKDAYS.filter((d) => days.includes(d)),
    start,
    end,
    allow: packagesFrom(body, "allow"),
    lock: first(body, "lock") === "1",
    skip: [...new Set(skip)].sort(),
  };
  return { ...rules, schedules: existing ? rules.schedules.map((s) => (s.id === schedule.id ? schedule : s)) : [...rules.schedules, schedule] };
}

function otherFrom(body: Form, rules: RuleSet): RuleSet {
  const unmeasured = first(body, "if_unmeasured");
  if (unmeasured !== "pause_limited" && unmeasured !== "keep_open") throw new FormProblem("Choose what happens when Belay can't count.");
  const warn = minutesFrom(first(body, "warn_before"), "The warning", 60);
  let selfServe: RuleSet["self_serve"] = null;
  if (first(body, "self_serve") === "1") {
    const minutes = minutesFrom(first(body, "self_minutes"), "Self-serve minutes", 240);
    const times = Number(first(body, "self_times"));
    if (minutes < 1 || !Number.isInteger(times) || times < 1 || times > 10) throw new FormProblem("Self-serve is 1 to 240 minutes, 1 to 10 times a day.");
    selfServe = { minutes, times };
  }
  return { ...rules, exempt: packagesFrom(body, "exempt").sort(), self_serve: selfServe, if_unmeasured: unmeasured, warn_before: warn };
}

/** The user apps on a phone, to pick from. */
const phoneApps = (db: DB, deviceId: string): AppChoice[] => listApps(db, deviceId).map((a) => ({ package: a.package, label: a.label }));

/** The user apps on any of the family's phones, for a stage. */
const familyApps = (db: DB): AppChoice[] =>
  db
    .prepare<[], AppChoice>("SELECT package, MIN(label) AS label FROM apps WHERE system = 0 AND present = 1 GROUP BY package ORDER BY label COLLATE NOCASE LIMIT 500")
    .all();

export function screenTimeWebRoutes(deps: Deps, h: ScreenTimeWebHelpers): Hono<WebEnv> {
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
  const saved = (c: WebContext) => SAVED[c.req.query("saved") ?? ""];

  // ── A phone's Screen time tab ──────────────────────────────────────

  app.get("/devices/:id/screen-time", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const now = deps.now();
    const phone = phoneRules(db, device.id);
    const today = phoneDay(db, device.id, now, phone.settings);
    const sent = oneEach(usageDays(db, device.id, { from: addDays(today, -6), to: today }));
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, -i)).map((day) => ({ day, usage: sent.find((u) => u.day === day) ?? null }));
    const asked = c.req.query("day") ?? "";
    const selectedDay = validDay(asked) && asked <= today ? asked : today;
    const selected = oneEach(usageDays(db, device.id, { from: selectedDay, to: selectedDay }))[0] ?? null;
    const requests = recentRequests(db, now, { deviceId: device.id, kind: "more_time" }).filter(
      (r): r is MoreTimeView => r.kind === "more_time" && (r.status === "pending" || r.status === "talk"),
    );
    const known = new Set(db.prepare<[string], { package: string }>("SELECT package FROM apps WHERE device_id = ?").all(device.id).map((r) => r.package));
    return render(
      c,
      <ScreenTimePage
        view={h.view(c)}
        data={{
          device,
          phone,
          today,
          zone: phoneZone(db, device.id, phone.settings),
          days,
          selected,
          selectedDay,
          report: device.enforcement?.screen_time ?? null,
          labels: phoneLabels(db, device.id),
          known,
          requests,
          extraToday: extraSince(db, device.id, today).filter((e) => e.day === today),
          lastLock: listCommands(db, device.id, now, { kind: "lock_now", limit: 5 }).find((x) => x.state !== "replaced") ?? null,
        }}
        message={saved(c)}
      />,
    );
  });

  /** A parent locks the phone now: a pause, and the screen locked once (as MCP's lock_phone). */
  app.post("/devices/:id/lock", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    const minutes = Number(first(body, "minutes"));
    const note = first(body, "note");
    if (![15, 30, 60, 120, 240].includes(minutes)) return h.message(c, "Choose how long", "15 minutes to 4 hours.", 400);
    if (note.length > LIMITS.pauseNote) return h.message(c, "That note is too long", `Keep it under ${LIMITS.pauseNote} characters.`, 400);
    if (device.revokedAt !== null) return h.message(c, "Disconnected", "This phone is disconnected, so it wouldn't get that.", 400);
    lockPhone(ctx(), device.id, { minutes, note: note || null }, asParent(c));
    return c.redirect(`/devices/${device.id}/screen-time?saved=locked#lock`);
  });

  // ── A phone's Screen-time rules tab ────────────────────────────────

  const rulesPage = (c: WebContext, deviceId: string, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const device = getDevice(db, deviceId, getSettings(db), deps.now());
    if (!device) return noPhone(c);
    const phone = phoneRules(db, device.id);
    const stage = stageFor(db, device.id, phone);
    const today = phoneDay(db, device.id, deps.now(), phone.settings);
    return render(
      c,
      <RulesPage
        view={h.view(c)}
        data={{
          device,
          phone,
          zone: phoneZone(db, device.id, phone.settings),
          stages: listStages(db),
          next: stage?.next ? { name: stage.next.name, unlocks: stage.next.unlocks, how: stage.next.how } : null,
          apps: phoneApps(db, device.id),
          labels: phoneLabels(db, device.id),
          extraToday: extraSince(db, device.id, today).filter((e) => e.day === today),
          today,
          zones: timeZones(),
        }}
        message={extra.error ? undefined : saved(c)}
        error={extra.error}
      />,
      status,
    );
  };

  app.get("/devices/:id/screen-time/rules", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    return rulesPage(c, device.id);
  });

  /** A change to the phone's rules from a form: saved, or the page again with why not. */
  const phoneChange = async (c: WebContext, change: (body: Form, rules: RuleSet, labels: Labels) => RuleSet, savedAs: string, section: string) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    try {
      const phone = phoneRules(db, device.id);
      setPhoneRules(ctx(), device.id, change(body, phone.rules, phoneLabels(db, device.id)), asParent(c));
    } catch (error) {
      if (error instanceof FormProblem || error instanceof RuleRefused) return rulesPage(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/screen-time/rules?saved=${savedAs}#${section}`);
  };

  /** The stage's own version of a limit or schedule, back on this phone. */
  const putBack = (rules: RuleSet, stage: RuleSet | null, what: "limits" | "schedules", id: string): RuleSet => {
    const theirs = (stage?.[what] ?? []) as (Limit | Schedule)[];
    const original = theirs.find((r) => r.id === id);
    if (!original) throw new FormProblem("The stage doesn't have that one.");
    const mine = rules[what] as (Limit | Schedule)[];
    const next = mine.some((r) => r.id === id) ? mine.map((r) => (r.id === id ? original : r)) : [...mine, original];
    return { ...rules, [what]: next };
  };

  app.post("/devices/:id/screen-time/rules/limits", (c) => phoneChange(c, limitFrom, "limit", "limits"));
  app.post("/devices/:id/screen-time/rules/limits/:item/remove", (c) =>
    phoneChange(c, (_body, rules) => ({ ...rules, limits: rules.limits.filter((l) => l.id !== c.req.param("item")) }), "removed", "limits"),
  );
  app.post("/devices/:id/screen-time/rules/limits/:item/reset", (c) =>
    phoneChange(c, (_body, rules) => putBack(rules, phoneRules(db, c.req.param("id")).stage?.stage.rules ?? null, "limits", c.req.param("item")), "reset", "limits"),
  );
  app.post("/devices/:id/screen-time/rules/schedules", (c) => phoneChange(c, (body, rules) => scheduleFrom(body, rules), "schedule", "schedules"));
  app.post("/devices/:id/screen-time/rules/schedules/:item/remove", (c) =>
    phoneChange(c, (_body, rules) => ({ ...rules, schedules: rules.schedules.filter((s) => s.id !== c.req.param("item")) }), "removed", "schedules"),
  );
  app.post("/devices/:id/screen-time/rules/schedules/:item/reset", (c) =>
    phoneChange(c, (_body, rules) => putBack(rules, phoneRules(db, c.req.param("id")).stage?.stage.rules ?? null, "schedules", c.req.param("item")), "reset", "schedules"),
  );
  app.post("/devices/:id/screen-time/rules/other", (c) => phoneChange(c, (body, rules) => otherFrom(body, rules), "other", "other"));

  app.post("/devices/:id/screen-time/rules/settings", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    try {
      setPhoneSettings(ctx(), device.id, { measure: first(body, "measure") === "1", zone: first(body, "zone"), day_starts: first(body, "day_starts") }, asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) return rulesPage(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/screen-time/rules?saved=settings#measuring`);
  });

  app.post("/devices/:id/screen-time/rules/stage", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const stageId = first(await c.req.parseBody({ all: true }), "stage");
    try {
      moveToStage(ctx(), device.id, stageId || null, asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) return rulesPage(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/screen-time/rules?saved=moved#stage`);
  });

  app.post("/devices/:id/screen-time/rules/reset", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    try {
      resetToStage(ctx(), device.id, asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) return rulesPage(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/screen-time/rules?saved=reset#stage`);
  });

  app.post("/devices/:id/screen-time/extra", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    const minutes = Number(first(body, "minutes"));
    try {
      giveExtraTime(ctx(), device.id, { limitId: first(body, "limit") || "*", minutes }, asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) return rulesPage(c, device.id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/devices/${device.id}/screen-time/rules?saved=extra#extra`);
  });

  // ── The family agreement ───────────────────────────────────────────

  app.get("/devices/:id/agreement", (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    return render(c, <AgreementPage view={h.view(c)} device={device} versions={agreementVersions(db, device.id)} message={saved(c)} />);
  });

  app.post("/devices/:id/agreement", async (c) => {
    const device = deviceOf(c);
    if (!device) return noPhone(c);
    const body = await c.req.parseBody({ all: true });
    const titles = all(body, "title");
    const texts = all(body, "text");
    const sections = titles.map((title, i) => ({ title, text: texts[i] ?? "" }));
    try {
      saveAgreement(ctx(), device.id, sections, asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) {
        return render(c, <AgreementPage view={h.view(c)} device={device} versions={agreementVersions(db, device.id)} error={error.message} />, 400);
      }
      throw error;
    }
    return c.redirect(`/devices/${device.id}/agreement?saved=agreement`);
  });

  // ── Stages ─────────────────────────────────────────────────────────

  const stagesPage = (c: WebContext, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) =>
    render(
      c,
      <StagesPage
        view={h.view(c)}
        stages={listStages(db).map((stage) => ({ stage, phones: phonesOnStage(db, stage.id) }))}
        phones={db.prepare<[], { id: string; name: string }>("SELECT id, name FROM devices WHERE revoked_at IS NULL ORDER BY name COLLATE NOCASE").all()}
        message={extra.error ? undefined : saved(c)}
        error={extra.error}
      />,
      status,
    );

  const stagePage = (c: WebContext, id: string, extra: { error?: string } = {}, status: ContentfulStatusCode = 200) => {
    const stage = getStage(db, id);
    if (!stage) return h.message(c, "No such stage", "It may have been deleted.", 404, { href: "/stages", label: "Back to stages" });
    const before = listStages(db)
      .filter((s) => s.number < stage.number)
      .at(-1);
    const labels = familyLabels(db);
    return render(
      c,
      <StagePage
        view={h.view(c)}
        stage={stage}
        phones={phonesOnStage(db, stage.id)}
        fromBefore={before ? { name: before.name, unlocks: stageChanges(before.rules, stage.rules).map((ch) => changeSentence(ch, { for: "kid", label: labels })) } : null}
        apps={familyApps(db)}
        labels={labels}
        message={extra.error ? undefined : saved(c)}
        error={extra.error}
      />,
      status,
    );
  };

  app.get("/stages", (c) => stagesPage(c));

  app.post("/stages", async (c) => {
    const body = await c.req.parseBody({ all: true });
    const from = first(body, "from");
    let rules: RuleSet = structuredClone(NO_RULES);
    if (from.startsWith("stage:")) rules = structuredClone(getStage(db, from.slice(6))?.rules ?? NO_RULES);
    else if (from.startsWith("phone:")) rules = structuredClone(phoneRules(db, from.slice(6)).rules);
    try {
      const done = saveStage(ctx(), null, { name: first(body, "name"), how: first(body, "how"), rules }, asParent(c));
      return c.redirect(`/stages/${done.stage.id}?saved=stage_created`);
    } catch (error) {
      if (error instanceof RuleRefused) return stagesPage(c, { error: error.message }, 400);
      throw error;
    }
  });

  app.get("/stages/:sid", (c) => stagePage(c, c.req.param("sid")));

  /** A change to a stage: its name, number and words, or its rules. */
  const stageChange = async (c: WebContext, change: (body: Form, stage: NonNullable<ReturnType<typeof getStage>>) => { name?: string; number?: number; how?: string | null; rules?: RuleSet }, section: string) => {
    const id = c.req.param("sid") ?? "";
    const stage = getStage(db, id);
    if (!stage) return h.message(c, "No such stage", "It may have been deleted.", 404, { href: "/stages", label: "Back to stages" });
    const body = await c.req.parseBody({ all: true });
    try {
      const next = change(body, stage);
      saveStage(ctx(), id, { name: next.name ?? stage.name, number: next.number ?? stage.number, how: next.how !== undefined ? next.how : stage.how, rules: next.rules ?? stage.rules }, asParent(c));
    } catch (error) {
      if (error instanceof FormProblem || error instanceof RuleRefused) return stagePage(c, id, { error: error.message }, 400);
      throw error;
    }
    return c.redirect(`/stages/${id}?saved=stage#${section}`);
  };

  app.post("/stages/:sid", (c) =>
    stageChange(
      c,
      (body, stage) => {
        // Phase 11: Off belay keeps its name and place; its page only has the family's words.
        if (stage.offBelay) return { how: first(body, "how") || null };
        const number = Number(first(body, "number"));
        if (!Number.isInteger(number) || number < 1 || number > 99) throw new FormProblem("A stage's number is 1 to 99.");
        return { name: first(body, "name"), number, how: first(body, "how") || null };
      },
      "top",
    ),
  );
  app.post("/stages/:sid/limits", (c) => stageChange(c, (body, stage) => ({ rules: limitFrom(body, stage.rules, familyLabels(db)) }), "limits"));
  app.post("/stages/:sid/limits/:item/remove", (c) =>
    stageChange(c, (_body, stage) => ({ rules: { ...stage.rules, limits: stage.rules.limits.filter((l) => l.id !== c.req.param("item")) } }), "limits"),
  );
  app.post("/stages/:sid/schedules", (c) => stageChange(c, (body, stage) => ({ rules: scheduleFrom(body, stage.rules) }), "schedules"));
  app.post("/stages/:sid/schedules/:item/remove", (c) =>
    stageChange(c, (_body, stage) => ({ rules: { ...stage.rules, schedules: stage.rules.schedules.filter((s) => s.id !== c.req.param("item")) } }), "schedules"),
  );
  app.post("/stages/:sid/other", (c) => stageChange(c, (body, stage) => ({ rules: otherFrom(body, stage.rules) }), "other"));

  app.post("/stages/:sid/delete", (c) => {
    try {
      deleteStage(ctx(), c.req.param("sid"), asParent(c));
    } catch (error) {
      if (error instanceof RuleRefused) return stagePage(c, c.req.param("sid"), { error: error.message }, 400);
      throw error;
    }
    return c.redirect("/stages?saved=stage_deleted");
  });

  return app;
}
