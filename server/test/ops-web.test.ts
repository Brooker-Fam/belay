import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { latestCheck, recordCheck, runDailyBackup } from "../src/ops/backups.js";
import { getDigest } from "../src/ops/notify.js";
import { setOpsOptions } from "../src/ops/options.js";
import { DRILL_KEY } from "../src/ops/verify.js";
import { enrollPhone, get, postForm, signIn, T0 } from "./helpers.js";
import { FAST_SCRYPT, PASSPHRASE, dailyContext, opsServer, type OpsServer } from "./ops-helpers.js";

const DAY = 86_400_000;

/** The page as a parent reads it: tags gone, entities decoded, spaces collapsed. */
function words(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/ ([:;,.)])/g, "$1");
}

async function family() {
  const t = opsServer();
  const sam = await signIn(t, "sam", "Sam");
  await enrollPhone(t, "Sam's phone");
  return { t, sam };
}

const home = async (t: OpsServer, cookie: string) => words(await (await get(t, "/", cookie)).text());

describe("This server, on the Phones page", () => {
  it("before any backup: none yet, never verified, and time for a first restore drill", async () => {
    const { t, sam } = await family();
    const page = await home(t, sam.cookie);
    expect(page).toContain("This server Backups and health OK");
    expect(page).toContain("Last backup: none yet; last verified: never.");
    expect(page).toContain("Time for a restore drill: there hasn't been one yet.");
    expect(page).toContain("Backups: every day after 2 AM, the newest 14 kept. Disk: 80% free (400 GB of 500 GB).");
  });

  it("the last backup, the last check, and a reminder that unencrypted backups shouldn't leave the machine", async () => {
    const { t, sam } = await family();
    await runDailyBackup(dailyContext(t));
    recordCheck(t.deps.db, { kind: "verify", at: T0 - 12 * DAY, file: "belay-2026-11-04.db", ok: true, detail: null, parentId: null });
    let page = await home(t, sam.cookie);
    expect(page).toMatch(/Last backup: today, 10:00 AM \(\d+ KB\); last verified: 12 days ago\./);
    expect(page).toContain("Backups aren't encrypted. Before copying them off this machine, set a backup passphrase");

    t.advance(DAY);
    await runDailyBackup(dailyContext(t, { passphrase: () => PASSPHRASE }));
    page = await home(t, sam.cookie);
    expect(page).toMatch(/Last backup: today, 10:00 AM \(\d+ KB, encrypted\); last verified: 13 days ago\./);
    expect(page).not.toContain("Backups aren't encrypted");
  });

  it("problems in plain words, urgent ones marked", async () => {
    const { t, sam } = await family();
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => ({ freeBytes: 15e9, totalBytes: 500e9 }) });
    const res = await get(t, "/", sam.cookie);
    const html = await res.text();
    expect(html).toContain('<span class="status silent">Needs you now</span>');
    expect(html).toContain('<li class="tamper">The server&#39;s disk is almost full: 3% free (15 GB of 500 GB).');
  });

  it("a parent records a restore drill, and it's in the activity log", async () => {
    const { t, sam } = await family();
    const res = await postForm(t, "/server/drill", { _csrf: sam.csrf }, { cookie: sam.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/#server");
    expect(latestCheck(t.deps.db, "drill")).toMatchObject({ kind: "drill", at: T0, ok: true, parentId: sam.parent.id });
    const page = await home(t, sam.cookie);
    expect(page).toContain("Restore drill: the last one was just now.");
    expect(page).not.toContain("Time for a restore drill");
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "parent", action: "backup.drill", parentName: "Sam" });
    expect(words(await (await get(t, "/activity", sam.cookie)).text())).toContain("Sam on the web did a restore drill");
  });

  it("only a signed-in parent, with the form's token, can record one", async () => {
    const { t, sam } = await family();
    expect((await postForm(t, "/server/drill", {})).status).toBe(401);
    expect((await postForm(t, "/server/drill", { _csrf: "wrong" }, { cookie: sam.cookie })).status).toBe(403);
    expect((await postForm(t, "/server/drill", { _csrf: sam.csrf }, { cookie: sam.cookie, origin: "https://evil.example" })).status).toBe(403);
    expect(latestCheck(t.deps.db, "drill")).toBeNull();
  });

  it("says when this server is a restore drill's scratch copy", async () => {
    const { t, sam } = await family();
    t.deps.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run(DRILL_KEY, JSON.stringify({ at: T0, from: "belay-2026-11-16.db.enc" }));
    expect(await home(t, sam.cookie)).toContain(
      "This is a restore drill's scratch copy, restored today, 10:00 AM from belay-2026-11-16.db.enc. It sends no notifications.",
    );
  });
});

describe("the daily summary, in Settings", () => {
  it("off by default, at 7 PM; a parent turns it on for themselves, audited", async () => {
    const { t, sam } = await family();
    const alex = await signIn(t, "alex", "Alex");
    let html = await (await get(t, "/settings", sam.cookie)).text();
    expect(html).toContain('<input type="checkbox" name="on" value="1"/>');
    expect(html).toContain('<option value="19" selected="">7 PM</option>');
    expect(words(html)).toContain("It goes to the browsers where you turned notifications on, and you haven't on any yet.");

    const res = await postForm(t, "/settings/digest", { _csrf: sam.csrf, on: "1", hour: "20" }, { cookie: sam.cookie });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/settings?saved=digest#digest");
    expect(getDigest(t.deps.db)).toEqual({ hour: 20, parents: [sam.parent.id] });
    html = await (await get(t, "/settings?saved=digest", sam.cookie)).text();
    expect(html).toContain("Daily summary saved.");
    expect(html).toContain('<input type="checkbox" name="on" value="1" checked=""/>');
    expect(html).toContain('<option value="20" selected="">8 PM</option>');
    // Alex sees the family's hour, but hasn't turned it on.
    html = await (await get(t, "/settings", alex.cookie)).text();
    expect(html).toContain('<input type="checkbox" name="on" value="1"/>');
    expect(html).toContain('<option value="20" selected="">8 PM</option>');

    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ action: "settings.digest", detail: { on: true, hour: 20 } });
    expect(words(await (await get(t, "/activity", sam.cookie)).text())).toContain("Sam on the web turned their daily summary on, at 8 PM");
    await postForm(t, "/settings/digest", { _csrf: sam.csrf, hour: "20" }, { cookie: sam.cookie });
    expect(getDigest(t.deps.db).parents).toEqual([]);
    expect(words(await (await get(t, "/activity", sam.cookie)).text())).toContain("Sam on the web turned their daily summary off");
  });

  it("refuses an hour that isn't one", async () => {
    const { t, sam } = await family();
    for (const hour of ["24", "-1", "7.5", "seven", ""]) {
      const res = await postForm(t, "/settings/digest", { _csrf: sam.csrf, on: "1", hour }, { cookie: sam.cookie });
      expect(res.status).toBe(400);
      // The Settings page again, with the problem on it, as the other settings forms answer.
      const html = await res.text();
      expect(html).toContain("<h1");
      expect(html).toContain("Pick an hour from the list, then save again.");
    }
    expect(getDigest(t.deps.db)).toEqual({ hour: 19, parents: [] });
  });
});
