import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { listAudit } from "../src/audit.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { recordCheck, runDailyBackup } from "../src/ops/backups.js";
import { setOpsOptions } from "../src/ops/options.js";
import { device, deviceCall, enrollPhone, pkg, signIn, snapshot, T0 } from "./helpers.js";
import { FAST_SCRYPT, PASSPHRASE, dailyContext, opsServer } from "./ops-helpers.js";

const MCP = "https://belay.example.org/mcp";
const MIN = 60_000;

async function family() {
  const t = opsServer();
  const { parent } = await signIn(t, "sam", "Sam");
  for (const name of ["Sam's phone", "Sam's old phone"]) {
    const phone = await enrollPhone(t, name);
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.chat", { label: "Chatter Box" })], T0));
    await deviceCall(t, phone.token, "checkin", { status: device({ device_time: T0 + 20 * MIN }) });
  }
  const { token } = createPersonalToken(t.deps.db, t.now(), parent.id, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  return { t, client };
}

async function health(client: Client) {
  const res = await client.callTool({ name: "get_server_health", arguments: {} });
  const text = (res.content as { text: string }[])[0]?.text ?? "";
  return { text, json: JSON.parse(text) as Record<string, any> };
}

describe("get_server_health", () => {
  it("is a read-only tool", async () => {
    const { client } = await family();
    const tool = (await client.listTools()).tools.find((x) => x.name === "get_server_health");
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, openWorldHint: false });
  });

  it("gives the server's problems, backups, checks, disk and clock, and no family data", async () => {
    const { t, client } = await family();
    await runDailyBackup(dailyContext(t, { passphrase: () => PASSPHRASE }));
    recordCheck(t.deps.db, { kind: "verify", at: T0, file: "belay-2026-11-16.db.enc", ok: true, detail: null, parentId: null });
    setOpsOptions(t.deps, { env: {}, scrypt: FAST_SCRYPT, disk: () => ({ freeBytes: 15e9, totalBytes: 500e9 }) });
    const { json, text } = await health(client);
    expect(json).toMatchObject({
      now: "2026-11-16T10:00:00-05:00",
      timezone: "America/New_York",
      status: "needs a parent now",
      problems: [
        { urgent: true, problem: "The server's disk is almost full: 3% free (15 GB of 500 GB). Free some space now: once it's full, Belay can't save anything." },
        { urgent: false, problem: expect.stringContaining("The server's clock seems to be about 20 minutes behind") },
      ],
      backups: {
        schedule: "every day after 2 AM in the family's timezone, the newest 14 kept",
        last_backup: { at: "2026-11-16T10:00:00-05:00", file: "belay-2026-11-16.db.enc", encrypted: true, made_by: "the daily backup" },
        last_daily_try: { at: "2026-11-16T10:00:00-05:00", worked: true },
        last_verified: { at: "2026-11-16T10:00:00-05:00", restores: true },
        last_restore_drill: null,
        restore_drill_due: true,
      },
      disk: { free_percent: 3, free_gb: 15, total_gb: 500 },
      server_clock: "about 20 minutes behind the clocks of all 2 phones that checked in within a day",
    });
    expect(json.database_mb).toBeGreaterThan(0);
    for (const familyData of ["Sam", "Chatter", "com.example"]) expect(text).not.toContain(familyData);
    expect(listAudit(t.deps.db, { limit: 1, includeReads: true })[0]).toMatchObject({ actor: "ai", clientName: "Claude", action: "ai.read", detail: { what: "the server's health" } });
  });

  it("says when all is well", async () => {
    const { t, client } = await family();
    for (const phone of t.deps.db.prepare<[], { id: string }>("SELECT id FROM devices").all()) {
      t.deps.db.prepare("UPDATE devices SET facts = json_set(facts, '$.device_time', ?) WHERE id = ?").run(T0, phone.id);
    }
    await runDailyBackup(dailyContext(t));
    const { json } = await health(client);
    expect(json).toMatchObject({ status: "OK", problems: [], server_clock: "in step with the 2 phones that checked in within a day", backups: { last_backup: { encrypted: false } } });
  });
});
