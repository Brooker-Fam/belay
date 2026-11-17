/**
 * The admin commands behind cli.ts, run where the server runs (same BELAY_DATA_DIR):
 *
 *   setup-link                                    a one-time link to create the first parent
 *   create-code <phone name>                      an enrollment code for a phone
 *   reset-password <username>                     a new password, read from the terminal
 *   backup <file>                                 a consistent copy of the database, while it runs
 *   status [--json]                               each phone's status, apps, rules, requests and latest changes
 *   protect "<phone>"                             turns protection on, as the parent page does
 *   policy "<phone>" --new-apps ask|allow         whether new apps wait for a parent
 *   decide "<phone>" <package> allow|block|undecided
 *   pause "<phone>" [--minutes N] [--note text]   until a parent resumes it, without --minutes
 *   resume "<phone>"
 *
 * Changes are logged as the server's (the activity log's "The server"). A running server sees
 * them within a second or two and passes them to the phone's long-poll. Hardening (factory
 * reset, debugging, reset protection) is only on the parent page.
 */
import { existsSync } from "node:fs";
import { endAllSessions, newSetupToken, parentCount, passwordProblem, setPassword } from "./auth/parents.js";
import { audit } from "./audit.js";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
import { createEnrollmentCode } from "./device/enroll.js";
import { packageName } from "./device/schemas.js";
import { appCounts, listChanges } from "./family/apps.js";
import { type DeviceRow, findDeviceByName, listDevices, nameTaken } from "./family/devices.js";
import { LIMITS, decideApp, neverBlocked, pausePhone, protect, resumePhone, setNewApps, type PolicyContext } from "./family/policy.js";
import { recentRequests } from "./family/requests.js";
import { getSettings } from "./settings.js";
import { formatAgo, isoInZone } from "./time.js";

export interface CliIO {
  db: DB;
  config: Config;
  now: number;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Reads one line without echoing it, when there's a terminal. */
  readSecret: (prompt: string) => Promise<string>;
  /** Whether stdin is a terminal (reset-password asks twice there). */
  interactive: boolean;
}

class CliError extends Error {}

const USAGE = `Commands:
  setup-link
  create-code <phone name>
  reset-password <username>
  backup <file>
  status [--json]
  protect "<phone>"
  policy "<phone>" --new-apps ask|allow
  decide "<phone>" <package> allow|block|undecided
  pause "<phone>" [--minutes N] [--note text]
  resume "<phone>"`;

/** Positional arguments, and --name value (or --name=value, or a bare --name) flags. */
function parseArgs(args: string[]): { positional: string[]; flags: Map<string, string | true> } {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [name = "", inline] = arg.slice(2).split(/=(.*)/s, 2);
    const next = args[i + 1];
    if (inline !== undefined) flags.set(name, inline);
    else if (next !== undefined && !next.startsWith("--")) {
      flags.set(name, next);
      i++;
    } else flags.set(name, true);
  }
  return { positional, flags };
}

export async function runCommand(argv: string[], io: CliIO): Promise<number> {
  try {
    await run(argv, io);
    return 0;
  } catch (error) {
    if (error instanceof CliError) {
      io.err(error.message);
      return 1;
    }
    throw error;
  }
}

