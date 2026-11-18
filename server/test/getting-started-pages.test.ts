/**
 * The Phones page's Getting started card (web/pages/start.tsx): a new family's first page; a list
 * with each step's state in words, what the server sees and a link to where it's done, names
 * escaped; the optional parts with their pages and the guide's sections, which are real headings;
 * and hiding it, for one parent, kept on the server and in the activity log, brought back from
 * Settings, and gone by itself once the essential steps are done. Made-up names only.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { newSetupToken } from "../src/auth/parents.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { setOpsOptions } from "../src/ops/options.js";
import { browserFor, enrollPhone, get, PASSWORD, postForm, testServer } from "./helpers.js";
import { elements, parseHtml, structureProblems, textOf, type El } from "./html.js";
import { MCP, PASSPHRASE, family } from "./start-helpers.js";

const DOCS = "https://github.com/brooker-fam/belay/blob/main/docs";
const GUIDE = `${DOCS}/guide.md`;

/** The card's steps on a page: each list item's title and the state in words beside it. */
function stepsOn(html: string): { title: string; state: string; item: El }[] {
  const list = elements(parseHtml(html)).find((e) => e.tag === "ol" && e.attrs.get("class") === "start-steps");
  if (!list) return [];
  return list.children
    .filter((c): c is El => typeof c !== "string" && c.tag === "li")
    .map((item) => {
      const all = elements(item);
      return {
        title: textOf(all.find((e) => e.tag === "strong") ?? item).trim(),
        state: textOf(all.find((e) => (e.attrs.get("class") ?? "").startsWith("chip state")) ?? item).trim(),
        item,
      };
    });
}

const hrefs = (el: El) => elements(el).flatMap((e) => (e.tag === "a" && e.attrs.has("href") ? [e.attrs.get("href") ?? ""] : []));

