/**
 * npm run demo (docs/demo.md) is never part of a real server: the build compiles only src/, nothing
 * in src/ imports the demo, the image copies only the server, and a built dist/ has none of it.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const SERVER = join(import.meta.dirname, "..");

describe("the server's build and image", () => {
  it("compile only src/: nothing from demo/", () => {
    const file = join(SERVER, "tsconfig.build.json");
    const parsed = ts.getParsedCommandLineOfConfigFile(file, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: () => undefined });
    const files = (parsed?.fileNames ?? []).map((f) => relative(SERVER, f));
    expect(files.length).toBeGreaterThan(50);
    expect(files.filter((f) => !f.startsWith("src/"))).toEqual([]);
    expect(parsed?.options.rootDir && relative(SERVER, parsed.options.rootDir)).toBe("src");
  });

  it("have nothing in src/ that imports the demo", () => {
    const sources = (dir: string): string[] =>
      readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? sources(path) : /\.tsx?$/.test(name) ? [path] : [];
      });
    const importers = sources(join(SERVER, "src")).filter((path) => /["'](\.\.\/)+demo\//.test(readFileSync(path, "utf8")));
    expect(importers).toEqual([]);
  });

  it("copy only the server into the image, and leave demo/ out of its build context", () => {
    const dockerfile = readFileSync(join(SERVER, "Dockerfile"), "utf8");
    const copied = [...dockerfile.matchAll(/^COPY\s+(?!--from)(.+?)\s+\S+\s*$/gm)].flatMap((m) => (m[1] ?? "").split(/\s+/));
    expect(copied.sort()).toEqual(["package-lock.json", "package.json", "scripts", "src", "tsconfig.build.json", "tsconfig.json"]);
    const ignored = readFileSync(join(SERVER, ".dockerignore"), "utf8").split("\n").map((l) => l.trim());
    expect(ignored).toContain("demo");
  });

  it("leave a built dist/ without the demo, when there is one (npm run build makes it)", () => {
    const dist = join(SERVER, "dist");
    if (!existsSync(dist)) return;
    const files = readdirSync(dist, { recursive: true, encoding: "utf8" });
    expect(files.filter((f) => /(^|[/\\])demo([/\\]|$)/.test(f))).toEqual([]);
    const js = files.filter((f) => f.endsWith(".js"));
    expect(js.length).toBeGreaterThan(50);
    expect(js.filter((f) => /SimPhone|seedDemo|openDemoDir/.test(readFileSync(join(dist, f), "utf8")))).toEqual([]);
  });
});
