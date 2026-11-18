/**
 * npm run demo itself (docs/demo.md), as a person runs it: it starts on localhost with its own
 * settings, whatever BELAY_* the shell has; it prints the parent page, the password and the line
 * that connects Claude Code; a parent signs in and approves the waiting app, and the simulated
 * phone applies it within seconds; the token it printed works over MCP; and Ctrl-C stops it and
 * deletes its temporary directory. Made-up data only: the demo's own.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SERVER = join(import.meta.dirname, "..");
const BANNER = "Demo: a made-up family. Nothing here is real.";

/** A port nothing listens on now. */
function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => {
        done(typeof address === "object" && address ? address.port : 0);
      });
    });
  });
}

describe("npm run demo", () => {
  const scratch = mkdtempSync(join(tmpdir(), "belay-demo-run-"));
  /** Where a real server's settings in the shell would put its data: the demo must never use it. */
  const realDataDir = join(scratch, "real-data");
  let child: ChildProcess | null = null;
  let out = "";
  afterAll(() => {
    child?.kill("SIGKILL");
    rmSync(scratch, { recursive: true, force: true });
  });

  const printed = async (pattern: RegExp, ms = 30_000): Promise<RegExpMatchArray> => {
    const end = Date.now() + ms;
    for (;;) {
      const match = pattern.exec(out);
      if (match) return match;
      if (Date.now() > end || child?.exitCode !== null) throw new Error(`The demo didn't print ${String(pattern)}:\n${out}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };

  it("runs with its own settings, applies a parent's approval on the phone, and cleans up on Ctrl-C", async () => {
    const port = await freePort();
    const env: NodeJS.ProcessEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("BELAY_")));
    // A real server's settings in the shell: ignored, and said so.
    env.BELAY_PUBLIC_URL = "https://belay.example.org";
    env.BELAY_DATA_DIR = realDataDir;
    const running = spawn(process.execPath, ["--import", "tsx", "demo/main.ts", "--port", String(port)], { cwd: SERVER, env, stdio: ["ignore", "pipe", "pipe"] });
    child = running;
    running.stdout.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    running.stderr.on("data", (chunk: Buffer) => (out += chunk.toString("utf8")));
    const exited = new Promise<number | null>((done) => {
      running.once("exit", (code) => {
        done(code);
      });
    });

    await printed(/Ctrl-C stops the phone and the server\./);
    const base = `http://localhost:${String(port)}`;
    expect(out).toContain(`Parent page  ${base}`);
    expect(out).toContain("Ignored from your environment: BELAY_DATA_DIR, BELAY_PUBLIC_URL.");
    expect(out).toMatch(/claude\.ai and the Claude desktop app only connect to a server on a public HTTPS address/);
    const password = (await printed(/Password {5}(\S+)/))[1] ?? "";
    const token = (await printed(new RegExp(`claude mcp add --transport http belay-demo ${base}/mcp --header "Authorization: Bearer (belay_pat_[\\w-]+)"`)))[1] ?? "";
    const dir = (await printed(/Data: (\S+) \(a new temporary directory/))[1] ?? "";
    expect(existsSync(join(dir, "belay-demo.json"))).toBe(true);

    // A parent signs in, as in a browser.
    const login = await fetch(`${base}/login`);
    expect(await login.text()).toContain(BANNER);
    const signedIn = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base },
      body: new URLSearchParams({ username: "demo", password }),
      redirect: "manual",
    });
    expect(signedIn.status).toBe(302);
    const cookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    const requests = await (await fetch(`${base}/requests`, { headers: { cookie } })).text();
    expect(requests).toContain(BANNER);
    const csrf = /name="_csrf" value="([^"]+)"/.exec(requests)?.[1] ?? "";
    const forms = [...requests.matchAll(/<form[^>]*action="(\/devices\/[^"]+\/requests\/[^"]+\/answer)"[^>]*>([\s\S]*?)<\/form>/g)];
    const approve = forms.find((f) => (f[2] ?? "").includes("Lantern Chat") && (f[2] ?? "").includes('value="approved"'))?.[1] ?? "";
    expect(approve).not.toBe("");

    // The waiting app, approved: the phone applies it within seconds.
    const before = out.length;
    const answered = await fetch(`${base}${approve}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", origin: base, cookie },
      body: new URLSearchParams({ _csrf: csrf, answer: "approved", back: "requests" }),
      redirect: "manual",
    });
    expect(answered.headers.get("location")).toBe("/requests?saved=answer_approved");
    await printed(/Robin's phone: applied the rules \(version \d+\)\. Lantern Chat (runs now|is allowed now; it is off during \w+)\. Robin sees your answer: Lantern Chat: approved\./, 10_000);
    expect(out.indexOf("Lantern Chat: approved", before)).toBeGreaterThan(before);

    // The token it printed connects Claude Code.
    const mcp = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } }),
    });
    expect(mcp.status).toBe(200);
    expect(JSON.stringify(await mcp.json())).toContain('"name":"belay"');

    // Ctrl-C: the phone and the server stop, and the temporary directory goes.
    running.kill("SIGINT");
    expect(await exited).toBe(0);
    expect(out).toContain(`Deleted ${dir}.`);
    expect(existsSync(dir)).toBe(false);
    expect(existsSync(realDataDir)).toBe(false);
  }, 60_000);
});
