/**
 * Admin commands, run where the server runs (same BELAY_DATA_DIR and BELAY_PUBLIC_URL):
 *
 *   node dist/cli.js setup-link                  a one-time link to create the first parent
 *   node dist/cli.js create-code <phone name>    an enrollment code for a phone
 *   node dist/cli.js reset-password <username>   a new password, read from the terminal
 *   node dist/cli.js backup <file>               a consistent copy of the database, while it runs
 *   node dist/cli.js status [--json]             each phone's status, apps and latest changes
 */
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { endAllSessions, newSetupToken, parentCount, passwordProblem, setPassword } from "./auth/parents.js";
import { audit } from "./audit.js";
import { ConfigError, loadConfig } from "./config.js";
import { openDatabase } from "./db.js";
import { createEnrollmentCode } from "./device/enroll.js";
import { appCounts, listChanges } from "./family/apps.js";
import { listDevices, nameTaken } from "./family/devices.js";
import { getSettings } from "./settings.js";
import { formatAgo, isoInZone } from "./time.js";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Reads one line; with a terminal, without echoing it. */
function readSecret(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
    if (process.stdin.isTTY) {
      process.stdout.write(prompt);
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = () => undefined;
    }
    rl.once("line", (line) => {
      rl.close();
      if (process.stdin.isTTY) process.stdout.write("\n");
      resolve(line);
    });
  });
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) fail(error.message);
    throw error;
  }
  const db = openDatabase(config.dataDir);
  const now = Date.now();
  try {
    switch (command) {
      case "setup-link": {
        if (parentCount(db) > 0) fail("Belay is already set up. To add a parent, use Invite another parent in Settings.");
        console.log(`${config.publicUrl}/setup?token=${newSetupToken(db, now)}`);
        console.log("It works once, for 24 hours.");
        break;
      }
      case "create-code": {
        const name = args.join(" ").trim();
        if (!name || name.length > 60) fail("Usage: create-code <phone name, 1 to 60 characters>");
        if (nameTaken(db, name)) fail(`A phone is already called "${name}". Use Reconnect on its page instead.`);
        const made = createEnrollmentCode(db, now, { deviceName: name, createdBy: null });
        audit(db, now, { kind: "server" }, "code.created", { detail: { name } });
        console.log(made.code);
        console.error(`Works once, for 30 minutes. On the computer the phone is plugged into:\n  scripts/provision.sh --server ${config.publicUrl} --code ${made.code}`);
        break;
      }
      case "reset-password": {
        const username = args[0];
        if (!username) fail("Usage: reset-password <username>");
        const row = db.prepare<[string], { id: string }>("SELECT id FROM parents WHERE username = ?").get(username);
        if (!row) fail(`No parent is called ${username}.`);
        const password = await readSecret("New password: ");
        const repeat = process.stdin.isTTY ? await readSecret("The same password again: ") : password;
        const problem = passwordProblem(password, repeat);
        if (problem) fail(problem);
        await setPassword(db, row.id, password);
        endAllSessions(db, row.id);
        audit(db, now, { kind: "server" }, "parent.password_reset", { detail: { username } });
        console.log("Password changed. That parent was signed out everywhere.");
        break;
      }
      case "backup": {
        const file = args[0];
        if (!file) fail("Usage: backup <file>, for example backup /data/belay-backup.db");
        if (existsSync(file)) fail(`${file} already exists. Pick a new name.`);
        await db.backup(file);
        console.log(`Backed up to ${file}. It holds the family's data: keep it as private as the server.`);
        break;
      }
      case "status": {
        const settings = getSettings(db);
        const iso = (ms: number | null) => (ms === null ? null : isoInZone(ms, settings.timezone));
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
            recent_changes: listChanges(db, { deviceId: d.id, includeSystem: true, limit: 20 }).map((c) => ({
              kind: c.kind,
              package: c.package,
              at: iso(c.at),
              found_by: c.backfilled ? "server snapshot" : c.detection,
            })),
          };
        });
        if (args.includes("--json")) {
          console.log(JSON.stringify({ phones }, null, 2));
          break;
        }
        if (!phones.length) console.log("No phones yet.");
        for (const p of phones) {
          console.log(`${p.name}: ${p.status}${p.problems.length ? ` (${p.problems.join("; ")})` : ""}`);
          console.log(`  last heard from ${p.heard_ago}; ${p.user_apps} apps, ${p.apps_to_review} to review`);
          for (const c of p.recent_changes.slice(0, 5)) console.log(`  ${c.at ?? ""} ${c.kind} ${c.package}`);
        }
        break;
      }
      default:
        fail("Commands: setup-link, create-code <phone name>, reset-password <username>, backup <file>, status [--json]");
    }
  } finally {
    db.close();
  }
}

await main();
