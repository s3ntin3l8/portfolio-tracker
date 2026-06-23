# CLAUDE.md — Portfolio Tracker (monorepo)

Indonesian-first personal portfolio tracker: import transactions from **screenshots**
(LLM vision) and **CSV**, track **equities, gold, bonds, mutual funds (reksa dana),
and cash** with live IDX prices and a real-time gold ticker. Built to expand to
**Trade Republic / international** later. Full architecture: `.claude/plans/`.

## Stack & topology

- **Monorepo:** npm workspaces + **Turborepo**. Node ≥26, ESM, TypeScript.
- **`services/api`** — **Fastify 5 + Drizzle (Postgres)**. The only thing that touches
  the DB; hosts auth, market-data jobs, screenshot parsing, future Trade Republic
  (`pytr`). Started from `s3ntin3l8/node-backend-template`. **Auth:** Authentik OIDC —
  `plugins/auth.ts` verifies Bearer JWTs (remote JWKS in prod, an injectable key in
  tests via `buildApp({ authKey })`), upserts the user by `sub`, and exposes the
  `app.authenticate` preHandler; every route scopes queries to `request.user`.
  **Endpoints:** `/me`, `/portfolios` (list/create), `/portfolios/:id/transactions`
  (list/create), `/portfolios/:id/holdings` (derived via `@portfolio/core`). Schema +
  migrations come from `@portfolio/db`; the API applies them at startup.
- **`apps/web`** — **Next.js (App Router) PWA**, Tailwind + shadcn/ui, **next-intl**
  (EN/ID). Talks to the API over HTTP (base URL is config-driven → Vercel-migratable).
- **`packages/*`** — `schema` (zod + types), `core` (holdings, cost basis, XIRR,
  corp-actions, FX), `db` (Drizzle schema/migrations), `market-data` (provider
  abstraction), `api-client` (typed client for the PWA). _Most are stubs in phase 0._
- **Infra:** Supabase Cloud (Postgres + Storage) to start; **Authentik** (OIDC) for
  auth; self-host on Proxmox is the exit path. Local dev via `docker-compose.yml`
  (Postgres + MinIO + optional Ollama).

## Commands

Run from the repo root (Turborepo fans out across workspaces):

| Command | Does |
|---------|------|
| `npm install` | Install all workspace deps (single root lockfile). |
| `npm run dev` | Run all `dev` tasks (API watch + Next dev). |
| `npm run build` | Build every workspace. |
| `npm run lint` | ESLint across workspaces. |
| `npm run typecheck` | `tsc --noEmit` across workspaces. |
| `npm test` | Vitest across workspaces. |
| `npm run format` | Prettier write. |

Target one workspace with `--workspace @portfolio/<name>` (e.g.
`npm run dev --workspace @portfolio/api`). DB: `npm run db:generate` /
`npm run db:seed` inside `services/api` after editing the schema.

Local backing services: `docker compose up -d postgres minio` (then `npm run dev`).

> **Known dev flake:** on `npm run dev` the API (`tsx watch`) can crash once at
> startup with `SyntaxError: … does not provide an export named …` from a
> `@portfolio/*` dist file. This is a benign race: `tsc --watch` is mid-emitting
> `dist/` when `tsx` first loads the module graph. It self-recovers on `tsc`'s next
> emit (usually within a few seconds). If the API stays unreachable, check for a
> stale `tsx watch` process holding the port before re-running.

