/** A family for the Getting started tests: two parents signed in, and no backup passphrase yet. Made-up names only. */
import { policyVersion } from "../src/family/policy.js";
import { gettingStarted, type StartStep } from "../src/family/start.js";
import { setOpsOptions } from "../src/ops/options.js";
import { updateSettings } from "../src/settings.js";
import { device, deviceCall, get, postForm, signIn, testServer } from "./helpers.js";

export const MCP = "https://belay.example.org/mcp";
export const PASSPHRASE = "four made-up words for the backups";
/** Settings' Family form, with what AI apps may read as the defaults have it. */
export const SETTINGS = { timezone: "America/New_York", silent_hours: "12", ai_scope: ["apps", "device_status", "requests", "screen_time", "agreement", "mobile_data"] };

export async function family() {
  const t = testServer();
  updateSettings(t.deps.db, { timezone: "America/New_York" });
  // The server's backup passphrase comes from here, as the daily backup reads it: none to start with.
  setOpsOptions(t.deps, { env: {} });
  const sam = await signIn(t);
  const alex = await signIn(t, "alex", "Alex");
  type Who = typeof sam;
  const form = (path: string, fields: Record<string, string | string[]> = {}, who: Who = sam) => postForm(t, path, { _csrf: who.csrf, ...fields }, { cookie: who.cookie });
  const page = async (path = "/", who: Who = sam) => {
    const res = await get(t, path, who.cookie);
    return { status: res.status, html: await res.text(), location: res.headers.get("location") };
  };
  const start = (who: Who = sam) => gettingStarted(t.deps, who.parent.id);
  const states = (who: Who = sam) => Object.fromEntries(start(who).steps.map((s) => [s.id, s.state]));
  const step = <K extends StartStep["id"]>(id: K, who: Who = sam): Extract<StartStep, { id: K }> => {
    const found = start(who).steps.find((s): s is Extract<StartStep, { id: K }> => s.id === id);
    if (!found) throw new Error(`no step ${id}`);
    return found;
  };
  /** The phone reports the rules it applied, as a check-in does. */
  const applied = (phone: { token: string; deviceId: string }) =>
    deviceCall(t, phone.token, "checkin", { status: device({ enforcement: { policy_version: policyVersion(t.deps.db, phone.deviceId) } }) });
  return { t, sam, alex, form, page, start, states, step, applied };
}
