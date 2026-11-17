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

/** Reads a JSON body, unchecked: for a route that looks at it before checking it (readJson checks it too). */
export async function readJsonBody(c: Context): Promise<JsonResult<unknown>> {
  const type = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (type !== "application/json") return { ok: false, description: "Content-Type must be application/json" };
  try {
    return { ok: true, value: JSON.parse(await c.req.text()) as unknown };
  } catch {
    return { ok: false, description: "The body isn't valid JSON" };
  }
}

/** Checks a value against a schema. The error names a field, never a value. */
export function checkJson<S extends z.ZodType>(schema: S, body: unknown): JsonResult<z.infer<S>> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issue = parsed.error.issues[0];
  const where = issue?.path.length ? issue.path.join(".") : "body";
  const what = issue?.code === "unrecognized_keys" ? `unknown field ${issue.keys.map((k) => `"${k}"`).join(", ")}` : (issue?.message ?? "invalid");
  return { ok: false, description: `${where}: ${what}`.slice(0, 300) };
}

/** Reads a JSON body and checks it against a schema. The error names a field, never a value. */
export async function readJson<S extends z.ZodType>(c: Context, schema: S): Promise<JsonResult<z.infer<S>>> {
  const body = await readJsonBody(c);
  return body.ok ? checkJson(schema, body.value) : body;
}

/**
 * One byte range of a file of `size` bytes (RFC 9110, section 14): `bytes=N-`, `bytes=N-M` or
 * `bytes=-N` as [start, end], inclusive; "unsatisfiable" when it's past the end or backwards; null
 * to send the whole file, for no Range, or one this server doesn't serve (several ranges, other
 * units, a malformed one), which RFC 9110 lets a server ignore.
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | "unsatisfiable" | null {
  const match = header === undefined ? null : /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  const [, from = "", to = ""] = match;
  if (from === "") {
    const last = Number(to);
    return last === 0 || size === 0 ? "unsatisfiable" : { start: Math.max(0, size - last), end: size - 1 };
  }
  const start = Number(from);
  if (start >= size || (to !== "" && Number(to) < start)) return "unsatisfiable";
  return { start, end: to === "" ? size - 1 : Math.min(Number(to), size - 1) };
}

export function bearerToken(header: string | undefined): string | null {
  const match = /^Bearer\s+([A-Za-z0-9._~+/-]+=*)\s*$/i.exec(header ?? "");
  return match?.[1] ?? null;
}
