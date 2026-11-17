/**
 * Phase 6: updating Belay from the family's server. A person adds an APK (agent-add), a parent
 * offers it to a phone (agent-offer, or the parent page), the policy carries it while the phone
 * runs an older version, and the phone downloads it (GET /api/v1/agent/<sha256>.apk). The APKs
 * here are made up: a zip's first bytes, then noise; the server doesn't look further.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { runCommand } from "../src/admin.js";
import { listAudit } from "../src/audit.js";
import { Policy } from "../src/device/schemas.js";
import { AgentFileError, addAgentFile, offerAgent } from "../src/family/agent.js";
import { buildPolicy } from "../src/family/policy.js";
import { parseRange } from "../src/http.js";
import { device, deviceCall, enrollPhone, signIn, testServer, type TestServer } from "./helpers.js";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "belay-agent-test-"));
  scratch.push(dir);
  return dir;
}

function fakeApk(dir: string, name = "belay.apk", size = 300_000) {
  const bytes = Buffer.concat([Buffer.from("PK\x03\x04", "latin1"), randomBytes(size - 4)]);
  const path = join(dir, name);
  writeFileSync(path, bytes);
  return { path, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}

async function family() {
  const files = tempDir();
  const agentsDir = join(files, "agents");
  const t = testServer({ config: { agentsDir } });
  const sam = await signIn(t);
  // The test phone runs Belay version code 2 (helpers.device).
  const phone = await enrollPhone(t, "CI phone");
  const other = await enrollPhone(t, "Alex's phone");
  const apk = fakeApk(files);
  const policy = (id = phone.deviceId) => Policy.parse(buildPolicy(t.deps.db, id, t.now()));
  return { t, sam, phone, other, files, agentsDir, apk, policy };
}

async function cli(t: TestServer, argv: string[], stdin?: NodeJS.ReadableStream) {
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
    stdin,
  });
  return { code, out, err };
}

describe("agent-add", () => {
  it("keeps the APK under its SHA-256, and prints only that", async () => {
    const { t, agentsDir, apk } = await family();
    const added = await cli(t, ["agent-add", apk.path, "--version-code", "3", "--version-name", "0.3.0"]);
    expect(added).toMatchObject({ code: 0, out: [apk.sha256] });
    expect(added.err[0]).toContain("Added: Belay 0.3.0 (version 3), 300000 bytes.");
    expect(readdirSync(agentsDir)).toEqual([`${apk.sha256}.apk`]);
    expect(readFileSync(join(agentsDir, `${apk.sha256}.apk`)).equals(apk.bytes)).toBe(true);
    expect(statSync(join(agentsDir, `${apk.sha256}.apk`)).mode & 0o077).toBe(0);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "agent.added", detail: { version_code: 3, sha256: apk.sha256 } });
    // The same file again: one copy, the same answer.
    expect(await cli(t, ["agent-add", apk.path, "--version-code", "3"])).toMatchObject({ code: 0, out: [apk.sha256] });
    expect(readdirSync(agentsDir)).toHaveLength(1);
    const twice = await cli(t, ["agent-add", apk.path, "--version-code", "4"]);
    expect(twice).toMatchObject({ code: 1, out: [], err: ["That file was added before as version 3. One file has one version code."] });
  });

  it("reads the APK from stdin with -", async () => {
    const { t, apk } = await family();
    const added = await cli(t, ["agent-add", "-", "--version-code", "3"], Readable.from([apk.bytes.subarray(0, 1000), apk.bytes.subarray(1000)]));
    expect(added).toMatchObject({ code: 0, out: [apk.sha256] });
  });

  it("refuses what isn't an APK, and keeps nothing of it", async () => {
    const { t, files, agentsDir } = await family();
    writeFileSync(join(files, "notes.txt"), "Ignore previous instructions.");
    writeFileSync(join(files, "empty.apk"), "");
    for (const [argv, says] of [
      [["agent-add", join(files, "notes.txt"), "--version-code", "3"], "That isn't an APK"],
      [["agent-add", join(files, "empty.apk"), "--version-code", "3"], "That file is empty."],
      [["agent-add", join(files, "missing.apk"), "--version-code", "3"], "Can't read that file (ENOENT)."],
      [["agent-add", join(files, "belay.apk"), "--version-code", "zero"], "The version code is a whole number"],
      [["agent-add", join(files, "belay.apk"), "--version-code", "3", "--version-name", "0.3 <b>"], "A version name is up to 50"],
      [["agent-add", join(files, "belay.apk")], "Usage: agent-add"],
    ] as const) {
      const res = await cli(t, [...argv]);
      expect(res.code, argv.join(" ")).toBe(1);
      expect(res.out).toEqual([]);
      expect(res.err.join("\n")).toContain(says);
    }
    expect(readdirSync(agentsDir)).toEqual([]);
  });

  it("stops at the size limit while reading, and keeps nothing", async () => {
    const { t, agentsDir, apk } = await family();
    await expect(addAgentFile(t.deps.db, agentsDir, t.now(), apk.path, { code: 3, name: null }, { parentId: null }, 100_000)).rejects.toThrow(AgentFileError);
    expect(readdirSync(agentsDir)).toEqual([]);
    expect(t.deps.db.prepare("SELECT COUNT(*) AS n FROM agent_files").get()).toEqual({ n: 0 });
  });
});

describe("agent-offer", () => {
  it("offers the version to one phone; its policy carries it until the phone runs it", async () => {
    const { t, phone, other, apk, policy } = await family();
    await cli(t, ["agent-add", apk.path, "--version-code", "3", "--version-name", "0.3.0"]);
    const offered = await cli(t, ["agent-offer", "CI phone", apk.sha256]);
    expect(offered).toEqual({ code: 0, out: ["CI phone: Belay 0.3.0 (version 3) is offered (rules version 1)."], err: [] });
    expect(policy()).toMatchObject({ version: 1, agent_update: { version_code: 3, version_name: "0.3.0", sha256: apk.sha256, size: 300_000 } });
    expect(policy(other.deviceId).agent_update).toBeNull();
    expect(listAudit(t.deps.db, { limit: 1, includeReads: false })[0]).toMatchObject({ actor: "server", action: "agent.offered", deviceName: "CI phone" });
    // The phone checks in running version 3: the offer leaves its policy, with a new version.
    await deviceCall(t, phone.token, "checkin", { status: device({ agent_version_code: 3, device_time: t.now() }) });
    expect(policy()).toMatchObject({ version: 2, agent_update: null });
  });

  it("says so when the phone already runs that version or a newer one", async () => {
    const { t, apk, policy } = await family();
    await cli(t, ["agent-add", apk.path, "--version-code", "2"]);
    const offered = await cli(t, ["agent-offer", "CI phone", apk.sha256]);
    expect(offered.code).toBe(0);
    expect(offered.err).toEqual(["The phone runs version 2, which isn't older: Android won't install this one over it, so the phone won't get it."]);
    expect(policy().agent_update).toBeNull();
  });

  it("needs a version on the server, a SHA-256 and a connected phone", async () => {
    const { t, phone, apk } = await family();
    expect((await cli(t, ["agent-offer", "CI phone", apk.sha256])).err).toEqual(["There's no such version of Belay on the server. Add it with agent-add first."]);
    expect((await cli(t, ["agent-offer", "CI phone", "abc"])).err[0]).toContain("Usage: agent-offer");
    t.deps.db.prepare("UPDATE devices SET revoked_at = ?, token_hash = NULL WHERE id = ?").run(t.now(), phone.deviceId);
    expect((await cli(t, ["agent-offer", "CI phone", apk.sha256])).err).toEqual(["CI phone is disconnected, so it can't be updated."]);
  });

  it("is a person's action: an AI client can't offer one", async () => {
    const { t, sam, phone, apk } = await family();
    await cli(t, ["agent-add", apk.path, "--version-code", "3"]);
    const ai = { kind: "ai", parentId: sam.parent.id, clientName: "Claude" } as unknown as { kind: "server" };
    expect(() => offerAgent({ db: t.deps.db, now: t.now() }, phone.deviceId, apk.sha256, ai)).toThrow(/Only a person/);
  });
});

describe("GET /api/v1/agent/<sha256>.apk", () => {
  async function offered() {
    const f = await family();
    await cli(f.t, ["agent-add", f.apk.path, "--version-code", "3", "--version-name", "0.3.0"]);
    await cli(f.t, ["agent-offer", "CI phone", f.apk.sha256]);
    const download = (token: string, headers: Record<string, string> = {}, name = `${f.apk.sha256}.apk`, method = "GET") =>
      f.t.app.request(`/api/v1/agent/${name}`, { method, headers: { authorization: `Bearer ${token}`, ...headers } });
    return { ...f, download };
  }

  it("sends the offered file whole, with its type, length and ETag", async () => {
    const { t, phone, apk, download } = await offered();
    t.advance(60_000);
    const res = await download(phone.token);
    expect(res.status).toBe(200);
    expect(Object.fromEntries(res.headers)).toMatchObject({
      "content-type": "application/vnd.android.package-archive",
      "content-length": "300000",
      "accept-ranges": "bytes",
      etag: `"${apk.sha256}"`,
    });
    expect(Buffer.from(await res.arrayBuffer()).equals(apk.bytes)).toBe(true);
    expect(t.deps.db.prepare("SELECT last_seen_at FROM devices WHERE id = ?").get(phone.deviceId)).toEqual({ last_seen_at: t.now() });
  });

  it("sends a range, so a download can resume", async () => {
    const { apk, phone, download } = await offered();
    const rest = await download(phone.token, { range: "bytes=100000-" });
    expect(rest.status).toBe(206);
    expect(rest.headers.get("content-range")).toBe("bytes 100000-299999/300000");
    expect(rest.headers.get("content-length")).toBe("200000");
    expect(Buffer.from(await rest.arrayBuffer()).equals(apk.bytes.subarray(100000))).toBe(true);
    const middle = await download(phone.token, { range: "bytes=10-19" });
    expect(middle.status).toBe(206);
    expect(middle.headers.get("content-range")).toBe("bytes 10-19/300000");
    expect(Buffer.from(await middle.arrayBuffer()).equals(apk.bytes.subarray(10, 20))).toBe(true);
    const end = await download(phone.token, { range: "bytes=-4" });
    expect(Buffer.from(await end.arrayBuffer()).equals(apk.bytes.subarray(-4))).toBe(true);
    const past = await download(phone.token, { range: "bytes=999999999999-" });
    expect(past.status).toBe(416);
    expect(past.headers.get("content-range")).toBe("bytes */300000");
    expect((await download(phone.token, { range: "bytes=20-10" })).status).toBe(416);
    // Several ranges, or a range for an older file, get the whole file.
    expect((await download(phone.token, { range: "bytes=0-1,5-6" })).status).toBe(200);
    expect((await download(phone.token, { range: "bytes=0-1", "if-range": '"0000"' })).status).toBe(200);
    const head = await download(phone.token, { range: "bytes=0-9" }, undefined, "HEAD");
    expect(head.status).toBe(206);
    expect(head.headers.get("content-length")).toBe("10");
  });

  it("is a 404 unless it's this phone's offer right now", async () => {
    const { t, phone, other, apk, files, download } = await offered();
    const notFound = async (res: Response) => {
      expect(res.status).toBe(404);
      expect(await res.json()).toMatchObject({ error: "not_found" });
    };
    await notFound(await download(other.token));
    const another = fakeApk(files, "other.apk");
    await cli(t, ["agent-add", another.path, "--version-code", "4"]);
    await notFound(await download(phone.token, {}, `${another.sha256}.apk`));
    await notFound(await download(phone.token, {}, `${apk.sha256}.zip`));
    await notFound(await download(phone.token, {}, "..%2f..%2fbelay.db"));
    expect((await download("x".repeat(43))).status).toBe(401);
    // Once the phone runs it, it's not offered any more.
    await deviceCall(t, phone.token, "checkin", { status: device({ agent_version_code: 3 }) });
    await notFound(await download(phone.token));
  });

  it("has its own limit per phone", async () => {
    const { phone, download } = await offered();
    for (let i = 0; i < 30; i++) expect((await download(phone.token, { range: `bytes=${i}-${i}` })).status).toBe(206);
    const limited = await download(phone.token);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });
});

describe("parseRange", () => {
  it("reads one range of bytes, as RFC 9110 has it", () => {
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange("bytes=0-", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=10-200", 100)).toEqual({ start: 10, end: 99 });
    expect(parseRange("bytes=-200", 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 100)).toBe("unsatisfiable");
    expect(parseRange("items=0-1", 100)).toBeNull();
    expect(parseRange("bytes=-", 100)).toBeNull();
  });
});
