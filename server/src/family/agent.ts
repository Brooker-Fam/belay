/**
 * Phase 6: updating Belay from the family's server (docs/design/phase6-reliability.md).
 *
 * A parent adds an APK of Belay on a phone's page ("Add a version of Belay", which streams the
 * upload here: web/upload.ts), or a person with the CLI (agent-add): the server keeps the file as
 * agents/<sha256>.apk in its data directory, with the version code and name the person gives
 * it. It doesn't parse the APK; the phone checks the package, the version and the signing
 * certificate before installing (docs/protocol.md, "Updates"). A parent then offers one version
 * to a phone, on the parent page or with the CLI: that's a parent's action, never an AI
 * client's. The policy carries the offer (agent_update) while the phone runs an older version.
 */
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { DB } from "../db.js";
import { LIMITS, sha256Hex } from "../device/schemas.js";
import { deviceFacts } from "./devices.js";
import { changePolicy, type Changed, type Person, type PolicyContext } from "./policy.js";

export interface AgentFile {
  sha256: string;
  size: number;
  versionCode: number;
  versionName: string | null;
  addedAt: number;
}

interface FileRow {
  sha256: string;
  size: number;
  version_code: number;
  version_name: string | null;
  added_at: number;
}

const toFile = (r: FileRow): AgentFile => ({ sha256: r.sha256, size: r.size, versionCode: r.version_code, versionName: r.version_name, addedAt: r.added_at });

/** Why a file can't be added or offered, in words for the CLI and the parent page. */
export class AgentFileError extends Error {
  override name = "AgentFileError";
}

/** "0.4.0" or "0.4.0-beta.1": what the kid's screen shows ("Belay was updated to version …"). */
export const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,49}$/;

/** Where a stored file is, by its SHA-256 (already checked to be hex, so it can't name another path). */
export function agentPath(dir: string, sha256: string): string {
  if (!sha256Hex.safeParse(sha256).success) throw new AgentFileError("Not a SHA-256.");
  return join(dir, `${sha256}.apk`);
}

/**
 * Adds a version of Belay: the file (a path, or a stream such as stdin or a parent's upload) is
 * written to a temporary file in the store while it's hashed, at most LIMITS.maxAgentBytes, then
 * renamed to <sha256>.apk. The same file added again keeps one copy.
 */
export async function addAgentFile(
  db: DB,
  dir: string,
  now: number,
  source: string | NodeJS.ReadableStream,
  version: { code: number; name: string | null },
  by: { parentId: string | null },
  maxBytes: number = LIMITS.maxAgentBytes,
): Promise<{ file: AgentFile; existed: boolean }> {
  if (!Number.isSafeInteger(version.code) || version.code < 1) throw new AgentFileError("The version code is a whole number, 1 or more: Belay's versionCode in android/app/build.gradle.kts.");
  if (version.name !== null && !VERSION_NAME.test(version.name)) {
    throw new AgentFileError("A version name is up to 50 letters, digits and . + _ -, like 0.4.0.");
  }
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const temporary = join(dir, `.adding-${randomBytes(8).toString("hex")}.tmp`);
  const hash = createHash("sha256");
  let size = 0;
  let head = Buffer.alloc(0);
  const counted = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      size += chunk.length;
      if (size > maxBytes) {
        done(new AgentFileError(`That file is larger than ${Math.round(maxBytes / 1024 / 1024)} MB, the most the server keeps.`));
        return;
      }
      if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
      hash.update(chunk);
      done(null, chunk);
    },
  });
  try {
    const input = typeof source === "string" ? createReadStream(source) : source;
    await pipeline(input, counted, createWriteStream(temporary, { mode: 0o600 }));
  } catch (error) {
    await rm(temporary, { force: true });
    if (error instanceof AgentFileError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "EACCES") throw new AgentFileError(`Can't read that file (${code}).`);
    throw error;
  }
  // An APK is a zip file. That much is checked; the phone checks the rest.
  if (size === 0 || !head.equals(Buffer.from("PK\x03\x04", "latin1"))) {
    await rm(temporary, { force: true });
    throw new AgentFileError(size === 0 ? "That file is empty." : "That isn't an APK: an APK is a zip file, and this one doesn't start like one.");
  }
  const sha256 = hash.digest("hex");
  const known = getAgentFile(db, sha256);
  if (known && known.versionCode !== version.code) {
    await rm(temporary, { force: true });
    throw new AgentFileError(`That file was added before as version ${known.versionCode}. One file has one version code.`);
  }
  await rename(temporary, agentPath(dir, sha256));
  db.prepare(
    `INSERT INTO agent_files (sha256, size, version_code, version_name, added_at, added_by) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (sha256) DO UPDATE SET version_name = COALESCE(excluded.version_name, agent_files.version_name)`,
  ).run(sha256, size, version.code, version.name, now, by.parentId);
  const file = getAgentFile(db, sha256);
  if (!file) throw new Error("agent file vanished");
  return { file, existed: known !== null };
}

export function getAgentFile(db: DB, sha256: string): AgentFile | null {
  const row = db.prepare<[string], FileRow>("SELECT sha256, size, version_code, version_name, added_at FROM agent_files WHERE sha256 = ?").get(sha256);
  return row ? toFile(row) : null;
}