> **Known console warning:** Next.js logs `Encountered a script tag while rendering
> React component` from `ThemeProvider`. This is an upstream bug in `next-themes`
> (issue #387) caused by its inline FOUC-prevention `<script>` conflicting with React
> 19's new script-handling rules. Cosmetic only — themes work correctly. Track
> [pacocoursey/next-themes#387](https://github.com/pacocoursey/next-themes/issues/387)
> for a fix.

## Conventions

- **ESM throughout** (`"type": "module"`); `.ts` sources import with `.js` specifiers
  (NodeNext resolution). Prefer `import type` (ESLint-enforced).
- **Money is never a float** — use Postgres `numeric`/decimal; every amount carries an
  explicit currency.
- **Transactions are the source of truth.** Holdings, P&L, cash balance, XIRR and net
  worth are derived in `packages/core` — never stored as primary state.
- **One boundary per portfolio (contributions & performance).** Each portfolio declares
  whether cash is *inside* its investment boundary (savings/deposit accounts — Tagesgeld,
  Festgeld, a child's savings depot) or *outside* it (mixed/checking, invest-only) via the
  `cashCounted` flag. **Contribution = net external cash crossing that boundary; the
  performance value = what's inside it — same boundary for numerator and denominator,
  always.** Cash-inside: contribution = deposits − withdrawals, value = net worth incl. cash.
  Cash-outside: contribution = net invested capital (kind-aware buys − sells), value =
  securities only, cash excluded from net worth. Never mix boundaries (cash in the value but
  not the contribution, or vice versa) — that manufactures phantom gains. Income (dividends/
  interest/coupons, `saveback`, bonus shares) is return, never contribution; `transfer_in` is
  contributed capital at its carried cost basis. Lives in
  `packages/core/src/contributions.ts` + the `boundaryFlows`/`summarizePortfolio` plumbing.
- **`transfer_in` / `transfer_out` are first-class transaction types** (since PR #309,
  migration 0044). Depot-to-depot share transfers (Depotübertrag): cash-neutral, shares move
  at carried cost basis — no P&L on `transfer_out` (not a disposal). This replaces the legacy
  `bonus`+`kind:"transfer_in"` sub-type pattern (those rows should be migrated). Inside-
  boundary: `transfer_in` is an inflow at carried cost; outside-boundary: at avg cost.
- **Imports never auto-commit.** Screenshot/CSV parses become *draft* records that the
  user confirms before a transaction is written. Dedup runs at three levels: **file-level**
  (same file re-upload → `contentHash`), **within-source transaction-level** (the
  `(portfolioId, source, externalId)` unique index + `onConflictDoNothing`), and
  **cross-source economic** (a source-independent `(instrument, type, day, qty, price)`
  fingerprint flags likely CSV-vs-PDF re-imports in the review screen, count-aware so
  genuine same-day repeats aren't suppressed). Raw screenshots are deleted after a
  confirmed parse (parsed JSON is kept).
- **Tests** live in each workspace's `test/`. The API uses an embedded **PGlite**
  Postgres (`pglite://` URLs) so tests need no external DB; `app.inject()` for routes.
- Config is read from `app.config` (typed in `services/api/src/plugins/env.ts`), not
  `process.env` directly. After editing `services/api/src/db/schema.ts`, run
  `npm run db:generate` and commit the migration.
- **Conventional Commits** (Release Please cuts versions). `detect-secrets` runs in
  pre-commit/CI against `.secrets.baseline`.
- **Before committing:** `npm run lint && npm run typecheck && npm test`.

## Testing & coverage

- **Runner:** Vitest. The root `vitest.config.ts` aggregates every workspace via
  `test.projects`; `npm test` / `npm run test:coverage` run them together and merge
  coverage into `./coverage`.
- **Coverage gate: 70%** (lines/functions/branches/statements) enforced two ways — the
  root Vitest `thresholds` (fails `test:coverage` locally) and `coverage-fail-under: 70`
  in CI. **Keep it green: new code lands with tests.** Excluded from the gate:
  entrypoints/CLIs (`server.ts`, `db/seed.ts`) and framework boilerplate
  (`app/**`, `proxy.ts`, `i18n/**`, configs, `*.d.ts`).
- **API/packages:** Node env. The API uses embedded **PGlite** (`pglite://` URLs) so
  tests need no external Postgres; routes use `app.inject()`.
- **Python (pytr):** the vendored Trade Republic entrypoints in `services/api/python`
  have **pytest** unit tests (`test_tr_export.py`) for the detail-extraction heuristics —
  the part not exercised by the Node mapper tests. Run with `npm run test:py --workspace
  @portfolio/api` (uses `.venv-pytr`) or `python -m pytest services/api/python`; CI runs
  them in the `test-python` job. Outside the Vitest coverage gate.
- **Web:** **jsdom + React Testing Library** (`@vitejs/plugin-react`). Render client
  components inside `NextIntlClientProvider` with `messages/en.json`. Server components
  / pages are excluded from coverage (cover via e2e later).
- **Note:** Vitest 4 bundles Vite 8, so the root `package.json` pins
  `overrides.vite: ^8` to dedupe Vite (otherwise `plugin-react` binds the wrong copy
  and JSX fails to transform).

## CI/CD

`.github/workflows/` are thin callers of the reusable workflows in
[`s3ntin3l8/.github`](https://github.com/s3ntin3l8/.github): `ci-cd.yml` runs
**ci-node** at the root (so root scripts fan out via Turbo: lint, typecheck,
test:coverage, build) plus a self-contained **test-python** job (pytest over
`services/api/python`, the vendored pytr extraction tests — not covered by ci-node),
then **docker-publish** (root `Dockerfile`, builds `@portfolio/api`) once both test jobs
pass.
Caller jobs invoking reusable workflows with write scopes **must declare a
`permissions:` block** or the run fails at startup. `codeql`, `dependency-review`,
`release-please`, `cleanup-ghcr` are also wired.

`codeql` and `dependency-review` are gated on `github.event.repository.private == false`
— they need GitHub Advanced Security on a private repo, so they **skip while private and
auto-activate once the repo is made public** (both features are free on public repos).

## Phased plan (see `.claude/plans/`)

0. **Restructure** (this) — monorepo, API→Postgres, web skeleton, compose, CI.
1. Foundation — Authentik OIDC, full schema (`packages/db`+`core`), design system +
   screens (ui-ux-pro-max), manual transaction CRUD.
2. Market data (IDX + gold spot + Antam + bonds/funds) via the provider abstraction.
3. Screenshot ingest (Claude default, Ollama/LM Studio/Gemini/OpenRouter fallbacks) + CSV.
4. v1 features — dividends, corporate actions, XIRR, net-worth dashboard.
5. International — Trade Republic (`pytr`, EODHD/OpenFIGI), then native mobile.
