/**
 * get_server_health: the family's server itself, over MCP, read-only: its problems, backups and
 * their checks, the restore drill, disk, database and clock. It carries no family data: no
 * phone's or app's name and nothing the kid wrote; the phones appear only as a count, for the
 * clock. Each call is in the activity log, like every read.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { basename } from "node:path";
import { audit } from "../audit.js";
import type { Deps } from "../deps.js";
import type { Caller } from "../mcp/server.js";
import { formatDuration, isoInZone } from "../time.js";
import { BACKUP_HOUR, BACKUPS_KEPT } from "./backups.js";
import { serverHealth, type ServerHealth } from "./health.js";
import { hourLabel } from "./words.js";

const STATUS: Record<ServerHealth["status"], string> = { ok: "OK", attention: "needs attention", urgent: "needs a parent now" };

const gb = (bytes: number) => Math.round(bytes / 1e8) / 10;
const mb = (bytes: number) => Math.round(bytes / 1e5) / 10;

function clockWords(clock: ServerHealth["clock"]): string {
  if (clock.offMs === null) return "can't tell: that needs two or more phones that checked in within a day";
  if (clock.offMs === 0) return `in step with the ${clock.phones} phones that checked in within a day`;
  return `about ${formatDuration(Math.abs(clock.offMs))} ${clock.offMs > 0 ? "ahead of" : "behind"} the clocks of all ${clock.phones} phones that checked in within a day`;
}

export function registerOpsTools(server: McpServer, deps: Deps, caller: Caller): void {
  server.registerTool(
    "get_server_health",
    {
      title: "Server health",
      description:
        "The family's Belay server itself: its problems in plain words (urgent ones first), the last backup and whether it's encrypted, the last daily backup's result, when a backup was last verified, when the family last did a restore drill (one is due every 3 months), free disk space, the database's size, and whether the server's clock agrees with the phones'. No family data.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    () => {
      const h = serverHealth(deps);
      const iso = (ms: number) => isoInZone(ms, h.tz);
      audit(deps.db, h.now, { kind: "ai", parentId: caller.parentId, clientName: caller.clientName }, "ai.read", { detail: { what: "the server's health" } });
      const last = h.lastBackup;
      const daily = h.lastDaily;
      const result = {
        now: iso(h.now),
        timezone: h.tz,
        status: STATUS[h.status],
        problems: h.problems.map((p) => ({ urgent: p.urgent, problem: p.text })),
        ...(h.drillCopy ? { note: `This server is a restore drill's scratch copy, restored ${iso(h.drillCopy.at)}: it sends no notifications.` } : {}),
        backups: {
          schedule: `every day after ${hourLabel(BACKUP_HOUR)} in the family's timezone, the newest ${BACKUPS_KEPT} kept`,
          last_backup: last
            ? {
                at: iso(last.startedAt),
                file: basename(last.file),
                size_mb: last.bytes === null ? null : mb(last.bytes),
                encrypted: last.encrypted,
                made_by: last.kind === "daily" ? "the daily backup" : "the backup command",
              }
            : null,
          last_daily_try: daily ? { at: iso(daily.startedAt), worked: daily.ok, ...(daily.ok ? {} : { problem: daily.error }) } : null,
          last_verified: h.lastVerify ? { at: iso(h.lastVerify.at), restores: h.lastVerify.ok } : null,
          last_restore_drill: h.lastDrill ? iso(h.lastDrill.at) : null,
          restore_drill_due: h.drillDue,
        },
        disk: h.disk ? { free_percent: Math.floor((h.disk.freeBytes / (h.disk.totalBytes || 1)) * 100), free_gb: gb(h.disk.freeBytes), total_gb: gb(h.disk.totalBytes) } : null,
        database_mb: h.dbBytes === null ? null : mb(h.dbBytes),
        server_clock: clockWords(h.clock),
      };
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  );
}
