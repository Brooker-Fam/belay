/**
 * Phase 5's POST /api/v1/calls (docs/protocol.md): the device token, 128 KB, at most 500 records,
 * strict fields, idempotent by each record's id, rate limited per phone apart from its other calls;
 * kept only while the phone's rules record calls (otherwise accepted, dropped and counted); never a
 * record of an emergency number, 988 or a private number (dropped, and the server's log says so
 * without the number); kept as long as the family keeps them. Made-up 555-01xx numbers only.
 */
import { describe, expect, it } from "vitest";
import { saveContact, setCalls, setPrivateNumber } from "../src/family/calls/changes.js";
import { MAX_RECORDS_PER_DAY, listCallRecords } from "../src/family/calls/records.js";
import { callSettings } from "../src/family/calls/store.js";
import type { PolicyContext } from "../src/family/policy.js";
import { cleanUp } from "../src/maintenance.js";
import { updateSettings } from "../src/settings.js";
import { deviceCall, enrollPhone, signIn, testServer, T0 } from "./helpers.js";

const MOM = "+15555550100";
const STRANGER = "+15555550199";

let counter = 0;
const record = (over: Record<string, unknown> = {}) => {
  counter++;
  return { id: `call-${String(counter).padStart(8, "0")}`, at: T0, direction: "in", number: STRANGER, duration_s: 0, outcome: "rejected", reason: "unknown", ...over };
};

async function family(opts: { log?: boolean } = {}) {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  const sam = await signIn(t);
  const phone = await enrollPhone(t, "Alex's phone");
  const ctx = (): PolicyContext => ({ db: t.deps.db, now: t.now() });
  const parent = { kind: "parent", parentId: sam.parent.id } as const;
  if (opts.log) setCalls(ctx(), phone.deviceId, { enabled: true, mode: "contacts", log: true }, parent);
  const calls = (body: unknown, token = phone.token) => deviceCall(t, token, "calls", body);
  const kept = () => listCallRecords(t.deps.db, phone.deviceId, { limit: 5000 }).map((r) => r.id);
  return { t, phone, ctx, parent, calls, kept };
}

