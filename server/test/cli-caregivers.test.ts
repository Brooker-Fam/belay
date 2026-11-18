/**
 * The CLI's Phase 12 commands, in the exact shapes CI's emulator test reads: caregiver-add (only
 * the one-time link on stdout), caregivers [--json], caregiver-renew and caregiver-end. They go
 * through the Caregivers page's functions, with its choices and limits, refuse in its words, and
 * are logged as the server's. The link is the page's: the caregiver joins with it and pauses the
 * phone from their own page, with their cookie, CSRF token and Origin, as CI's curl does. Made-up
 * names only.
 */
import { describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { getCaregiver, listCaregivers } from "../src/family/caregivers/store.js";
import { buildPolicy } from "../src/family/policy.js";
import { cleanUp } from "../src/maintenance.js";
import { updateSettings } from "../src/settings.js";
import { enrollPhone, get, ORIGIN, PASSWORD, postForm, signIn, testServer, T0, type TestServer } from "./helpers.js";

const MIN = 60_000;
const DAY = 86_400_000;
/** Thursday Nov 19 2026, 6:00 PM in New York: 3 days and 8 hours after T0. */
const THURSDAY_6PM = "2026-11-19T18:00";
const THURSDAY_6PM_MS = Date.UTC(2026, 10, 19, 23, 0, 0);
const LINK = /^https:\/\/belay\.example\.org\/care\/join\/([A-Za-z0-9_-]{43})$/;

async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const phone = await enrollPhone(t, "CI phone");
  const policy = (id = phone.deviceId) => Policy.parse(buildPolicy(t.deps.db, id, t.now()));
  return { t, phone, policy };
}

async function cli(t: TestServer, ...argv: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCommand(argv, {
    db: t.deps.db,
    config: t.deps.config,
    now: t.now(),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
    readSecret: () => Promise.resolve(""),
    interactive: false,
  });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const lastEntry = (t: TestServer) => listAudit(t.deps.db, { limit: 1, includeReads: false })[0];

/** The caregiver joins with the link, then reads their page: their cookie, its CSRF token, and the page. */
async function join(t: TestServer, link: string, username = "ci-grandma") {
  const path = new URL(link).pathname;
  const res = await postForm(t, path, { username, password: PASSWORD, repeat: PASSWORD });
  expect(res.status, await res.clone().text()).toBe(302);
  expect(res.headers.get("location")).toBe("/care");
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const page = await (await get(t, "/care", cookie)).text();
  return { cookie, csrf: /name="_csrf" value="([^"]+)"/.exec(page)?.[1] ?? "", page };
}