describe("Getting started on the Phones page", () => {
  it("is a new family's first page, from setting up: no phone yet, and the card the first thing on it", async () => {
    const t = testServer();
    setOpsOptions(t.deps, { env: {} });
    const token = newSetupToken(t.deps.db, t.now());
    const setup = await postForm(t, "/setup", { token, name: "Sam", username: "sam", password: PASSWORD, repeat: PASSWORD, timezone: "America/New_York" });
    expect(setup.status).toBe(302);
    expect(setup.headers.get("location")).toBe("/");
    const cookie = (setup.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const res = await get(t, "/", cookie);
    // No more sending a new family to Add a phone: that's the card's first step.
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(structureProblems(html)).toEqual([]);
    expect(html).not.toContain("No phones yet");
    const steps = stepsOn(html);
    expect(steps.map((s) => [s.title, s.state])).toEqual([
      ["Add the kid's phone", "Not yet"],
      ["The phone applies its first rules", "Not yet"],
      ["Look over the phone's rules and its stage", "Up to you"],
      ["Turn on notifications", "Not yet"],
      ["Decide what AI apps may read", "Not yet"],
      ["Connect Claude", "Not yet"],
      ["Backups with a passphrase", "Not yet"],
    ]);
    // A screen reader hears each step's state after its title, and which are optional.
    const read = steps.map((s) => textOf(elements(s.item).find((e) => e.tag === "p") ?? s.item).replace(/\s+/g, " ").trim());
    expect(read[0]).toBe("Add the kid's phone: Not yet");
    expect(read[4]).toBe("Decide what AI apps may read: Not yet, Optional");
    expect(html).toContain("Setting Belay up, step by step: none of the 4 essential steps is done yet.");
    // Each links to where it's done.
    expect(hrefs(steps[0]!.item)).toEqual([`${GUIDE}#4-get-belay-onto-the-phone`, "/add"]);
    expect(hrefs(steps[3]!.item)).toEqual(["/settings#notifications"]);
    expect(hrefs(steps[4]!.item)).toEqual(["/settings#ai-reads"]);
    expect(hrefs(steps[5]!.item)).toEqual(["/settings#ai", `${GUIDE}#5-connect-claude`]);
    expect(hrefs(steps[6]!.item)).toEqual([`${DOCS}/server.md#encrypted-backups`]);
    // The places it links to are there: Settings' sections, by their ids.
    const settings = elements(parseHtml(await (await get(t, "/settings", cookie)).text()));
    for (const id of ["notifications", "ai-reads", "ai"]) expect(settings.some((e) => e.attrs.get("id") === id), id).toBe(true);
  });

  it("says what the server sees in each step, escaping the family's names, and links each phone's own parts to its pages", async () => {
    const f = await family();
    const phone = await enrollPhone(f.t, "Alex's <b>phone</b>");
    await f.form(`/devices/${phone.deviceId}/protect`);
    await f.applied(phone);
    browserFor(f.t, f.sam.parent.id, () => []);
    createPersonalToken(f.t.deps.db, f.t.now(), f.sam.parent.id, "Claude <i>Code</i>", MCP);
    setOpsOptions(f.t.deps, { env: { BELAY_BACKUP_PASSPHRASE: "too short" } });
    const { html } = await f.page();
    expect(structureProblems(html)).toEqual([]);
    expect(html).not.toContain("<b>phone</b>");
    expect(html).not.toContain("<i>Code</i>");
    const steps = stepsOn(html);
    expect(steps.map((s) => s.state)).toEqual(["Done", "Done", "Up to you", "Done", "Not yet", "Done", "Not yet"]);
    const words = (i: number) => textOf(steps[i]!.item).replace(/\s+/g, " ");
    expect(words(0)).toContain("Alex's <b>phone</b> is enrolled.");
    expect(words(1)).toContain("Alex's <b>phone</b> applied its rules.");
    expect(words(2)).toContain("Belay can't tell when you've looked, so this one has no tick.");
    expect(words(3)).toContain("On for you in Chrome on Android.");
    expect(words(4)).toContain("Not saved yet, so Belay's defaults apply. AI apps may read: apps, device status, requests, screen time, stage and agreement, and mobile data.");
    expect(html).toContain("3 of the 4 essential steps are done");
    expect(words(5)).toContain("Connected for you: Claude <i>Code</i>.");
    expect(words(6)).toContain("A passphrase is set, but it can't be used: BELAY_BACKUP_PASSPHRASE is too short");
    // Why it matters only while it isn't done.
    expect(words(0)).not.toContain("device owner");
    expect(words(6)).toContain("without the passphrase, nobody can read it");
    expect(hrefs(steps[2]!.item)).toEqual([`/devices/${phone.deviceId}#rules`, `/devices/${phone.deviceId}/screen-time/rules`, "/stages"]);
    // When you're ready: the optional parts, each with its page and the guide's section.
    const later = elements(parseHtml(html)).find((e) => e.tag === "ul" && e.attrs.get("class") === "later small");
    expect(later && hrefs(later)).toEqual([
      `/devices/${phone.deviceId}/calls`,
      `${GUIDE}#calls-with-belay-as-the-phone-app`,
      `/devices/${phone.deviceId}/location`,
      `${GUIDE}#location-off-by-default`,
      `/devices/${phone.deviceId}#network-logging`,
      `${GUIDE}#network-logging-off-by-default`,
      `/devices/${phone.deviceId}/mobile-data`,
      `${GUIDE}#mobile-data-off-by-default`,
      "/caregivers",
      `${GUIDE}#someone-else-looking-after-the-kid`,
      `/devices/${phone.deviceId}/agreement`,
      `${GUIDE}#talk-about-it`,
    ]);
    // Each guide link says which part it's about.
    expect(elements(later!).filter((e) => e.tag === "a" && e.attrs.has("aria-label")).map((e) => e.attrs.get("aria-label"))).toEqual([
      "Calls, in the guide",
      "Location, in the guide",
      "Network logging, in the guide",
      "Mobile data, in the guide",
      "Caregivers, in the guide",
      "The family agreement, in the guide",
    ]);
    // Each phone's own part is on that phone's page, which is there.
    for (const path of [`/devices/${phone.deviceId}/calls`, `/devices/${phone.deviceId}/location`, `/devices/${phone.deviceId}/mobile-data`, `/devices/${phone.deviceId}/agreement`, "/caregivers"]) {
      expect((await f.page(path)).status, path).toBe(200);
    }
    expect((await f.page(`/devices/${phone.deviceId}`)).html).toContain('id="network-logging"');
  });

  it("a parent hides it for themselves, kept on the server and in the activity log; Settings brings it back; it hides by itself once the essentials are done", async () => {
    const f = await family();
    expect((await f.page()).html).toContain("Getting started");
    // Only with the session's CSRF token.
    expect((await postForm(f.t, "/start/hide", {}, { cookie: f.sam.cookie })).status).toBe(403);
    expect((await postForm(f.t, "/start/hide", { _csrf: f.sam.csrf })).status).toBe(401);
    const hidden = await f.form("/start/hide");
    expect(hidden.status).toBe(302);
    expect(hidden.headers.get("location")).toBe("/");
    expect(f.start()).toMatchObject({ hiddenAt: f.t.now(), shown: false });
    const home = await f.page();
    expect(home.status).toBe(200);
    expect(home.html).not.toContain("Getting started");
    // Hidden, with no phone, the page says so plainly.
    expect(home.html).toContain("No phones yet.");
    // Alex's is still there: it's per parent.
    expect((await f.page("/", f.alex)).html).toContain('<h2 id="start-title" class="in-card">Getting started</h2>');
    // Hiding again changes nothing, and logs nothing.
    await f.form("/start/hide");
    const log = () => listAudit(f.t.deps.db, { limit: 50, includeReads: false }).filter((e) => e.action.startsWith("start."));
    expect(log().map((e) => [e.action, e.parentName])).toEqual([["start.hidden", "Sam"]]);
    expect((await f.page("/activity")).html).toContain("hid Getting started on their Phones page");
    // Settings brings it back.
    const settings = (await f.page("/settings")).html;
    expect(structureProblems(settings)).toEqual([]);
    expect(settings).toContain("Show Getting started again</button>");
    expect((await f.page("/settings", f.alex)).html).not.toContain("Show Getting started again");
    const shown = await f.form("/start/show");
    expect(shown.headers.get("location")).toBe("/#start");
    expect(f.start().hiddenAt).toBeNull();
    expect((await f.page()).html).toContain("Getting started");
    expect(log().map((e) => e.action)).toEqual(["start.shown", "start.hidden"]);
    expect((await f.page("/activity")).html).toContain("brought Getting started back on their Phones page");

    // With every essential step done, it's gone by itself, and Settings has nothing to bring back.
    const phone = await enrollPhone(f.t, "Alex's phone");
    await f.form(`/devices/${phone.deviceId}/protect`);
    await f.applied(phone);
    browserFor(f.t, f.sam.parent.id, () => []);
    setOpsOptions(f.t.deps, { env: { BELAY_BACKUP_PASSPHRASE: PASSPHRASE } });
    expect((await f.page()).html).not.toContain("Getting started");
    await f.form("/start/hide");
    expect((await f.page("/settings")).html).not.toContain("Show Getting started again");
  });

  it("links only to the guide's and the server docs' real sections", async () => {
    const f = await family();
    const html = (await f.page()).html;
    // GitHub's anchors: the heading in lower case, without punctuation, each space a hyphen.
    const slugs = (path: string) =>
      new Set(
        readFileSync(new URL(path, import.meta.url), "utf8")
          .split("\n")
          .filter((line) => /^#{1,6} /.test(line))
          .map((line) =>
            line
              .replace(/^#+ /, "")
              .trim()
              .toLowerCase()
              .replace(/[^\p{L}\p{N}\s_-]/gu, "")
              .replace(/\s/g, "-"),
          ),
      );
    const docs: Record<string, Set<string>> = { "guide.md": slugs("../../docs/guide.md"), "server.md": slugs("../../docs/server.md") };
    const linked = [...html.matchAll(/href="https:\/\/github\.com\/brooker-fam\/belay\/blob\/main\/docs\/(guide|server)\.md#([^"]+)"/g)].map((m) => [`${m[1] ?? ""}.md`, m[2] ?? ""] as const);
    expect(linked.length).toBeGreaterThanOrEqual(9);
    for (const [file, anchor] of linked) expect(docs[file]?.has(anchor), `${file}#${anchor}`).toBe(true);
  });
});