describe("POST /api/v1/calls", () => {
  it("needs the phone's token and checks the body: strict fields, 1 to 500 records, 128 KB", async () => {
    const { calls } = await family({ log: true });
    expect((await calls({ calls: [record()] }, "not-a-token")).status).toBe(401);
    for (const bad of [
      {},
      { calls: [] },
      { calls: [record()], extra: 1 },
      { calls: [{ ...record(), words: "hello" }] },
      { calls: [record({ direction: "sideways" })] },
      { calls: [record({ outcome: "hung_up" })] },
      { calls: [record({ reason: "because" })] },
      { calls: [record({ number: "555-0199" })] },
      { calls: [record({ duration_s: -1 })] },
      { calls: [record({ duration_s: 86_401 })] },
      { calls: [record({ id: "short" })] },
      { calls: Array.from({ length: 501 }, () => record()) },
    ]) {
      const res = await calls(bad);
      expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("invalid_request");
    }
    // The error names the field, never what was in it.
    const res = await calls({ calls: [record({ number: "+1555 my secret" })] });
    expect(await res.text()).not.toContain("secret");
    expect((await calls({ calls: Array.from({ length: 500 }, () => record()) })).status).toBe(200);
    expect((await calls({ calls: [record()], pad: "x".repeat(128 * 1024) })).status).toBe(413);
  });

  it("keeps records only while the rules record calls; otherwise accepts, drops and counts them", async () => {
    const { t, phone, ctx, parent, calls, kept } = await family();
    const first = record();
    let res = await calls({ calls: [first] });
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 1 });
    expect(kept()).toEqual([]);
    // Calls on, but not recording.
    setCalls(ctx(), phone.deviceId, { enabled: true }, parent);
    res = await calls({ calls: [record()] });
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(kept()).toEqual([]);
    expect(callSettings(t.deps.db, phone.deviceId)).toMatchObject({ dropped: 1, droppedAt: t.now() });
    expect(t.logs).toContain("A phone sent 1 call record its rules didn't ask for: not kept.");
    setCalls(ctx(), phone.deviceId, { log: true }, parent);
    res = await calls({ calls: [first] });
    expect(await res.json()).toMatchObject({ accepted: 1 });
    expect(kept()).toEqual([first.id]);
    // Recording stops when calls go off.
    setCalls(ctx(), phone.deviceId, { enabled: false }, parent);
    await calls({ calls: [record()] });
    expect(kept()).toEqual([first.id]);
  });

  it("is idempotent by id; a contact's record keeps its name, and never a number beside it", async () => {
    const { t, phone, ctx, parent, calls } = await family({ log: true });
    const mom = saveContact(ctx(), phone.deviceId, { name: "Mom", numbers: [MOM], calls: true, texts: true, parent: true }, parent).result.contact;
    const fromMom = record({ contact_id: mom.id, number: MOM, outcome: "answered", reason: null, duration_s: 125 });
    expect(await (await calls({ calls: [fromMom, fromMom] })).json()).toMatchObject({ accepted: 2 });
    expect(await (await calls({ calls: [fromMom] })).json()).toMatchObject({ accepted: 1 });
    expect(listCallRecords(t.deps.db, phone.deviceId)).toEqual([
      { id: fromMom.id, at: T0, direction: "in", contactId: mom.id, contactName: "Mom", number: null, durationS: 125, outcome: "answered", reason: null, receivedAt: t.now() },
    ]);
    // Withheld: no number, no contact.
    const withheld = record({ number: null, reason: "withheld" });
    await calls({ calls: [withheld] });
    expect(listCallRecords(t.deps.db, phone.deviceId)[0]).toMatchObject({ id: withheld.id, contactId: null, number: null, reason: "withheld" });
  });

  it("never keeps a record of an emergency number, 988 or a private number, and says so in its log without the number", async () => {
    const { t, phone, ctx, parent, calls, kept } = await family({ log: true });
    setPrivateNumber(ctx(), phone.deviceId, "+15555550177", true, parent);
    const ok = record();
    const res = await calls({
      calls: [
        ok,
        record({ number: "911", direction: "out", outcome: "answered" }),
        record({ number: "988", direction: "out", outcome: "answered" }),
        record({ number: "+1 988" }),
        record({ number: "+18002738255", direction: "out", outcome: "answered" }),
        record({ number: "+15555550177", direction: "out", outcome: "answered" }),
        // Not E.164 and naming 911: taken out before the body is checked, so the others still count.
        { id: "call-zzzz0001", number: "911", whatever: true },
      ],
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ server_time: t.now(), accepted: 7 });
    expect(kept()).toEqual([ok.id]);
    const line = t.logs.find((l) => l.includes("Belay never keeps")) ?? "";
    expect(line).toBe("A phone sent 6 call records Belay never keeps (an emergency number, 988 or a private number): not kept. Belay on the phone shouldn't send them.");
    // Only that it happened: never a number (988 is named as a kind of number, not as the one called), nor the phone.
    for (const n of ["911", "+1 988", '"988"', "8002738255", "5555550177", "call-", "Alex"]) expect(t.logs.join("\n"), n).not.toContain(n);
    // Nothing a parent sees counts them: a count would say the kid called 988.
    expect(callSettings(t.deps.db, phone.deviceId)?.dropped).toBe(0);
    // A call made of nothing else is answered too.
    expect(await (await calls({ calls: [record({ number: "112" })] })).json()).toEqual({ server_time: t.now(), accepted: 1 });
  });

  it("is rate limited per phone, apart from the phone's other calls", async () => {
    const { t, phone, calls } = await family({ log: true });
    for (let i = 0; i < 30; i++) expect((await calls({ calls: [record()] })).status).toBe(200);
    const res = await calls({ calls: [record()] });
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
    // The phone's check-ins still go through.
    expect((await deviceCall(t, phone.token, "events", { events: [] })).status).toBe(200);
    t.advance(61_000);
    expect((await calls({ calls: [record()] })).status).toBe(200);
  });

  it("keeps at most 1000 records a day per phone; the rest are dropped and counted", async () => {
    const { t, phone, calls, kept } = await family({ log: true });
    for (let i = 0; i < MAX_RECORDS_PER_DAY / 500; i++) await calls({ calls: Array.from({ length: 500 }, () => record()) });
    t.advance(61_000);
    expect(await (await calls({ calls: [record()] })).json()).toMatchObject({ accepted: 1 });
    expect(kept()).toHaveLength(MAX_RECORDS_PER_DAY);
    expect(callSettings(t.deps.db, phone.deviceId)?.dropped).toBe(1);
    t.advance(86_400_000);
    await calls({ calls: [record()] });
    expect(kept()).toHaveLength(MAX_RECORDS_PER_DAY + 1);
  });

  it("keeps records as long as the family does (90 days by default), counting from the earlier of the record's time and when it came", async () => {
    const { t, calls, kept } = await family({ log: true });
    const DAY = 86_400_000;
    const old = record({ at: T0 - 100 * DAY });
    const ahead = record({ at: T0 + 400 * DAY });
    const recent = record();
    await calls({ calls: [old, ahead, recent] });
    cleanUp(t.deps.db, t.now());
    expect(kept().sort()).toEqual([ahead.id, recent.id].sort());
    updateSettings(t.deps.db, { callDays: 7 });
    t.advance(8 * DAY);
    cleanUp(t.deps.db, t.now());
    expect(kept()).toEqual([]);
    expect(() => updateSettings(t.deps.db, { callDays: 0 })).toThrow();
    expect(() => updateSettings(t.deps.db, { callDays: 366 })).toThrow();
  });
});
