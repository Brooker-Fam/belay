import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import type { z } from "zod";

/** Under @hono/node-server the request's socket is in c.env; tests have none. */
export type Bindings = Partial<HttpBindings>;

/**
 * The client's address, for rate limits. Behind one reverse proxy (BELAY_TRUST_PROXY) it is
 * the last X-Forwarded-For entry, the one the proxy added. Never stored.
 */
export function clientAddress<E extends { Bindings: Bindings }>(c: Context<E>, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = c.req.header("x-forwarded-for");
    const last = forwarded?.split(",").at(-1)?.trim();
    if (last) return last;
  }
  // c.env is missing when a test calls app.request() directly.
  return (c.env as Bindings | undefined)?.incoming?.socket.remoteAddress ?? "unknown";
}

export type JsonResult<T> = { ok: true; value: T } | { ok: false; description: string };

/** Reads a JSON body and checks it against a schema. The error names a field, never a value. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<JsonResult<z.infer<S>>> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { ok: false, description: "Content-Type must be application/json" };
  let body: unknown;
  try {
    body = JSON.parse(await c.req.text());
  } catch {
    return { ok: false, description: "The body isn't valid JSON" };
  }
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "body";
  const what = issue?.code === "unrecognized_keys" ? `unknown field ${issue.keys.map((k) => `"${k}"`).join(", ")}` : (issue?.message ?? "invalid");
  return { ok: false, description: `${where}: ${what}`.slice(0, 300) };
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}
