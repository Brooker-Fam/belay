/**
 * npm run demo [-- [--port <n>] [--dir <path>]]: a Belay server on this computer with a made-up
 * family and a simulated phone, to click through every parent page and connect Claude Code to,
 * with no Android phone (docs/demo.md). It listens on localhost only, keeps everything in a
 * directory of its own (a new temporary one, deleted when it stops, unless --dir names one to
 * keep), and reads no .env and no BELAY_* settings: it sets its own.
 *
 * Never part of the server's build or image: tsconfig.build.json compiles only src/, and the
 * Dockerfile copies only src/ (.dockerignore leaves demo/ out too).
 */
import { type ServerType, serve } from "@hono/node-server";
import { randomInt } from "node:crypto";
import { rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createApp } from "../src/app.js";
import { audit } from "../src/audit.js";
import { endAllSessions, listParents, setPassword } from "../src/auth/parents.js";
import { type Config, loadConfig } from "../src/config.js";
import { type DB, openDatabase } from "../src/db.js";
import { type Deps, makeDeps } from "../src/deps.js";
import { cleanAgentTemp } from "../src/family/agent.js";
import { cleanUp } from "../src/maintenance.js";
import { createPersonalToken, grantForAccessToken, revokeGrant } from "../src/oauth/store.js";
import { opsTick, startOps } from "../src/ops/jobs.js";
import { getSettings } from "../src/settings.js";
import { isValidTimeZone, zoned } from "../src/time.js";
import { DB_FILE, type DemoDir, NotADemoDir, PHONE_FILE, STATE_FILE, markDatabase, openDemoDir, readJson, writeJson } from "./dir.js";
import { FALLBACK_ZONE, KID, PARENT, PHONE_NAME } from "./family.js";
import { type PhoneState, SimPhone } from "./phone.js";
import { seedDemo } from "./seed.js";

const USAGE = `npm run demo [-- [--port <port>] [--dir <directory>]]

A Belay server on this computer with a made-up family and a simulated phone (docs/demo.md).
  --port <port>  where it listens on localhost (8080)
  --dir <dir>    keep the demo in this directory between runs: a new or empty one, or one the
                 demo made before (by default, a new temporary directory, deleted when it stops)`;

/** The demo's own record in its directory: the token it made for Claude Code, kept between runs. */
interface DemoState {
  seeded: true;
  token: string;
  grantId: string;
}

function parseArgs(argv: string[]): { port: number; dir: string | null } | { help: true } | { error: string } {
  let port = 8080;
  let dir: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "-h" || arg === "--help") return { help: true };
    // npm passes a second "--" on (npm run demo -- --port 8081 -- --dir x): it's no option.
    if (arg === "--") continue;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    if (name !== "--port" && name !== "--dir") return { error: `Unknown option: ${arg}` };
    const value = inline ?? argv[++i];
    if (!value) return { error: `${name} needs a value` };
    if (name === "--port") {
      port = Number(value);
      if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `--port isn't a port: ${value}` };
    } else {
      // npm runs scripts in server/: a relative --dir is from where npm was run.
      dir = resolve(process.env.INIT_CWD ?? process.cwd(), value);
    }
  }
  return { port, dir };
}

/** A new password: 20 letters and digits that are easy to read, in groups. */
function newPassword(): string {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  const chars = Array.from({ length: 20 }, () => alphabet[randomInt(alphabet.length)] ?? "a");
  return [0, 5, 10, 15].map((i) => chars.slice(i, i + 5).join("")).join("-");
}

/** The computer's own timezone, for the made-up family, so its school day and bedtime are local. */
function localZone(): string {
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return isValidTimeZone(zone) ? zone : FALLBACK_ZONE;
}

/**
 * The server, listening before the family is made, so a port in use is found at once. Until
 * `ready()`, every request is told the demo is starting: no one sees half a week.
 */
function listen(deps: Deps, config: Config, ready: () => boolean): Promise<ServerType> {
  const app = createApp(deps);
  const starting = () => new Response("The Belay demo is starting: try again in a few seconds.\n", { status: 503, headers: { "content-type": "text/plain; charset=utf-8", "retry-after": "3" } });
  return new Promise((done, fail) => {
    const server = serve({ fetch: (request, env) => (ready() ? app.fetch(request, env) : starting()), hostname: config.host, port: config.port }, () => {
      done(server);
    });
    server.once("error", fail);
  });
}

const TOKEN_NAME = "Claude Code (demo)";

/**
 * A personal access token for Claude Code, in the parent's name, as Settings → AI access makes one:
 * the one made before, if it still works here (the same port), or a new one. The demo makes it, so
 * the activity log says the server did.
 */
