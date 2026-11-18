/**
 * The prompts follow the categories a parent lets AI apps read, read each time a prompt is asked
 * for: a prompt never asks for a category that's off, says in one line that it's off, and has a
 * category's section only while it's on. Through the MCP client, as mcp.test.ts. Made-up names.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { describe, expect, it } from "vitest";
import { createParent } from "../src/auth/parents.js";
import { NETWORK_REMINDER } from "../src/mcp/network.js";
import { createPersonalToken } from "../src/oauth/store.js";
import { type AiScope, AI_SCOPES, updateSettings } from "../src/settings.js";
import { enrollPhone, testServer } from "./helpers.js";

const MCP = "https://belay.example.org/mcp";
const ALL = Object.keys(AI_SCOPES) as AiScope[];

async function family() {
  const t = testServer();
  const parent = await createParent(t.deps.db, t.now(), { name: "Sam", username: "sam", password: "correct horse battery staple" });
  await enrollPhone(t, "Robin's phone");
  const { token } = createPersonalToken(t.deps.db, t.now(), parent.id, "Claude", MCP);
  const client = new Client({ name: "belay-test", version: "1.0.0" });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(MCP), {
      fetch: (url, init) => Promise.resolve(t.app.request(String(url), init)),
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  );
  /** The prompt's text with exactly these categories on. */
  const prompt = async (name: string, on: readonly AiScope[], args: Record<string, string> = {}) => {
    updateSettings(t.deps.db, { aiScopes: Object.fromEntries(ALL.map((s) => [s, on.includes(s)])) });
    const res = await client.getPrompt({ name, arguments: args });
    return (res.messages[0]?.content as { text: string }).text;
  };
  return { t, client, prompt };
}

const but = (scope: AiScope) => ALL.filter((s) => s !== scope);

/** What each category's part of weekly_review asks for: the tools that need it. */
const WEEKLY_TOOLS: Record<Exclude<AiScope, "agreement">, { asks: string; never: string[] }> = {
  requests: { asks: "list_requests with kind help", never: ["list_requests"] },
  device_status: { asks: "get_device_status", never: ["get_device_status"] },
  apps: { asks: "get_app_changes", never: ["get_app_changes", "list_unreviewed_apps", "get_installed_apps", "mark_apps_reviewed", "block_app", "propose_change"] },
  calls: { asks: "get_calls", never: ["get_calls", "get_contacts", "change_calls"] },
  location: { asks: "get_place_events", never: ["get_place_events", "get_location", "locate_now"] },
  network: { asks: "get_network_activity", never: ["get_network_activity"] },
  screen_time: { asks: "get_screen_time", never: ["get_screen_time"] },
};

const OFF_WORDS: Record<AiScope, string> = {
  apps: "apps",
  device_status: "device status",
  requests: "the kid's requests",
  screen_time: "screen time",
  agreement: "the stage and agreement",
  location: "location",
  calls: "calls",
  network: "network activity",
};

describe("weekly_review", () => {
  it("with every category on, leads with what needs the parent, then a short section for each", async () => {
    const { prompt } = await family();
    const text = await prompt("weekly_review", ALL);
    const order = ["Help requests:", "Phones' health:", "Waiting for the parent:", "Apps:", "Calls:", "Location:", "Network:", "Screen time:"].map((s) => text.indexOf(s));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain('Lead with what needs the parent: an "I need help" no parent has seen, then a phone that needs attention, then what waits for their answer.');
    expect(text).toContain("Leave out a section with nothing in it.");
    expect(text).not.toContain("turned off AI access");
    for (const { asks } of Object.values(WEEKLY_TOOLS)) expect(text).toContain(asks);
    // Help: urgent, and never a guess.
    expect(text).toContain('"I need help" is urgent');
    expect(text).toContain("tell the parent to look now");
    expect(text).toContain("Never guess why the kid asked.");
    // The phones' health, the reports of someone getting around Belay first.
    expect(text).toContain("Put first any sign that someone may be getting around Belay (another user or profile, a proxy on its network, wireless debugging, a different signing key)");
    expect(text).toContain("without guessing who did it or why");
    // Calls: only the numbers get_calls gives, which are never 911, 988, emergency or private ones.
    expect(text).toContain("someone who isn't a contact, or with no caller ID, that Belay refused or sent to voicemail");
    expect(text).toContain("the contact requests waiting");
    expect(text).toContain("Show no other numbers");
    expect(text).toContain("Belay never records calls with 911, 988, an emergency number or a private number");
    // Location: arrivals and departures, as facts, and never a check that the kid would be shown.
    expect(text).toContain("list the arrivals and departures as facts");
    expect(text).toContain("Don't call locate_now");
    // Network: the week's top domains per app, with get_network_activity's own reminder.
    expect(text).toContain("the week's top few domains");
    expect(text).toContain(NETWORK_REMINDER);
    expect(text).toContain("Screen time is a number, not a verdict about the kid");
  });

  it("never asks for a category that's off, says so in one line, and has its section only while it's on", async () => {
    const { prompt } = await family();
    for (const [scope, { asks, never }] of Object.entries(WEEKLY_TOOLS) as [AiScope, { asks: string; never: string[] }][]) {
      const text = await prompt("weekly_review", but(scope));
      for (const tool of never) expect(text, `${scope} off: ${tool}`).not.toContain(tool);
      expect(text, scope).toContain(`A parent turned off AI access to ${OFF_WORDS[scope]} in Belay's settings: say so in one line, and leave it out.`);
      expect(text.match(/turned off AI access/g), scope).toHaveLength(1);
      // Every other category's section is still there.
      for (const [other, { asks: also }] of Object.entries(WEEKLY_TOOLS)) if (other !== scope) expect(text, `${scope} off: ${other}`).toContain(also);
      expect(await prompt("weekly_review", [scope]), scope).toContain(asks);
    }
  });

  it("with every category off, keeps what's always there: the phones' status and problems, and proposals waiting", async () => {
    const { prompt } = await family();
    const text = await prompt("weekly_review", []);
    for (const { never } of Object.values(WEEKLY_TOOLS)) for (const tool of never) expect(text).not.toContain(tool);
    expect(text).toContain("Phones' health: call list_devices.");
    expect(text).toContain("someone may be getting around Belay");
    expect(text).toContain("Waiting for the parent: call get_policy for each phone");
    expect(text).not.toContain("I need help");
    expect(text).toContain(
      "A parent turned off AI access to the kid's requests, device status, apps, calls, location, network activity and screen time in Belay's settings: say so in one line, and leave them out.",
    );
    // The stage and agreement aren't part of it, on or off.
    expect(await prompt("weekly_review", but("agreement"))).toBe(await prompt("weekly_review", ALL));
  });

  it("follows the settings as they are when it's asked for: a new family's starts without calls, location or network", async () => {
    const { t, client } = await family();
    const text = async () => ((await client.getPrompt({ name: "weekly_review" })).messages[0]?.content as { text: string }).text;
    const fresh = await text();
    expect(fresh).toContain("A parent turned off AI access to calls, location and network activity in Belay's settings: say so in one line, and leave them out.");
    expect(fresh).not.toContain("get_calls");
    updateSettings(t.deps.db, { aiScopes: { calls: true } });
    const later = await text();
    expect(later).toContain("call get_calls for the last 7 days");
    expect(later).toContain("A parent turned off AI access to location and network activity");
  });
});
