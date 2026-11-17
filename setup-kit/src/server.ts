// The setup kit's page, served on this computer only, at http://localhost:8090: localhost is a
// secure context, so the browser offers WebUSB there. The server only hands out the page (built
// into dist/web, nothing from the internet), the plan, and the APK the kit built; the page talks
// to the phone itself, and nothing here talks to the phone, the family's server or the internet.

import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface KitOptions {
  /** dist/web: index.html, app.js, style.css. */
  webDir: string;
  planPath: string;
  /** The APK the kit built (BELAY_KIT_APK), if any. */
  apkPath?: string | undefined;
}

const PAGE_FILES: Record<string, [string, string]> = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
};

const HEADERS: Record<string, string> = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Permissions-Policy": "usb=(self)",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
};

/**
 * Only for this computer's own names. Another website can't reach the page through a name of
 * its own that points here (DNS rebinding): its requests carry its name.
 */
export function isLocalHost(host: string | undefined): boolean {
  const name = (host ?? "").replace(/:\d+$/, "").toLowerCase();
  return name === "localhost" || name === "127.0.0.1" || name === "[::1]";
}

export function createKitServer(options: KitOptions): Server {
  return createServer((req, res) => {
    handle(req, res, options).catch((e: unknown) => {
      if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", `Something went wrong: ${e instanceof Error ? e.message : String(e)}\n`);
      else res.destroy();
    });
  });
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void {
  res.writeHead(status, { ...HEADERS, "Content-Type": type, ...extra });
  res.end(body);
}

async function apkFile(options: KitOptions): Promise<{ path: string; size: number } | undefined> {
  if (options.apkPath === undefined || options.apkPath === "") return undefined;
  try {
    const s = await stat(options.apkPath);
    return s.isFile() ? { path: options.apkPath, size: s.size } : undefined;
  } catch {
    return undefined;
  }
}

async function handle(req: IncomingMessage, res: ServerResponse, options: KitOptions): Promise<void> {
  if (!isLocalHost(req.headers.host)) {
    send(res, 421, "text/plain; charset=utf-8", "Open this page as http://localhost:8090, on the computer that runs the setup kit.\n");
    return;
  }
  if (req.method !== "GET" && req.method !== "HEAD") {
    send(res, 405, "text/plain; charset=utf-8", "Only GET.\n", { Allow: "GET, HEAD" });
    return;
  }
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  const page = PAGE_FILES[path];
  if (path === "/favicon.ico") {
    // Browsers ask for one; there isn't one.
    res.writeHead(204, HEADERS);
    res.end();
  } else if (page !== undefined) {
    send(res, 200, page[1], await readFile(join(options.webDir, page[0])));
  } else if (path === "/plan.json") {
    send(res, 200, "application/json; charset=utf-8", await readFile(options.planPath));
  } else if (path === "/kit/apk.json") {
    const apk = await apkFile(options);
    const body = apk === undefined ? { available: false } : { available: true, name: basename(apk.path), size: apk.size };
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(body));
  } else if (path === "/kit/belay.apk") {
    const apk = await apkFile(options);
    if (apk === undefined) {
      send(res, 404, "text/plain; charset=utf-8", "The kit hasn't built an APK.\n");
      return;
    }
    res.writeHead(200, {
      ...HEADERS,
      "Content-Type": "application/vnd.android.package-archive",
      "Content-Length": String(apk.size),
      "Content-Disposition": `attachment; filename="${basename(apk.path).replace(/[^A-Za-z0-9._-]/g, "_")}"`,
    });
    if (req.method === "HEAD") res.end();
    else createReadStream(apk.path).pipe(res);
  } else {
    send(res, 404, "text/plain; charset=utf-8", "Not here.\n");
  }
}

// node dist/server.js: BELAY_KIT_HOST (default 127.0.0.1; the container uses 0.0.0.0 behind
// -p 127.0.0.1:8090:8090), BELAY_KIT_PORT (8090), BELAY_KIT_APK, BELAY_KIT_PLAN.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const host = process.env.BELAY_KIT_HOST ?? "127.0.0.1";
  const port = Number.parseInt(process.env.BELAY_KIT_PORT ?? "8090", 10);
  const server = createKitServer({
    webDir: fileURLToPath(new URL("./web/", import.meta.url)),
    planPath: process.env.BELAY_KIT_PLAN ?? fileURLToPath(new URL("../../android/scripts/provision-plan.json", import.meta.url)),
    apkPath: process.env.BELAY_KIT_APK,
  });
  server.listen(port, host, () => {
    process.stdout.write(
      `\nBelay setup kit: open http://localhost:${port} in Chrome or Edge on this computer.\n` +
        "(Firefox and Safari can't talk to a phone over USB.) Press Ctrl+C here when you're done.\n",
    );
  });
  process.on("SIGTERM", () => server.close());
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}