function demoToken(db: DB, dir: DemoDir, parentId: string, mcpUrl: string, now: number): DemoState {
  const saved = readJson(dir.path, STATE_FILE) as Partial<DemoState> | null;
  if (typeof saved?.token === "string" && typeof saved.grantId === "string") {
    const grant = grantForAccessToken(db, saved.token, now);
    if (grant && grant.resource === mcpUrl) return { seeded: true, token: saved.token, grantId: saved.grantId };
    if (revokeGrant(db, saved.grantId, now)) audit(db, now, { kind: "server" }, "token.revoked", { detail: { name: TOKEN_NAME } });
  }
  const made = createPersonalToken(db, now, parentId, TOKEN_NAME, mcpUrl);
  audit(db, now, { kind: "server" }, "token.created", { detail: { name: TOKEN_NAME } });
  return { seeded: true, token: made.token, grantId: made.grantId };
}

/** The phone's file, if it's whole: what a run that stopped early, or an older demo, may not have left. */
function phoneStateOf(value: unknown): PhoneState | null {
  const s = value as Partial<PhoneState> | null;
  const whole =
    typeof s?.token === "string" &&
    typeof s.deviceId === "string" &&
    Array.isArray(s.apps) &&
    Array.isArray(s.results) &&
    typeof s.asked === "object" &&
    typeof s.usage === "object" &&
    Array.isArray(s.outbox?.events) &&
    Array.isArray(s.outbox.requests) &&
    Array.isArray(s.outbox.usage) &&
    Array.isArray(s.outbox.calls);
  return whole ? (s as PhoneState) : null;
}

