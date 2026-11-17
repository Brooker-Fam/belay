/** The MCP endpoint: Streamable HTTP, stateless, behind OAuth bearer tokens or personal access tokens. */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Deps } from "../deps.js";
import { bearerToken, type Bindings } from "../http.js";
import { canonicalResource, mcpUrl, resourceMetadataUrl } from "../oauth/routes.js";
import { SCOPE, grantForAccessToken, touchGrant } from "../oauth/store.js";
import { buildMcpServer } from "./server.js";

export function mcpRoutes(deps: Deps): Hono<{ Bindings: Bindings }> {
  const { db, config } = deps;
  const app = new Hono<{ Bindings: Bindings }>();
  const resource = mcpUrl(config.publicUrl);
  const challenge = (error?: string) =>
    `Bearer resource_metadata="${resourceMetadataUrl(config.publicUrl)}", scope="${SCOPE}"${error ? `, error="${error}"` : ""}`;

  app.use(
    "/mcp",
    cors({
      origin: "*",
      allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
      allowHeaders: ["Authorization", "Content-Type", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID"],
      exposeHeaders: ["WWW-Authenticate", "Mcp-Session-Id"],
      maxAge: 86400,
    }),
  );

  app.all("/mcp", async (c) => {
    const token = bearerToken(c.req.header("authorization"));
    const now = deps.now();
    const grant = token ? grantForAccessToken(db, token, now) : null;
    if (!grant || canonicalResource(grant.resource) !== canonicalResource(resource)) {
      c.header("WWW-Authenticate", challenge(token ? "invalid_token" : undefined));
      return c.json({ error: "invalid_token", error_description: token ? "The token is invalid, expired or revoked" : "Sign in to Belay first" }, 401);
    }
    if (c.req.method !== "POST") {
      c.header("Allow", "POST");
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "This server is stateless: send JSON-RPC with POST" } }, 405);
    }
    const verdict = deps.limits.mcpPerGrant.hit(grant.id);
    if (!verdict.ok) {
      c.header("Retry-After", String(verdict.retryAfterSeconds));
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Too many requests; wait a moment" } }, 429);
    }
    touchGrant(db, grant.id, now);

    const server = buildMcpServer(deps, { parentId: grant.parentId, parentName: grant.parentName, clientName: grant.clientName });
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw, {
        authInfo: { token: token ?? "", clientId: grant.clientId ?? grant.id, scopes: [grant.scope], resource: new URL(grant.resource) },
      });
    } finally {
      await transport.close();
      await server.close();
    }
  });

  return app;
}
