import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    // PGlite (embedded Postgres) has a multi-second cold start; give DB-backed
    // tests room under parallel load.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
