import { tmpdir } from "node:os";
import { join } from "node:path";

/** Settings that come from the environment (docs/server.md lists them). */
export interface Config {
  /** The server's public origin, e.g. https://belay.example.org. Phones, QR codes and OAuth use it. */
  publicUrl: string;
  /** Where the SQLite database lives. */
  dataDir: string;
  /** Phase 6: where the versions of Belay a parent may offer the phones are kept, as <sha256>.apk (in the data directory). */
  agentsDir: string;
  host: string;
  port: number;
  /** Behind one reverse proxy (Caddy): take the client address from the last X-Forwarded-For entry. */
  trustProxy: boolean;
  /** Extra OAuth redirect URIs to allow, exactly as written. They get no refresh tokens. */
  extraRedirectUris: string[];
  /** Cookies get the Secure flag (and the __Host- prefix) when the public URL is https. */
  secureCookies: boolean;
  /**
   * "Demo: a made-up family. Nothing here is real." on every page (BELAY_DEMO_BANNER=1). Only
   * `npm run demo` sets it (docs/demo.md), and it changes nothing else.
   */
  demoBanner: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

const PRIVATE_V4 = [/^127\./, /^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./];

/** Loopback or a private address: plain http is allowed there, for testing. */
export function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return host === "localhost" || host.endsWith(".localhost") || host === "::1" || PRIVATE_V4.some((re) => re.test(host));
}

export function parsePublicUrl(value: string | undefined): string {
  if (!value?.trim()) {
    throw new ConfigError("BELAY_PUBLIC_URL is not set. Set it to the server's public address, like https://belay.example.org");
  }
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new ConfigError(`BELAY_PUBLIC_URL isn't a URL: ${value}`);
  }
  if (url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) {
    throw new ConfigError("BELAY_PUBLIC_URL must be just the origin, like https://belay.example.org (no path or query)");
  }
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new ConfigError("BELAY_PUBLIC_URL must use https. Plain http is only for localhost and private addresses, for testing");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigError("BELAY_PUBLIC_URL must use https");
  }
  return url.origin;
}

function parseRedirects(value: string | undefined): string[] {
  if (!value?.trim()) return [];
  return value.split(",").map((entry) => {
    const uri = entry.trim();
    let url: URL;
    try {
      url = new URL(uri);
    } catch {
      throw new ConfigError(`BELAY_EXTRA_REDIRECT_URIS has an entry that isn't a URL: ${uri}`);
    }
    if (url.protocol !== "https:" || url.hash || url.username || url.password) {
      throw new ConfigError(`BELAY_EXTRA_REDIRECT_URIS entries must be https URLs without a fragment: ${uri}`);
    }
    return uri;
  });
}

function parsePort(value: string | undefined): number {
  if (!value) return 8080;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ConfigError(`BELAY_PORT isn't a port: ${value}`);
  return port;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const publicUrl = parsePublicUrl(env.BELAY_PUBLIC_URL);
  const dataDir = env.BELAY_DATA_DIR?.trim() || "./data";
  return {
    publicUrl,
    dataDir,
    agentsDir: join(dataDir, "agents"),
    host: env.BELAY_HOST?.trim() || "127.0.0.1",
    port: parsePort(env.BELAY_PORT),
    trustProxy: env.BELAY_TRUST_PROXY === "1" || env.BELAY_TRUST_PROXY === "true",
    extraRedirectUris: parseRedirects(env.BELAY_EXTRA_REDIRECT_URIS),
    secureCookies: publicUrl.startsWith("https:"),
    demoBanner: env.BELAY_DEMO_BANNER === "1",
  };
}

/** A config for tests and tools. Tests that store APKs pass an `agentsDir` of their own. */
export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    publicUrl: "https://belay.example.org",
    dataDir: ":memory:",
    agentsDir: join(tmpdir(), `belay-test-agents-${process.pid}`),
    host: "127.0.0.1",
    port: 8080,
    trustProxy: true,
    extraRedirectUris: [],
    secureCookies: true,
    demoBanner: false,
    ...overrides,
  };
}
