# Phase 3 — File Decomposition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decompose 9 large files (>800 lines each) into focused sub-modules per issue #550 Phase 3.

**Architecture:** Each file is split along existing logical domain boundaries within its workspace. API routes follow the `transactions/` sub-route pattern. Web components extract into focused sub-components. Schema splits per domain table group.

**Tech Stack:** TypeScript, Drizzle ORM, Fastify, Next.js (App Router), shadcn/ui, React Server/Client Components

**PR:** Single PR, branch name `refactor/phase-3-decomposition`, one commit per task (9 commits). Base: `main`.

---

### Task 1: Decompose `packages/db/src/schema.ts` into per-domain schema files

**Files:**

- Delete: `packages/db/src/schema.ts` (1247 lines)
- Create: `packages/db/src/schema/enums.ts`
- Create: `packages/db/src/schema/users.ts`
- Create: `packages/db/src/schema/account-holders.ts`
- Create: `packages/db/src/schema/portfolios.ts`
- Create: `packages/db/src/schema/instruments.ts`
- Create: `packages/db/src/schema/screenshot-imports.ts`
- Create: `packages/db/src/schema/connections.ts`
- Create: `packages/db/src/schema/admin.ts`
- Create: `packages/db/src/schema/documents.ts`
- Create: `packages/db/src/schema/transactions.ts`
- Create: `packages/db/src/schema/anomalies-corp-actions.ts`
- Create: `packages/db/src/schema/loans.ts`
- Create: `packages/db/src/schema/dividends-prices.ts`
- Create: `packages/db/src/schema/snapshots.ts`
- Create: `packages/db/src/schema/targets-tax.ts`
- Create: `packages/db/src/schema/user-preferences.ts`
- Modify: `packages/db/src/index.ts` — export from each schema file instead of single barrel
- Modify: `packages/db/drizzle.config.ts` — change schema glob

- [ ] **Step 1: Create `schema/enums.ts`**

Extract all `pgEnum` definitions (lines 21–139) from schema.ts: `assetClassEnum`, `unitEnum`, `txTypeEnum`, `txStatusEnum`, `txSourceEnum`, `txSourceTypeEnum`, `corpActionTypeEnum`, `importStatusEnum`, `trConnectionStatusEnum`, `ibkrConnectionStatusEnum`, `dividendStatusEnum`, `lossPotEnum`.

- [ ] **Step 2: Create per-domain schema files**

Create `schema/users.ts`, `schema/account-holders.ts`, `schema/portfolios.ts`, `schema/instruments.ts`, `schema/screenshot-imports.ts`, `schema/connections.ts`, `schema/admin.ts`, `schema/documents.ts`, `schema/transactions.ts`, `schema/anomalies-corp-actions.ts`, `schema/loans.ts`, `schema/dividends-prices.ts`, `schema/snapshots.ts`, `schema/targets-tax.ts`, `schema/user-preferences.ts`.

Each file contains:

1. Import `pgTable`, `pgEnum`, `relations` from `drizzle-orm/pg-core`
2. Import needed enums from `./enums.js`
3. Import referenced tables from sibling files (e.g. `portfolios.ts` imports `users` and `accountHolders`)
4. The table definition
5. The relations definition (if any)

The table names are kept consistent. Relations use `() => TableName` lazy imports (already the pattern).

- [ ] **Step 3: Delete `schema.ts`, update `index.ts`**

Replace `export * from "./schema.js"` with `export * from "./schema/enums.js"` and `export * from "./schema/<domain>.js"` for all 16 domain files. Keep the `export { schema }` pattern and all type aliases.

- [ ] **Step 4: Update `drizzle.config.ts`**

Change `schema: "./src/schema.ts"` to `schema: "./src/schema/**/*.ts"`.

- [ ] **Step 5: Type-check and test**

Run `npm run typecheck --workspace @portfolio/db && npm run typecheck --workspace @portfolio/api && npm run db:generate`. Verify all imports resolve.

