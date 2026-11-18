/**
 * For the demo's tests (docs/demo.md): every device API request the simulated phone makes, checked
 * against the server's own schemas before the server sees it.
 */
import type { z } from "zod";
import {
  CallsRequest,
  CheckinRequest,
  EnrollRequest,
  EventsRequest,
  InventoryRequest,
  LocationsRequest,
  MobileDataRequest,
  NetworkRequest,
  PolicyQuery,
  RequestsRequest,
  UsageRequest,
} from "../src/device/schemas.js";
import type { TestServer } from "./helpers.js";

const SCHEMAS: Record<string, z.ZodType> = {
  enroll: EnrollRequest,
  checkin: CheckinRequest,
  inventory: InventoryRequest,
  events: EventsRequest,
  requests: RequestsRequest,
  usage: UsageRequest,
  calls: CallsRequest,
  locations: LocationsRequest,
  network: NetworkRequest,
  "mobile-data": MobileDataRequest,
};

export interface Sent {
  endpoint: string;
  /** Why the schema refused it, or null. */
  problem: string | null;
}

/** One request the phone made, checked: its endpoint, and why its schema refused it, if it did. */
export function checkRequest(method: string, url: string, body: string | null): Sent {
  const { pathname, searchParams } = new URL(url);
  const endpoint = pathname.replace(/^\/api\/v1\//, "");
  if (method === "GET") {
    const query = PolicyQuery.safeParse(Object.fromEntries(searchParams));
    return { endpoint, problem: endpoint === "policy" && query.success ? null : `GET ${endpoint}` };
  }
  const schema = SCHEMAS[endpoint];
  if (!schema) return { endpoint, problem: `no such endpoint: ${endpoint}` };
  const parsed = schema.safeParse(body === null ? undefined : JSON.parse(body));
  return { endpoint, problem: parsed.success ? null : `${endpoint}: ${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}` };
}

/** The server's app in this process, as the phone's network: each request checked first. */
export function checkedFetch(t: TestServer, sent: Sent[]): typeof fetch {
  return async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    sent.push(checkRequest(init?.method ?? "GET", url, typeof init?.body === "string" ? init.body : null));
    return t.app.request(url, init);
  };
}

/** Waits for something the phone does on its own, polling every 20 ms. */
export async function until(done: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!done()) {
    if (Date.now() > end) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