/** Newest version first. */
export function listAgentFiles(db: DB): AgentFile[] {
  return db
    .prepare<[], FileRow>("SELECT sha256, size, version_code, version_name, added_at FROM agent_files ORDER BY version_code DESC, added_at DESC")
    .all()
    .map(toFile);
}

/** "0.4.0 (version 4)" */
export function versionWords(file: Pick<AgentFile, "versionCode" | "versionName">): string {
  return file.versionName ? `${file.versionName} (version ${file.versionCode})` : `version ${file.versionCode}`;
}

/** What the phone last said about the update offered to it (enforcement.agent_update). */
export type UpdateState = "downloading" | "checking" | "installing" | "failed" | "done";

export interface Offer {
  file: AgentFile;
  offeredAt: number;
  offeredBy: string | null;
  /** The phone's last report about this version, if any. */
  state: UpdateState | null;
  /** The phone's words when it failed: untrusted. */
  problem: string | null;
  stateAt: number | null;
  reportedAt: number | null;
  installingAt: number | null;
  /** When the phone first ran this version or a newer one. */
  doneAt: number | null;
  /** Whether the policy offers it now: the phone runs an older version. */
  sent: boolean;
}

interface OfferRow extends FileRow {
  offered_at: number;
  offered_by_name: string | null;
  state: UpdateState | null;
  problem: string | null;
  state_at: number | null;
  reported_at: number | null;
  installing_at: number | null;
  done_at: number | null;
}

export function currentOffer(db: DB, deviceId: string): Offer | null {
  const row = db
    .prepare<[string], OfferRow>(
      `SELECT f.sha256, f.size, f.version_code, f.version_name, f.added_at, o.offered_at, p.name AS offered_by_name, o.state, o.problem, o.state_at,
              o.reported_at, o.installing_at, o.done_at
       FROM agent_offers o JOIN agent_files f ON f.sha256 = o.sha256 LEFT JOIN parents p ON p.id = o.offered_by WHERE o.device_id = ?`,
    )
    .get(deviceId);
  if (!row) return null;
  const running = deviceFacts(db, deviceId)?.agent_version_code;
  return {
    file: toFile(row),
    offeredAt: row.offered_at,
    offeredBy: row.offered_by_name,
    state: row.state,
    problem: row.problem,
    stateAt: row.state_at,
    reportedAt: row.reported_at,
    installingAt: row.installing_at,
    doneAt: row.done_at,
    sent: running === undefined || running < row.version_code,
  };
}

/** Whether a version can't replace what the phone runs: Android refuses an older or equal version code. */
export function notNewer(db: DB, deviceId: string, file: Pick<AgentFile, "versionCode">): number | null {
  const running = deviceFacts(db, deviceId)?.agent_version_code;
  return running !== undefined && running >= file.versionCode ? running : null;
}

/**
 * Offers a version of Belay to one phone: the next policy it gets carries it, and the phone
 * downloads, checks and installs it. A parent's action, or the CLI's as a person: never an AI
 * client's. `notNewerThan`: the version the phone runs, when it isn't older than this one.
 */
export function offerAgent(ctx: PolicyContext, deviceId: string, sha256: string, who: Person): Changed<{ file: AgentFile; notNewerThan: number | null }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a person offers an update of Belay");
  const file = getAgentFile(ctx.db, sha256);
  if (!file) throw new AgentFileError("There's no such version of Belay on the server. Add it with agent-add first.");
  return changePolicy(ctx, deviceId, who, (log) => {
    ctx.db
      .prepare(
        `INSERT INTO agent_offers (device_id, sha256, offered_at, offered_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (device_id) DO UPDATE SET sha256 = excluded.sha256, offered_at = excluded.offered_at, offered_by = excluded.offered_by,
           state = NULL, problem = NULL, state_at = NULL, reported_at = NULL, installing_at = NULL, done_at = NULL, failure_told_at = NULL`,
      )
      .run(deviceId, sha256, ctx.now, who.kind === "parent" ? who.parentId : null);
    log("agent.offered", { version_code: file.versionCode, version_name: file.versionName ?? undefined, sha256 });
    return { file, notNewerThan: notNewer(ctx.db, deviceId, file) };
  });
}

/** Stops offering the update: the phone's next policy has none. A person's action. */
export function withdrawOffer(ctx: PolicyContext, deviceId: string, who: Person): Changed<{ withdrawn: boolean }> {
  if ((who as { kind: string }).kind === "ai") throw new Error("Only a person changes an update of Belay");
  return changePolicy(ctx, deviceId, who, (log) => {
    const offer = currentOffer(ctx.db, deviceId);
    if (!offer) return { withdrawn: false };
    ctx.db.prepare("DELETE FROM agent_offers WHERE device_id = ?").run(deviceId);
    log("agent.withdrawn", { version_code: offer.file.versionCode, version_name: offer.file.versionName ?? undefined });
    return { withdrawn: true };
  });
}

/**
 * The file the policy offers this phone right now, for its download (GET /api/v1/agent/<sha256>.apk),
 * or null: then it's a 404, whatever the file.
 */
export async function offeredFile(db: DB, dir: string, deviceId: string, sha256: string): Promise<{ path: string; size: number } | null> {
  const offer = currentOffer(db, deviceId);
  if (!offer?.sent || offer.file.sha256 !== sha256) return null;
  const path = agentPath(dir, sha256);
  try {
    const info = await stat(path);
    return info.isFile() && info.size === offer.file.size ? { path, size: info.size } : null;
  } catch {
    return null;
  }
}