- [ ] **Step 6: Commit**

```bash
git add packages/db/
git commit -m "refactor: decompose db schema into per-domain files (16 files)"
```

---

### Task 2: Decompose `packages/core/src/income.ts` into sub-modules

**Files:**

- Modify: `packages/core/src/income.ts` — keep aggregate function + types + trailing helpers
- Create: `packages/core/src/growth.ts` — `inferIntervalMonths`, `computeGrowthFactor`, `MIN_PAYMENTS_FOR_GROWTH`, `monthsBetween`, `addUTCMonths`
- Create: `packages/core/src/coupons.ts` — `BondPosition`, `ProjectedCoupon`, `PERIODS_PER_YEAR`, `projectCoupons`
- Create: `packages/core/src/dividends.ts` — `ProjectedDividend`, `bucketMonthly`, `projectDividends`, `projectNextYearDividends`

- [ ] **Step 1: Create `growth.ts`**

Move `monthsBetween` (10-12), `addUTCMonths` (15-19), `inferIntervalMonths` (25-40), `MIN_PAYMENTS_FOR_GROWTH` (50), `computeGrowthFactor` (68-103).

- [ ] **Step 2: Create `coupons.ts`**

Move `BondPosition` (106-121), `ProjectedCoupon` (124-131), `PERIODS_PER_YEAR` (133-138), `projectCoupons` (148-194). Import `toDateKey` from `../date-utils.js`.

- [ ] **Step 3: Create `dividends.ts`**

Move `ProjectedDividend` (197-226), `bucketMonthly` (244-264), `projectDividends` (283-360), `projectNextYearDividends` (401-546). Import growth helpers from `./growth.js`.

- [ ] **Step 4: Update `income.ts`**

Remove extracted code. Keep types (578-681), `aggregateIncome` (683-844), `trailingIncomeByInstrument` (549-569), `trailingYield` (572-576). Import from `./growth.js`, `./coupons.js`, `./dividends.js`.

- [ ] **Step 5: Update `packages/core/src/index.ts`**

Add re-exports for new files if needed. Check existing barrel.

- [ ] **Step 6: Type-check and test**

Run `npm run typecheck --workspace @portfolio/core && npm test --workspace @portfolio/core`.

- [ ] **Step 7: Commit**

```bash
git add packages/core/src/
git commit -m "refactor: decompose income.ts into growth/coupons/dividends sub-modules"
```

---

### Task 3: Decompose `services/api/src/routes/admin.ts` into sub-routes

**Files:**

- Modify: `services/api/src/routes/admin.ts` — slim to aggregator (~250 lines)
- Create: `services/api/src/routes/admin/_shared.ts` — `listProviders`, `providersResponse` helpers
- Create: `services/api/src/routes/admin/providers.ts` — market-data provider routes
- Create: `services/api/src/routes/admin/vision-providers.ts` — vision LLM provider routes
- Create: `services/api/src/routes/admin/storage.ts` — storage provider routes
- Create: `services/api/src/routes/admin/jobs.ts` — background jobs routes
- Create: `services/api/src/routes/admin/users.ts` — user management routes

- [ ] **Step 1: Create `_shared.ts`**

Extract `listProviders()` and `providersResponse()` helper functions (lines 63-113).

- [ ] **Step 2: Create `providers.ts`**

Extract market-data provider routes (lines 115-226). Export `registerProvidersRoutes(app)`.

```ts
import type { FastifyInstance } from "fastify";
import { providerSettings, providerCredentials, providerUsage } from "@portfolio/db";
import { eq } from "drizzle-orm";
import { listProviders, providersResponse } from "./_shared.js";

export function registerProvidersRoutes(app: FastifyInstance) {
  app.get("/admin/providers", { preHandler: app.requireAdmin }, async (request) => { ... });
  app.patch("/admin/providers", { preHandler: app.requireAdmin }, async (request) => { ... });
  app.put("/admin/providers/:id/credential", { preHandler: app.requireAdmin }, async (request) => { ... });
  app.delete("/admin/providers/:id/credential", { preHandler: app.requireAdmin }, async (request) => { ... });
}
```

