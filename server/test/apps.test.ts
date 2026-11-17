import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { listApps, markReviewed } from "../src/family/apps.js";
import { deviceCall, enrollPhone, event, pkg, snapshot, testServer, T0 } from "./helpers.js";

const HOUR = 3_600_000;

async function setup() {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  const phone = await enrollPhone(t);
  await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps", { permissions: ["location"] }), pkg("com.android.settings", { system: true })], T0));
  const review = (packages: string[]) => markReviewed(t.deps.db, t.now(), { deviceId: phone.deviceId, packages, parentId: parent.id, via: "web" });
  const unreviewed = () => listApps(t.deps.db, phone.deviceId, { unreviewedOnly: true, includeSystem: true }).map((a) => [a.package, a.unreviewed]);
  return { t, phone, review, unreviewed };
}

describe("unreviewed apps", () => {
  it("are user apps nobody has reviewed; system apps never are", async () => {
    const { unreviewed } = await setup();
    expect(unreviewed()).toEqual([["com.example.maps", { kind: "new" }]]);
  });

  it("stop being new once reviewed, and updates don't bring them back", async () => {
    const { t, phone, review, unreviewed } = await setup();
    t.advance(HOUR);
    review(["com.example.maps"]);
    expect(unreviewed()).toEqual([]);
    t.advance(HOUR);
    await deviceCall(t, phone.token, "events", { events: [event("updated", "com.example.maps", { from: { code: 10 }, to: { code: 11 }, happened_at: T0 + 2 * HOUR })] });
    expect(unreviewed()).toEqual([]);
  });

  it("come back when the app is installed again after its review", async () => {
    const { t, phone, review, unreviewed } = await setup();
    t.advance(HOUR);
    review(["com.example.maps"]);
    t.advance(HOUR);
    await deviceCall(t, phone.token, "events", {
      events: [event("removed", "com.example.maps", { from: { code: 10 } }), event("installed", "com.example.maps", { to: { code: 10 }, happened_at: T0 + 2 * HOUR })],
    });
    expect(unreviewed()).toEqual([["com.example.maps", { kind: "reinstalled" }]]);
  });

  it("come back when the app gains a sensitive permission since its review", async () => {
    const { t, phone, review, unreviewed } = await setup();
    t.advance(HOUR);
    review(["com.example.maps"]);
    t.advance(HOUR);
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps", { permissions: ["location", "microphone", "camera"] }), pkg("com.android.settings", { system: true })], T0 + 2 * HOUR));
    expect(unreviewed()).toEqual([["com.example.maps", { kind: "permissions", gained: ["microphone", "camera"] }]]);
    // Losing one isn't a reason to look again.
    review(["com.example.maps"]);
    await deviceCall(t, phone.token, "inventory", snapshot([pkg("com.example.maps", { permissions: ["camera"] }), pkg("com.android.settings", { system: true })], T0 + 3 * HOUR));
    expect(unreviewed()).toEqual([]);
  });

  it("don't include removed apps", async () => {
    const { t, phone, unreviewed } = await setup();
    await deviceCall(t, phone.token, "events", { events: [event("removed", "com.example.maps", { from: { code: 10 } })] });
    expect(unreviewed()).toEqual([]);
  });

  it("keep every review, so the history explains each decision", async () => {
    const { t, review } = await setup();
    review(["com.example.maps"]);
    t.advance(HOUR);
    review(["com.example.maps"]);
    const rows = t.deps.db.prepare("SELECT COUNT(*) AS n FROM reviews").get() as { n: number };
    expect(rows.n).toBe(2);
  });
});
