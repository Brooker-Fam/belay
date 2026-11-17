import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return path.endsWith(".ts") || path.endsWith(".tsx") ? [path] : [];
  });
}

describe("write transactions", () => {
  // The CLI runs in a second process: a deferred transaction that reads before it writes fails with
  // SQLITE_BUSY_SNAPSHOT when the server commits in between, instead of waiting (db.ts).
  it("all take the write lock first", () => {
    const deferred = sources(join(import.meta.dirname, "..", "src")).filter((path) => {
      const text = readFileSync(path, "utf8");
      const opened = text.match(/\bdb\.transaction\(/g)?.length ?? 0;
      const immediate = text.match(/\.immediate\(\)/g)?.length ?? 0;
      return opened !== immediate;
    });
    expect(deferred).toEqual([]);
  });
});
