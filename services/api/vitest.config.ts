import path from "node:path";
import { defineConfig } from "vitest/config";

const pkg = (name: string) =>
  path.resolve(import.meta.dirname, `../../packages/${name}/src/index.ts`);

export default defineConfig({
  resolve: {
    // Resolve workspace packages to their TS source so tests need no prior build.
    alias: {
      "@portfolio/db": pkg("db"),
      "@portfolio/core": pkg("core"),
      "@portfolio/schema": pkg("schema"),
    },
  },
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
