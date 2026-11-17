import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: { jsx: { runtime: "automatic", importSource: "hono/jsx" } },
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "node",
    // Each test file gets its own in-memory database; argon2 makes login tests slow-ish.
    testTimeout: 20_000,
  },
});
