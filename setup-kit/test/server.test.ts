// The kit's local web server: what it serves, to whom, and with which headers.

import { mkdtempSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createKitServer, isLocalHost } from "../src/server.js";

const dir = mkdtempSync(join(tmpdir(), "belay-kit-"));
const web = join(dir, "web");
writeFileSync(join(dir, "plan.json"), '{"format": 1}');
const apk = join(dir, "app-release.apk");

let base = "";
let closeServer: () => Promise<void>;

async function get(path: string, init: RequestInit & { host?: string } = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  // fetch won't set Host itself, so this goes through node:http directly.
  const { request } = await import("node:http");
  return new Promise((resolve, reject) => {
    const url = new URL(path, base);
    const req = request(
      { host: url.hostname, port: url.port, path: url.pathname, method: init.method ?? "GET", headers: { ...Object.fromEntries(headers), host: init.host ?? url.host } },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const flat: [string, string][] = Object.entries(res.headers).map(([k, v]) => [k, String(v)]);
          resolve(new Response(res.statusCode === 204 ? null : Buffer.concat(chunks), { status: res.statusCode ?? 0, headers: flat }));
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

beforeAll(async () => {
  const { mkdirSync } = await import("node:fs");
  mkdirSync(web);
  writeFileSync(join(web, "index.html"), "<!doctype html><title>kit</title>");
  writeFileSync(join(web, "app.js"), "export {};");
  writeFileSync(join(web, "style.css"), "body{}");
  const server = createKitServer({ webDir: web, planPath: join(dir, "plan.json"), apkPath: apk });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  closeServer = () =>
    new Promise((resolve) => {
      server.close(() => {
        resolve();
      });
    });
});
afterAll(() => closeServer());

describe("the kit's web server", () => {
  it("serves the page, with a strict content security policy", async () => {
    const res = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await res.text()).toContain("<title>kit</title>");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("connect-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("permissions-policy")).toBe("usb=(self)");
  });

  it("serves the script, the styles and the plan", async () => {
    expect((await get("/app.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await get("/style.css")).headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(await (await get("/plan.json")).json()).toEqual({ format: 1 });
  });

  it("only answers to this computer's own names (no DNS rebinding)", async () => {
    for (const host of ["localhost:8090", "127.0.0.1:8090", "[::1]:8090", "LOCALHOST"]) expect((await get("/", { host })).status).toBe(200);
    for (const host of ["belay.example.org", "localhost.example.org:8090", "192.168.1.20:8090", "attacker.example:8090"]) {
      const res = await get("/", { host });
      expect(res.status).toBe(421);
      expect(await res.text()).toContain("http://localhost:8090");
    }
    expect(isLocalHost(undefined)).toBe(false);
  });

  it("has no icon, without an error for the browser's console", async () => {
    expect((await get("/favicon.ico")).status).toBe(204);
  });

  it("only takes GET and HEAD", async () => {
    expect((await get("/", { method: "POST" })).status).toBe(405);
    expect((await get("/", { method: "HEAD" })).status).toBe(200);
  });

  it("says when it has no APK, and hands out the one it has", async () => {
    expect(await (await get("/kit/apk.json")).json()).toEqual({ available: false });
    expect((await get("/kit/belay.apk")).status).toBe(404);
    writeFileSync(apk, Buffer.from("PK fake apk"));
    expect(await (await get("/kit/apk.json")).json()).toEqual({ available: true, name: "app-release.apk", size: 11 });
    const res = await get("/kit/belay.apk");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/vnd.android.package-archive");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="app-release.apk"');
    expect(await res.text()).toBe("PK fake apk");
  });

  it("has nothing else: it only serves the paths it names", async () => {
    for (const path of ["/index.html", "/web/app.js", "/kit/", "/keys/belay-release.p12", "/signing.properties", "/app.js.map"]) {
      expect((await get(path)).status).toBe(404);
    }
  });
});