describe("caregiver-add", () => {
  it("prints only the one-time link; the phone's policy lists them; the server's in the activity log", async () => {
    const { t, policy } = await family();
    const before = policy().version;
    const added = await cli(t, "caregiver-add", "CI phone", "--name", "Grandma", "--until", THURSDAY_6PM);
    expect(added.code).toBe(0);
    expect(added.out).toMatch(LINK);
    expect(added.err).toBe(
      "Grandma has access to CI phone until 2026-11-19T18:00:00-05:00, to: status, pause, help. Their phones list them within seconds if they're online. " +
        "The link is shown only now: send it to Grandma in a message only they read. It works once, until 2026-11-19T18:00:00-05:00, " +
        "and whoever opens it first becomes Grandma here. Afterwards they sign in at https://belay.example.org/care.",
    );
    // The page's recommended choices, when --can is left out.
    expect(policy().caregivers).toEqual([{ name: "Grandma", until: THURSDAY_6PM_MS, can: ["status", "pause", "help"] }]);
    expect(policy().version).toBe(before + 1);
    expect(lastEntry(t)).toMatchObject({
      actor: "server",
      action: "caregiver.added",
      detail: { caregiver: "Grandma", phones: ["CI phone"], can: ["status", "pause", "help"], until: THURSDAY_6PM_MS, phones_changed: 1 },
    });
    expect(listCaregivers(t.deps.db)).toMatchObject([{ name: "Grandma", createdBy: null, joined: false, accessFrom: T0, endsAt: THURSDAY_6PM_MS }]);
    // The parents' Activity page says the server did it.
    const sam = await signIn(t);
    const activity = await (await get(t, "/activity", sam.cookie)).text();
    expect(activity).toContain("<strong>The server</strong> added Grandma as a caregiver for CI phone until Nov 19, 2026, 6:00 PM, with the phone&#39;s status, pause and lock, help requests");
  });

  it("takes several phones and --can; the link is the page's: the caregiver joins and pauses the phone, as a browser does", async () => {
    const { t, phone, policy } = await family();
    const spare = await enrollPhone(t, "Spare phone");
    const added = await cli(t, "caregiver-add", "ci PHONE", "Spare phone", "--name", "Coach Lee", "--can", "status, pause", "--until", "2026-11-17");
    expect(added.code, added.err).toBe(0);
    // A date alone is midnight in the family's timezone.
    const midnight = Date.UTC(2026, 10, 17, 5, 0, 0);
    expect(added.err).toContain("Coach Lee has access to CI phone, Spare phone until 2026-11-17T00:00:00-05:00, to: status, pause.");
    expect(policy().caregivers).toEqual([{ name: "Coach Lee", until: midnight, can: ["status", "pause"] }]);
    expect(policy(spare.deviceId).caregivers).toEqual(policy().caregivers);
    // The join page says what the link gives; joining signs them in.
    const link = LINK.exec(added.out)?.[0] ?? "";
    const page = await (await get(t, new URL(link).pathname)).text();
    expect(page).toContain("Hello, Coach Lee");
    expect(page).toContain("A parent gave you some access to CI phone, Spare phone");
    const care = await join(t, link, "ci-coach");
    expect(care.csrf).not.toBe("");
    // Their page has a pause form for each of their phones; the CI phone's posts to its id.
    expect(care.page).toContain(`action="/care/phones/${phone.deviceId}/pause"`);
    const path = `/care/phones/${phone.deviceId}/pause`;
    // From another site, or without the CSRF token, nothing.
    expect((await postForm(t, path, { _csrf: care.csrf, minutes: "15", lock: "0" }, { cookie: care.cookie, origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await postForm(t, path, { minutes: "15", lock: "0" }, { cookie: care.cookie })).status).toBe(403);
    expect(policy().pause).toBeNull();
    const paused = await postForm(t, path, { _csrf: care.csrf, minutes: "15", lock: "0" }, { cookie: care.cookie, origin: ORIGIN });
    expect(paused.status).toBe(302);
    expect(paused.headers.get("location")).toBe(`/care?saved=paused#phone-${phone.deviceId}`);
    expect(policy().pause).toEqual({ until: T0 + 15 * MIN, note: null, caregiver: "Coach Lee" });
    expect(policy(spare.deviceId).pause).toBeNull();
    expect(lastEntry(t)).toMatchObject({ actor: "caregiver", caregiverName: "Coach Lee", action: "phone.paused", deviceName: "CI phone" });
  });

  it("refuses bad input in the Caregivers page's words, and adds nothing", async () => {
    const { t } = await family();
    expect((await cli(t, "caregiver-add", "CI phone", "--name", "Grandma", "--until", THURSDAY_6PM)).code).toBe(0);
    const until = ["--until", THURSDAY_6PM];
    const tries: [string[], string][] = [
      [["CI phone", "--name", "G".repeat(41), ...until], "Name them in 1 to 40 characters, like Grandma. Your kid sees this name."],
      [["CI phone", ...until], "Name them in 1 to 40 characters, like Grandma. Your kid sees this name."],
      [["CI phone", "--name", "GRANDMA", ...until], "Another caregiver has that name already. Give each one a name your kid can tell apart."],
      [["CI phone", "--name", "Coach Lee", "--can", "", ...until], "Choose at least one thing they may do."],
      [["CI phone", "--name", "Coach Lee", "--until", "2026-12-17T11:00"], "Access lasts at most 30 days. Choose an earlier end: you can renew it before then."],
      [["CI phone", "--name", "Coach Lee", "--until", "2026-11-16T09:00"], "Choose an end later than now."],
      [
        ["CI phone", "--name", "Coach Lee", "--until", "soon"],
        "Choose when their access ends: a date and a time. --until is a date and time in the family's timezone (America/New_York), like 2026-11-19T10:00, or one with its offset, like 2026-11-19T15:00Z.",
      ],
      [["CI phone", "--name", "Coach Lee"], "Choose when their access ends: a date and a time."],
      // What only the command line can get wrong: no phone, another phone, a choice the page doesn't have.
      [["--name", "Coach Lee", ...until], 'Name the phones first, in quotes, like "Sam\'s phone", then who and until when.'],
      [["Sam's phone", "--name", "Coach Lee", ...until], 'No phone is called "Sam\'s phone". The phones are: "CI phone".'],
      [["CI phone", "--name", "Coach Lee", "--can", "status,resume", ...until], "--can is any of status, pause, help, locate, comma separated: status,pause,help if left out."],
      [["CI phone", "--name", "Coach Lee", "--can", ...until], "Usage: caregiver-add"],
      [["CI phone", "--name", "Coach Lee", "--lock", ...until], "Usage: caregiver-add"],
    ];
    for (const [args, words] of tries) {
      const refused = await cli(t, "caregiver-add", ...args);
      expect(refused.code, args.join(" ")).toBe(1);
      expect(refused.out, args.join(" ")).toBe("");
      expect(refused.err, args.join(" ")).toContain(words);
    }
    // A flag it doesn't take is only that: the usage, not a word about phones.
    expect((await cli(t, "caregiver-add", "CI phone", "--name", "Coach Lee", "--lock", ...until)).err).toBe(
      'Usage: caregiver-add "<phone>" ["<phone>" ...] --name <words> --until <time> [--can status,pause,help,locate]',
    );
    expect(listCaregivers(t.deps.db).map((c) => c.name)).toEqual(["Grandma"]);
    // Exactly 30 days is fine, as on the page.
    expect((await cli(t, "caregiver-add", "CI phone", "--name", "Coach Lee", "--can", "status", "--until", "2026-12-16T10:00")).code).toBe(0);
  });
});

describe("caregivers", () => {
  it("lists each one with their state, in words and as JSON", async () => {
    const { t } = await family();
    expect(await cli(t, "caregivers")).toEqual({ code: 0, out: "No caregivers yet.", err: "" });
    expect(JSON.parse((await cli(t, "caregivers", "--json")).out)).toEqual({ caregivers: [] });
    const link = (await cli(t, "caregiver-add", "CI phone", "--name", "Coach Lee", "--can", "status", "--until", "2026-11-17T18:00")).out;
    await cli(t, "caregiver-add", "CI phone", "--name", "Grandma", "--until", THURSDAY_6PM);
    await join(t, link, "ci-coach");
    t.advance(2 * 60 * MIN);
    expect((await cli(t, "caregiver-end", "Coach Lee")).code).toBe(0);
    expect((await cli(t, "caregivers")).out).toBe(
      [
        "Grandma: until 2026-11-19T18:00:00-05:00, for CI phone: status, pause, help. Hasn't used their link yet.",
        "Coach Lee: ended 2026-11-16T12:00:00-05:00, for CI phone: status. Joined; last signed in 2 hours ago.",
      ].join("\n"),
    );
    expect(JSON.parse((await cli(t, "caregivers", "--json")).out)).toEqual({
      caregivers: [
        {
          name: "Grandma",
          access: "current",
          until: "2026-11-19T18:00:00-05:00",
          ended_at: null,
          phones: ["CI phone"],
          can: ["status", "pause", "help"],
          joined: false,
          joined_at: null,
          last_signed_in_at: null,
        },
        {
          name: "Coach Lee",
          access: "ended",
          until: "2026-11-17T18:00:00-05:00",
          ended_at: "2026-11-16T12:00:00-05:00",
          phones: ["CI phone"],
          can: ["status"],
          joined: true,
          joined_at: "2026-11-16T10:00:00-05:00",
          last_signed_in_at: "2026-11-16T10:00:00-05:00",
        },
      ],
    });
    // Access that ends at its time reads as ended at once, before the hourly clean-up marks it.
    t.advance(3 * DAY + 8 * 60 * MIN);
    expect((await cli(t, "caregivers")).out.split("\n")[0]).toBe("Grandma: ended 2026-11-19T18:00:00-05:00, for CI phone: status, pause, help. Hasn't used their link yet.");
    expect((await cli(t, "caregivers", "extra")).code).toBe(1);
  });
});

describe("caregiver-renew", () => {
  it("gives a new end at most 30 days away; for one whose access ended, access again from now", async () => {
    const { t, policy } = await family();
    const link = (await cli(t, "caregiver-add", "CI phone", "--name", "Grandma", "--until", THURSDAY_6PM)).out;
    await join(t, link);
    const renewed = await cli(t, "caregiver-renew", "grandma", "--until", "2026-11-21T18:00");
    expect(renewed).toEqual({ code: 0, out: "Grandma's access is renewed, until 2026-11-21T18:00:00-05:00. Their phones show the new end within seconds if they're online.", err: "" });
    expect(policy().caregivers[0]?.until).toBe(Date.UTC(2026, 10, 21, 23, 0, 0));
    expect(lastEntry(t)).toMatchObject({ actor: "server", action: "caregiver.renewed", detail: { caregiver: "Grandma", until: Date.UTC(2026, 10, 21, 23, 0, 0) } });
    const tooFar = await cli(t, "caregiver-renew", "Grandma", "--until", "2026-12-17T11:00");
    expect(tooFar).toMatchObject({ code: 1, out: "", err: "Access lasts at most 30 days. Choose an earlier end: you can renew it before then." });
    expect((await cli(t, "caregiver-renew", "Grandma")).err).toContain("Choose when their access ends: a date and a time.");
    expect((await cli(t, "caregiver-renew", "Grandma", "--until", "2026-11-21T18:00", "--can", "help")).err).toBe('Usage: caregiver-renew "<name>" --until <time>');
    // Ended: access again, from now; she signs in with the password she chose.
    await cli(t, "caregiver-end", "Grandma");
    t.advance(DAY);
    const again = await cli(t, "caregiver-renew", "Grandma", "--until", "2026-11-21T18:00");
    expect(again.out).toBe(
      "Grandma has access again, until 2026-11-21T18:00:00-05:00, from now: the help requests from before don't show to them. Their phones list them within seconds if they're online. They sign in with the password they chose.",
    );
    expect(listCaregivers(t.deps.db)[0]).toMatchObject({ accessFrom: T0 + DAY, endedAt: null });
    expect(lastEntry(t)).toMatchObject({ actor: "server", action: "caregiver.renewed", detail: { again: true } });
    expect(policy().caregivers.map((c) => c.name)).toEqual(["Grandma"]);
    // One who never joined lost their link when access ended: the Caregivers page makes a new one.
    await cli(t, "caregiver-add", "CI phone", "--name", "Coach Lee", "--until", "2026-11-18T18:00");
    await cli(t, "caregiver-end", "Coach Lee");
    expect((await cli(t, "caregiver-renew", "Coach Lee", "--until", "2026-11-19T18:00")).out).toContain(
      "They never joined, and their link went when their access ended: make them a new one on the Caregivers page.",
    );
  });
});

describe("caregiver-end", () => {
  it("ends access now, as the page's End access now: signed out, off the phone's policy; a pause they set stays", async () => {
    const { t, phone, policy } = await family();
    expect(await cli(t, "caregiver-end", "Grandma")).toMatchObject({ code: 1, err: "There are no caregivers yet." });
    const link = (await cli(t, "caregiver-add", "CI phone", "--name", "Grandma", "--until", THURSDAY_6PM)).out;
    const care = await join(t, link);
    const path = `/care/phones/${phone.deviceId}/pause`;
    expect((await postForm(t, path, { _csrf: care.csrf, minutes: "30", lock: "0" }, { cookie: care.cookie })).status).toBe(302);
    t.advance(MIN);
    expect(await cli(t, "caregiver-end", "Nobody")).toMatchObject({ code: 1, err: 'No caregiver is called "Nobody". The caregivers are: "Grandma".' });
    expect((await cli(t, "caregiver-end")).err).toContain('Name the caregiver first, in quotes, like "Grandma".');
    const ended = await cli(t, "caregiver-end", "Grandma");
    expect(ended).toEqual({
      code: 0,
      out: "Grandma's access ended: they're signed out, their notifications stopped, and their phones stop listing them within seconds if they're online. A pause they set stays until its end; resume \"<phone>\" ends it early.",
      err: "",
    });
    expect(policy().caregivers).toEqual([]);
    expect(policy().pause).toEqual({ until: T0 + 30 * MIN, note: null, caregiver: "Grandma" });
    expect((await get(t, "/care", care.cookie)).headers.get("location")).toBe("/care/login?next=%2Fcare");
    expect(getCaregiver(t.deps.db, listCaregivers(t.deps.db)[0]?.id ?? "")).toMatchObject({ endedAt: T0 + MIN, endedBy: null });
    expect(lastEntry(t)).toMatchObject({ actor: "server", action: "caregiver.ended", detail: { caregiver: "Grandma" } });
    expect(await cli(t, "caregiver-end", "Grandma")).toEqual({ code: 0, out: "Grandma's access had ended already, at 2026-11-16T10:01:00-05:00.", err: "" });
    // Access that ends at its time is the hourly clean-up's: logged as its own, at that time.
    await cli(t, "caregiver-add", "CI phone", "--name", "Coach Lee", "--until", "2026-11-16T12:00");
    t.advance(3 * 60 * MIN);
    expect((await cli(t, "caregiver-end", "Coach Lee")).out).toBe("Coach Lee's access had ended already, at 2026-11-16T12:00:00-05:00.");
    cleanUp(t.deps.db, t.now());
    expect(lastEntry(t)).toMatchObject({ actor: "server", action: "caregiver.access_ended", detail: { caregiver: "Coach Lee" } });
    expect(listCaregivers(t.deps.db).find((c) => c.name === "Coach Lee")?.endedAt).toBe(Date.UTC(2026, 10, 16, 17, 0, 0));
  });
});