const clockOf = (zone: string) => () => {
  const p = zoned(Date.now(), zone);
  return [p.hour, p.minute, p.second].map((n) => String(n).padStart(2, "0")).join(":");
};

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if ("help" in args) {
    console.log(USAGE);
    return 0;
  }
  if ("error" in args) {
    console.error(`${args.error}\n\n${USAGE}`);
    return 2;
  }
  // The demo makes its own settings: a real server's (in the shell, or a .env it never reads) don't apply.
  const ignored = Object.keys(process.env)
    .filter((k) => k.startsWith("BELAY_"))
    .sort();

  let dir: DemoDir;
  try {
    dir = openDemoDir(args.dir);
  } catch (error) {
    if (error instanceof NotADemoDir) {
      console.error(`Not starting: ${error.message}`);
      return 1;
    }
    throw error;
  }

  // From here on, a stop (Ctrl-C, or a failure) stops the phone and the server, and deletes a temporary directory.
  let phone: SimPhone | null = null;
  let deps: Deps | null = null;
  let server: ServerType | null = null;
  let db: DB | null = null;
  let stopOps: (() => void) | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let ready = false;
  let stopping = false;
  const removeTemp = () => {
    if (dir.temp) rmSync(dir.path, { recursive: true, force: true });
  };
  const stop = async (code: number): Promise<never> => {
    if (stopping) {
      removeTemp();
      process.exit(code);
    }
    stopping = true;
    if (server) console.log("\nStopping the simulated phone and the server…");
    const late = setTimeout(() => {
      removeTemp();
      process.exit(code);
    }, 5000);
    await phone?.stop();
    stopOps?.();
    if (timer) clearInterval(timer);
    deps?.waiters.close();
    deps?.fixWaiters.close();
    if (server) {
      const closing = server;
      await new Promise<void>((done) => {
        closing.close(() => {
          done();
        });
        if ("closeAllConnections" in closing) closing.closeAllConnections();
      });
    }
    try {
      db?.close();
    } catch {
      // Already closed, or busy with a backup: it's going anyway.
    }
    clearTimeout(late);
    if (dir.temp) {
      removeTemp();
      console.log(`Deleted ${dir.path}.`);
    } else console.log(`Kept ${dir.path}: npm run demo -- --dir ${dir.path} comes back to it.`);
    process.exit(code);
  };
  process.on("SIGINT", () => void stop(0));
  process.on("SIGTERM", () => void stop(0));

  try {
    const port = args.port;
    const publicUrl = `http://localhost:${String(port)}`;
    const config = loadConfig({
      BELAY_PUBLIC_URL: publicUrl,
      BELAY_DATA_DIR: dir.path,
      BELAY_HOST: "127.0.0.1",
      BELAY_PORT: String(port),
      BELAY_DEMO_BANNER: "1",
    });
    const state = dir.fresh ? null : (readJson(dir.path, STATE_FILE) as Partial<DemoState> | null);
    let phoneState = dir.fresh ? null : phoneStateOf(readJson(dir.path, PHONE_FILE));
    if (!dir.fresh && (state?.seeded !== true || !phoneState)) {
      // A run that stopped before its family was made (or the phone's file is gone): the demo's own database, made again.
      for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`, PHONE_FILE, STATE_FILE]) rmSync(join(dir.path, name), { force: true });
      dir = { ...dir, fresh: true };
      phoneState = null;
    }
    db = openDatabase(dir.path);
    if (dir.fresh) markDatabase(db, dir.id, Date.now());
    deps = makeDeps(config, db);
    try {
      server = await listen(deps, config, () => ready);
    } catch (error) {
      const busy = error instanceof Error && "code" in error && error.code === "EADDRINUSE";
      console.error(busy ? `Port ${String(port)} is in use on this computer. Try another: npm run demo -- --port ${String(port + 1)}` : `Couldn't start the server: ${String(error)}`);
      return await stop(1);
    }

    const zone = dir.fresh ? localZone() : getSettings(db).timezone;
    const password = newPassword();
    let parentId: string;
    if (dir.fresh) {
      console.log(`Making a made-up family and a week of its phone's life…`);
      const seeded = await seedDemo({ db, config, now: Date.now(), zone, password });
      parentId = seeded.parentId;
      phoneState = seeded.phone;
    } else {
      const parent = listParents(db).find((p) => p.username === PARENT.username);
      if (!parent) throw new Error(`The demo's parent account (${PARENT.username}) is gone from ${dir.path}: give --dir a new directory.`);
      parentId = parent.id;
      // A new password each run, as reset-password makes one: the demo prints it, and keeps only its hash.
      await setPassword(db, parentId, password);
      endAllSessions(db, parentId);
      audit(db, Date.now(), { kind: "server" }, "parent.password_reset", { detail: { username: PARENT.username } });
    }
    if (!phoneState) throw new Error("The simulated phone has no state");
    const demo = demoToken(db, dir, parentId, `${publicUrl}/mcp`, Date.now());
    writeJson(dir.path, STATE_FILE, demo);
    writeJson(dir.path, PHONE_FILE, phoneState);

    // What the server does every hour and every 5 minutes, as src/index.ts runs it: its backups go in the demo's directory.
    const tidy = () => {
      if (!db || !deps) return;
      cleanUp(db, Date.now());
      cleanAgentTemp(config.agentsDir, Date.now());
    };
    tidy();
    timer = setInterval(tidy, 3_600_000);
    timer.unref();
    // No backup passphrase from the environment: the demo's backups are plain, like its made-up family.
    stopOps = startOps(deps, { env: {} });
    // The first round now, not in 20 seconds: the day's backup, so the server's card isn't asking for one.
    await opsTick(deps);

    const time = clockOf(zone);
    const savedDir = dir.path;
    phone = new SimPhone({
      server: `http://127.0.0.1:${String(port)}`,
      zone,
      state: phoneState,
      save: (s) => {
        writeJson(savedDir, PHONE_FILE, s);
      },
      log: (line) => {
        console.log(`[${time()}] ${line}`);
      },
    });
    if (!dir.fresh) phone.reboot();

    const lines = [
      "",
      "Belay demo: a made-up family and a simulated phone. Nothing here is real.",
      "",
      `  Parent page  ${publicUrl}`,
      `  Username     ${PARENT.username}`,
      `  Password     ${password}${dir.fresh ? "" : "   (new for this run)"}`,
      "",
      "Connect Claude Code to it over MCP, with a personal access token the demo made:",
      "",
      `  claude mcp add --transport http belay-demo ${publicUrl}/mcp --header "Authorization: Bearer ${demo.token}"`,
      "",
      `Then ask Claude: "Is ${PHONE_NAME} OK, and what's waiting for me?"`,
      "claude.ai and the Claude desktop app only connect to a server on a public HTTPS address",
      "(docs/server.md); this one is on localhost, so connect Claude Code.",
      "",
      `${PHONE_NAME}, the simulated phone, checks in and waits for new rules like a real one. Answer`,
      `${KID}'s requests on the Requests page, or pause the phone, and this window shows it apply that within seconds.`,
      "",
      dir.temp
        ? `Data: ${dir.path} (a new temporary directory, deleted when the demo stops)`
        : `Data: ${dir.path} (kept between runs)`,
      ...(ignored.length ? [`Ignored from your environment: ${ignored.join(", ")}. The demo uses its own settings.`] : []),
      "Ctrl-C stops the phone and the server.",
      "",
    ];
    ready = true;
    console.log(lines.join("\n"));
    phone.start({ rebooted: !dir.fresh });
    return await new Promise<number>(() => undefined);
  } catch (error) {
    console.error(`The demo stopped: ${error instanceof Error ? error.message : String(error)}`);
    return await stop(1);
  }
}

process.exitCode = await main();
