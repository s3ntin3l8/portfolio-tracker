import { defineConfig } from "vitest/config";

// Root config runs every workspace as a Vitest "project" and aggregates coverage
// into a single report with a 70% gate. Run via `npm test` / `npm run test:coverage`.
export default defineConfig({
  test: {
    projects: [
      "services/*/vitest.config.ts",
      "packages/*/vitest.config.ts",
      "apps/web/vitest.config.ts",
    ],
    coverage: {
      provider: "v8",
      all: true,
      reporter: ["text", "json-summary", "json", "html"],
      reportsDirectory: "./coverage",
      include: [
        "services/*/src/**/*.{ts,tsx}",
        "packages/*/src/**/*.{ts,tsx}",
        "apps/web/src/**/*.{ts,tsx}",
      ],
      exclude: [
        "**/*.d.ts",
        "**/*.config.*",
        "**/dist/**",
        // Entrypoints / CLIs / framework boilerplate — covered by e2e or not unit-testable.
        "services/api/src/server.ts",
        "services/api/src/db/seed.ts",
        "apps/web/src/app/**",
        "apps/web/src/middleware.ts",
        "apps/web/src/i18n/**",
      ],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
