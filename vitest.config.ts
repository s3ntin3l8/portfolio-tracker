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
        // Entrypoints / CLIs — covered by e2e or not unit-testable.
        "services/api/src/server.ts",
        "services/api/src/db/seed.ts",
        "services/api/src/db/migrate.ts",
        "services/api/src/db/scrape.ts",
        // Provider wiring depends on env keys + network; covered by live use.
        "services/api/src/services/market-data.ts",
        // pg-boss glue needs external Postgres; the refresh logic it runs
        // (refresh.ts / market-hours.ts) is unit-tested independently.
        "services/api/src/services/scheduler.ts",
        // Web: app router shells + i18n. The React components are RTL-tested, but v8
        // can't reliably instrument JSX in the aggregate run, so they're kept out of
        // the % gate (their tests still run). Pure web logic (lib/) stays gated.
        "apps/web/src/app/**",
        "apps/web/src/proxy.ts",
        "apps/web/src/i18n/**",
        "apps/web/src/components/**",
        // NextAuth framework config (provider wiring) — covered by live login / e2e.
        "apps/web/src/auth.ts",
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