- [ ] **Step 3: Create `vision-providers.ts`**

Extract vision LLM provider routes (lines 248-407). Export `registerVisionProvidersRoutes(app)`.

- [ ] **Step 4: Create `storage.ts`**

Extract storage provider routes (lines 409-507). Export `registerStorageRoutes(app)`.

- [ ] **Step 5: Create `jobs.ts`**

Extract background jobs routes (lines 646-759). Export `registerJobsRoutes(app)`.

- [ ] **Step 6: Create `users.ts`**

Extract user management routes (lines 788-904). Export `registerUsersRoutes(app)`.

- [ ] **Step 7: Slim `admin.ts`**

Keep audit (228-234), scraper (236-246), stats (509-644), import-settings (761-786) inline. Import and call the 5 sub-route registrations.

```ts
import { registerProvidersRoutes } from "./admin/providers.js";
import { registerVisionProvidersRoutes } from "./admin/vision-providers.js";
import { registerStorageRoutes } from "./admin/storage.js";
import { registerJobsRoutes } from "./admin/jobs.js";
import { registerUsersRoutes } from "./admin/users.js";

export async function adminRoute(app: FastifyInstance) {
  registerProvidersRoutes(app);
  registerVisionProvidersRoutes(app);
  registerStorageRoutes(app);
  registerJobsRoutes(app);
  registerUsersRoutes(app);

  // inline: audit, scraper, stats, import-settings
  ...
}
```

- [ ] **Step 8: Type-check and test**

Run `npm run typecheck --workspace @portfolio/api && npm test --workspace @portfolio/api`.

- [ ] **Step 9: Commit**

```bash
git add services/api/src/routes/admin.ts services/api/src/routes/admin/
git commit -m "refactor: decompose admin.ts into 5 sub-route files"
```

---

### Task 4: Decompose `services/api/src/routes/tr.ts` into sub-routes

**Files:**

- Modify: `services/api/src/routes/tr.ts` — slim to aggregator
- Create: `services/api/src/routes/tr/_shared.ts` — `serialize`, `getConnection`, `lookupPortfolio`
- Create: `services/api/src/routes/tr/pairing.ts` — auth/pairing routes
- Create: `services/api/src/routes/tr/sync.ts` — sync + reimport routes
- Create: `services/api/src/routes/tr/documents.ts` — document reprocess/diagnose/backfill

Same pattern as Task 3. Follow the `register*Routes(app)` pattern.

- [ ] **Step 1: Type-check and test**
- [ ] **Step 2: Commit**

```bash
git add services/api/src/routes/tr.ts services/api/src/routes/tr/
git commit -m "refactor: decompose tr.ts into 3 sub-route files"
```

---

### Task 5: Decompose `apps/web/src/lib/server-api.ts` into domain modules

**Files:**

- Modify: `apps/web/src/lib/server-api.ts` — slim to re-export barrel
- Create: `apps/web/src/lib/server-api/networth.ts` — `loadNetWorth`, `loadNetWorthHistory`
- Create: `apps/web/src/lib/server-api/portfolios.ts` — `loadPortfoliosList`, `loadPortfolios`, `loadPortfolioList`, `loadPortfolio`
- Create: `apps/web/src/lib/server-api/transactions.ts` — `loadTransactionsAcrossPortfolios`, `loadNetworthTransactionsPaginated`, `loadTransactionsPaginated`
- Create: `apps/web/src/lib/server-api/tax.ts` — `loadNetworthTax`, `loadTaxYearDetail`
- Create: `apps/web/src/lib/server-api/instruments.ts` — `loadInstrument`, `loadInstrumentScope`
- Create: `apps/web/src/lib/server-api/admin.ts` — all 7 admin endpoints
- Create: `apps/web/src/lib/server-api/connections.ts` — `loadTrConnection`, `loadIbkrConnection`
- Create: `apps/web/src/lib/server-api/account-holders.ts` — `loadAccountHolders`
- Create: `apps/web/src/lib/server-api/user.ts` — `loadPreferences`, `loadMe`, `loadApiTokens`
- Create: `apps/web/src/lib/server-api/documents.ts` — `loadDocuments`, `loadImports`, `loadImport`, `loadUnmappedEventTypes`
- Create: `apps/web/src/lib/server-api/insights.ts` — `loadInsights`