async function run(argv: string[], io: CliIO): Promise<void> {
  const { db, config, now } = io;
  const [command, ...args] = argv;
  const { positional, flags } = parseArgs(args);
  const server = { kind: "server" } as const;
  const ctx: PolicyContext = { db, now };
  const iso = (ms: number | null) => (ms === null ? null : isoInZone(ms, getSettings(db).timezone));

  const phone = (): DeviceRow => {
    const name = positional[0]?.trim();
    if (!name) throw new CliError(`Name the phone first, in quotes, like "Sam's phone".\n\n${USAGE}`);
    const row = findDeviceByName(db, name);
    if (row) return row;
    const names = listDevices(db, getSettings(db), now).map((d) => `"${d.name}"`);
    throw new CliError(names.length ? `No phone is called "${name}". The phones are: ${names.join(", ")}.` : "No phones are enrolled yet.");
  };

  switch (command) {
    case "setup-link": {
      if (parentCount(db) > 0) throw new CliError("Belay is already set up. To add a parent, use Invite another parent in Settings.");
      io.out(`${config.publicUrl}/setup?token=${newSetupToken(db, now)}`);
      io.out("It works once, for 24 hours.");
      return;
    }
    case "create-code": {
      const name = args.join(" ").trim();
      if (!name || name.length > 60) throw new CliError("Usage: create-code <phone name, 1 to 60 characters>");
      if (nameTaken(db, name)) throw new CliError(`A phone is already called "${name}". Use Reconnect on its page instead.`);
      const made = createEnrollmentCode(db, now, { deviceName: name, createdBy: null });
      audit(db, now, server, "code.created", { detail: { name } });
      io.out(made.code);
      io.err(`Works once, for 30 minutes. On the computer the phone is plugged into:\n  scripts/provision.sh --server ${config.publicUrl} --code ${made.code}`);
      return;
    }
    case "reset-password": {
      const username = args[0];
      if (!username) throw new CliError("Usage: reset-password <username>");
      const row = db.prepare<[string], { id: string }>("SELECT id FROM parents WHERE username = ?").get(username);
      if (!row) throw new CliError(`No parent is called ${username}.`);
      const password = await io.readSecret("New password: ");
      const repeat = io.interactive ? await io.readSecret("The same password again: ") : password;
      const problem = passwordProblem(password, repeat);
      if (problem) throw new CliError(problem);
      await setPassword(db, row.id, password);
      endAllSessions(db, row.id);
      audit(db, now, server, "parent.password_reset", { detail: { username } });
      io.out("Password changed. That parent was signed out everywhere.");
      return;
    }
    case "backup": {
      const file = args[0];
      if (!file) throw new CliError("Usage: backup <file>, for example backup /data/belay-backup.db");
      if (existsSync(file)) throw new CliError(`${file} already exists. Pick a new name.`);
      await db.backup(file);
      io.out(`Backed up to ${file}. It holds the family's data: keep it as private as the server.`);
      return;
    }
    case "status": {
      const settings = getSettings(db);
      const phones = listDevices(db, settings, now).map((d) => {
        const counts = appCounts(db, d.id);
        return {
          name: d.name,
          status: d.status,
          problems: d.problems.map((p) => p.text),
          last_heard_from: iso(d.lastSeenAt),
          heard_ago: d.lastSeenAt === null ? "never" : formatAgo(d.lastSeenAt, now),
          last_app_list: iso(d.lastInventoryAt),
          user_apps: counts.userApps,
          apps_to_review: counts.unreviewed,
          /** The server's version of the phone's rules (0: none). */
          policy_version: d.policyVersion,
          /** What the phone last said it enforces (docs/protocol.md, "Enforcement"), or null. */
          enforcement: d.enforcement,
          /** The kid's requests: waiting ones, and the last 30 days'. */
          requests: recentRequests(db, now, { deviceId: d.id }).map((r) => ({ package: r.package, status: r.status, reason: r.reason })),
          recent_changes: listChanges(db, { deviceId: d.id, includeSystem: true, limit: 20 }).map((c) => ({
            kind: c.kind,
            package: c.package,
            at: iso(c.at),
            found_by: c.backfilled ? "server snapshot" : c.detection,
          })),
        };
      });
      if (flags.has("json")) {
        io.out(JSON.stringify({ phones }, null, 2));
        return;
      }
      if (!phones.length) io.out("No phones yet.");
      for (const p of phones) {
        const waiting = p.requests.filter((r) => r.status === "pending").length;
        io.out(`${p.name}: ${p.status}${p.problems.length ? ` (${p.problems.join("; ")})` : ""}`);
        io.out(`  last heard from ${p.heard_ago}; ${p.user_apps} apps, ${p.apps_to_review} to review; ${waiting} request${waiting === 1 ? "" : "s"} waiting`);
        io.out(`  rules version ${p.policy_version}; the phone applied ${p.enforcement ? `version ${p.enforcement.policy_version}` : "none yet"}`);
        for (const c of p.recent_changes.slice(0, 5)) io.out(`  ${c.at ?? ""} ${c.kind} ${c.package}`);
      }
      return;
    }
    case "protect": {
      const row = phone();
      const done = protect(ctx, row.id, server);
      io.out(
        done.result.alreadyOn && !done.changed
          ? `${row.name}: protection was already on (rules version ${done.version}).`
          : `${row.name}: protection is on (rules version ${done.version}). ${done.result.grandfathered} app${done.result.grandfathered === 1 ? "" : "s"} already on the phone ${done.result.grandfathered === 1 ? "is" : "are"} allowed.`,
      );
      return;
    }
    case "policy": {
      const row = phone();
      const mode = flags.get("new-apps");
      if (mode !== "ask" && mode !== "allow") throw new CliError(`Usage: policy "<phone>" --new-apps ask|allow`);
      const done = setNewApps(ctx, row.id, mode, server);
      io.out(
        `${row.name}: new apps ${mode === "ask" ? "wait for a parent's approval" : "run without asking"} (rules version ${done.version}).` +
          (done.result.grandfathered ? ` ${done.result.grandfathered} app${done.result.grandfathered === 1 ? "" : "s"} already on the phone allowed.` : ""),
      );
      return;
    }
    case "decide": {
      const row = phone();
      const [, pkg = "", state = ""] = positional;
      if (!packageName.safeParse(pkg).success || (state !== "allow" && state !== "block" && state !== "undecided")) {
        throw new CliError(`Usage: decide "<phone>" <package> allow|block|undecided`);
      }
      if (state === "block" && neverBlocked(pkg)) throw new CliError(`Belay never blocks ${pkg}: 911 and 988 must always work.`);
      const done = decideApp(ctx, row.id, pkg, state === "allow" ? "allowed" : state === "block" ? "blocked" : "undecided", server);
      const words = state === "allow" ? "allowed" : state === "block" ? "blocked" : "without a decision";
      io.out(`${row.name}: ${pkg} is ${words} (rules version ${done.version}).`);
      return;
    }
    case "pause": {
      const row = phone();
      const minutesFlag = flags.get("minutes");
      const minutes = minutesFlag === undefined ? null : Number(minutesFlag);
      if (minutes !== null && (!Number.isInteger(minutes) || minutes < 1 || minutes > LIMITS.maxPauseMinutes)) {
        throw new CliError(`Usage: pause "<phone>" [--minutes N], N from 1 to ${LIMITS.maxPauseMinutes}`);
      }
      const note = flags.get("note");
      const done = pausePhone(ctx, row.id, { minutes, note: typeof note === "string" ? note : null }, server);
      io.out(`${row.name}: paused ${done.result.until === null ? "until a parent resumes it" : `until ${iso(done.result.until) ?? ""}`} (rules version ${done.version}).`);
      return;
    }
    case "resume": {
      const row = phone();
      const done = resumePhone(ctx, row.id, server);
      io.out(done.result.wasPaused ? `${row.name}: resumed (rules version ${done.version}).` : `${row.name} wasn't paused.`);
      return;
    }
    default:
      throw new CliError(USAGE);
  }
}