- [ ] **Step 1: Identify shared infra**

`server-api.ts` has a `getServerApi()` function and `cached` wrapper. These shared helpers should go in each domain file (they're small), or extracted to a `server-api/_shared.ts`.

- [ ] **Step 2: Create domain files**

Create each domain file with the relevant `export async function` definitions. Each function's signature stays identical — barrel re-exports ensure zero consumer impact.

- [ ] **Step 3: Update `server-api.ts`**

Replace all function definitions with:

```ts
export * from "./server-api/networth.js";
export * from "./server-api/portfolios.js";
// ... etc for all domain files
```

- [ ] **Step 4: Update all importers**

Find all files importing from `@/lib/server-api` and verify they still resolve (re-exports unchanged).

- [ ] **Step 5: Type-check and test**

Run `npm run typecheck --workspace @portfolio/web && npm test --workspace @portfolio/web`.

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/
git commit -m "refactor: decompose server-api.ts into 11 domain modules"
```

---

### Task 6: Decompose `apps/web/src/components/transactions-table.tsx` into sub-components

**Files:**

- Modify: `apps/web/src/components/transactions-table.tsx` — slim to ~440 lines
- Create: `apps/web/src/components/transactions-table/types.ts` — type constants
- Create: `apps/web/src/components/transactions-table/utils.tsx` — utility components + functions
- Create: `apps/web/src/components/transactions-table/banners.tsx` — anomaly + filter banners
- Create: `apps/web/src/components/transactions-table/filter-bar.tsx` — type/year/search filters
- Create: `apps/web/src/components/transactions-table/selection-bar.tsx` — selection toolbar + long-press
- Create: `apps/web/src/components/transactions-table/reassign-merge.tsx` — reassign/merge dialogs
- Create: `apps/web/src/components/transactions-table/desktop.tsx` — desktop table view
- Create: `apps/web/src/components/transactions-table/mobile.tsx` — mobile card view
- Create: `apps/web/src/components/transactions-table/load-more.tsx` — load-more pagination

Follow the component boundaries identified in exploration. Each sub-component ≤260 lines.

- [ ] **Step 1: Create type/constant files** — `types.ts`, `utils.tsx`
- [ ] **Step 2: Create UI sub-components** — `banners.tsx`, `filter-bar.tsx`, `selection-bar.tsx`, `reassign-merge.tsx`
- [ ] **Step 3: Create view files** — `desktop.tsx`, `mobile.tsx`, `load-more.tsx`
- [ ] **Step 4: Slim `transactions-table.tsx`** — keep imports, props, state, handlers, composition of sub-components
- [ ] **Step 5: Type-check and test**
- [ ] **Step 6: Commit**

```bash
git add apps/web/src/components/transactions-table.tsx apps/web/src/components/transactions-table/
git commit -m "refactor: decompose transactions-table.tsx into 9 sub-components"
```

---

### Task 7: Decompose `apps/web/src/components/import-flow.tsx` into sub-components

**Files:**

- Modify: `apps/web/src/components/import-flow.tsx` — slim to ~150 lines
- Create: `apps/web/src/components/import-flow/types.ts` — all type/interface/constant exports
- Create: `apps/web/src/components/import-flow/use-import-flow.ts` — custom hook with all state + handlers
- Create: `apps/web/src/components/import-flow/step-views.tsx` — step-specific JSX components

- [ ] **Step 1: Create `types.ts`** — extract lines 1-330
- [ ] **Step 2: Create `use-import-flow.ts`** — extract state/handlers as a custom hook
- [ ] **Step 3: Create `step-views.tsx`** — extract step JSX as sub-components
- [ ] **Step 4: Slim `import-flow.tsx`** — orchestrate hook + step views
- [ ] **Step 5: Update all 10 downstream importers** — switch type imports from `./import-flow` to `./import-flow/types`
- [ ] **Step 6: Type-check and test**
- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/import-flow.tsx apps/web/src/components/import-flow/
git commit -m "refactor: decompose import-flow.tsx into 4 sub-modules"
```

---

### Task 8: Decompose `apps/web/src/components/import-review.tsx` into sub-components

**Files:**

- Modify: `apps/web/src/components/import-review.tsx` — slim to ~300 lines
- Create: `apps/web/src/components/import-review/types.ts`
- Create: `apps/web/src/components/import-review/notices.tsx`
- Create: `apps/web/src/components/import-review/filter-bar.tsx`
- Create: `apps/web/src/components/import-review/bulk-toolbar.tsx`
- Create: `apps/web/src/components/import-review/table.tsx`
- Create: `apps/web/src/components/import-review/mobile.tsx`
- Create: `apps/web/src/components/import-review/edit-dialog.tsx`
- Create: `apps/web/src/components/import-review/map-dialog.tsx`

- [ ] **Step 1-4: Create sub-component files** — each extracting the corresponding section
- [ ] **Step 5: Slim `import-review.tsx`** — keep state + handlers + composition
- [ ] **Step 6: Type-check and test**
- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/import-review.tsx apps/web/src/components/import-review/
git commit -m "refactor: decompose import-review.tsx into 9 sub-components"
```

---

### Task 9: Decompose `apps/web/src/components/add-transaction-form.tsx` into sub-components

**Files:**

- Modify: `apps/web/src/components/add-transaction-form.tsx` — slim to ~480 lines
- Create: `apps/web/src/components/add-transaction-form/type-chip-picker.tsx`
- Create: `apps/web/src/components/add-transaction-form/instrument-field.tsx`
- Create: `apps/web/src/components/add-transaction-form/pricing-fields.tsx`
- Create: `apps/web/src/components/add-transaction-form/advanced-fields.tsx`
- Create: `apps/web/src/components/add-transaction-form/submit-button.tsx`

- [ ] **Step 1-5: Create sub-component files**
- [ ] **Step 6: Slim main file**
- [ ] **Step 7: Type-check and test**
- [ ] **Step 8: Commit**

```bash
git add apps/web/src/components/add-transaction-form.tsx apps/web/src/components/add-transaction-form/
git commit -m "refactor: decompose add-transaction-form.tsx into 6 sub-components"
```

---

### Final: Create PR

- [ ] **Create PR from `refactor/phase-3-decomposition` → `main`**

```bash
git push origin refactor/phase-3-decomposition
gh pr create --title "Phase 3: File decomposition (9 files → sub-modules)" --body "Decomposes 9 large files per #550 Phase 3.

### Changes
- **schema.ts** → 16 per-domain schema files
- **income.ts** → growth/coupons/dividends sub-modules
- **admin.ts** → 5 sub-route files
- **tr.ts** → 3 sub-route files
- **server-api.ts** → 11 domain modules
- **transactions-table.tsx** → 9 sub-components
- **import-flow.tsx** → 4 sub-modules
- **import-review.tsx** → 9 sub-components
- **add-transaction-form.tsx** → 6 sub-components

### Verification
- [ ] TypeScript passes across all workspaces
- [ ] All tests pass
- [ ] No consumer code changes needed (re-exports preserved)"
```
