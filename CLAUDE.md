# CLAUDE.md — Pocket (monorepo)

Personal portfolio tracker (English/Indonesian language support) that imports transactions
from **screenshots** (LLM vision), **CSV/PDF** (broker-specific parsers: DKB, IBKR, Trade
Republic, Coinbase), and direct broker sync (**Trade Republic** push-approval, **Interactive
Brokers** Flex token-pull), tracking **equities, gold, bonds, mutual funds (reksa dana), and
cash** with live IDX prices and a real-time gold ticker.

## Stack & topology

- **Monorepo:** npm workspaces + **Turborepo**. Node ≥26, ESM, TypeScript.
- **`services/api`** — **Fastify 5 + Drizzle (Postgres)**. The only thing that touches
  the DB; hosts auth, market-data jobs, screenshot/CSV/PDF import parsing, and broker
  sync (Trade Republic via vendored `pytr`, Interactive Brokers via Flex). Started from
  `s3ntin3l8/node-backend-template`. **Auth:** Authentik OIDC — `plugins/auth.ts`
  verifies Bearer JWTs (remote JWKS in prod, an injectable key in tests via
  `buildApp({ authKey })`), or a long-lived personal access token (`pt_`-prefixed,
  hashed at rest, `/me/tokens`, mutating methods blocked for read-scoped tokens);
  upserts the user by `sub`, and exposes the `app.authenticate` preHandler — every
  route scopes queries to `request.user`. **Routes** (`src/routes/*.ts`, one file per
  domain): `me` (profile + PATs), `account-holders`, `portfolios`, `transactions`
  (also holdings/trades/tax/income/allocation/forecasts/contributions — the largest
  route file), `corporate-actions`, `mergers`, `imports` (+`imports/parse`,
  `imports/confirm`), `documents`, `instruments`, `quotes`, `search`, `storage`,
  `targets`, `tr`, `ibkr`, `preferences`, `admin`. Schema + migrations come from
  `@portfolio/db`; the API applies them at startup.
- **`apps/web`** — **Next.js (App Router) PWA**, Tailwind + shadcn/ui, **next-intl**
  (EN/ID). Talks to the API over HTTP (base URL is config-driven → Vercel-migratable).
- **`packages/*`** — `schema` (zod + types), `core` (holdings, cost basis, XIRR/TWR,
  contributions, tax DE/ID, trade-log, allocation/rebalancing, forecasting, corp-actions,
  FX — the domain logic derived from transactions, the source of truth), `db` (Drizzle
  schema/migrations), `market-data` (provider abstraction: IDX, gold spot/Antam,
  EODHD/Yahoo/OpenFIGI), `api-client` (typed client for the PWA).
- **Infra:** Supabase Cloud (Postgres + Storage) to start; **Authentik** (OIDC) for
  auth; self-host on Proxmox is the exit path. Local dev via `docker-compose.yml`
  (Postgres + MinIO + optional Ollama).

## Commands

Run from the repo root (Turborepo fans out across workspaces):

| Command             | Does                                               |
| ------------------- | -------------------------------------------------- |
| `npm install`       | Install all workspace deps (single root lockfile). |
| `npm run dev`       | Run all `dev` tasks (API watch + Next dev).        |
| `npm run build`     | Build every workspace.                             |
| `npm run lint`      | ESLint across workspaces.                          |
| `npm run typecheck` | `tsc --noEmit` across workspaces.                  |
| `npm test`          | Vitest across workspaces.                          |
| `npm run format`    | Prettier write.                                    |

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
React component` from `ThemeProvider`. This is an upstream bug in `next-themes`
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
  whether cash is _inside_ its investment boundary (savings/deposit accounts — Tagesgeld,
  Festgeld, a child's savings depot) or _outside_ it (mixed/checking, invest-only) via the
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
- **Freistellungsauftrag (FSA) has two levels, don't conflate them.** The legal
  per-person cap lives on `accountHolders.taxAllowanceAnnual` (Sparerpauschbetrag, default
  €1,000/€2,000 jointly assessed). The actual FSA is _allocated_ per depot via
  `portfolios.taxAllowanceAnnual` — same-holder portfolios should sum to ≤ the holder's
  cap, but this is only checked and surfaced as an over-allocation warning (`tax.ts`), not
  a hard DB constraint. Feeds `trade-log.ts`'s `vorabByYear`/`vorabCredit` and `tax.ts`'s
  Teilfreistellung netting.
- **`userPreferences` holds two global tax switches**: `taxRegime` (default `"DE"`, the
  other value routes to the Indonesian final-tax module) and `costBasisMode` (default
  `"purchase_price"`). Changing either changes which `packages/core` tax module and
  cost-basis convention every portfolio's numbers are computed with — check both before
  assuming DE-style realization-based tax logic applies.
- **Imports never auto-commit.** Screenshot/CSV parses become _draft_ records that the
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
- **Logging:** pino to stdout by default. Set `LOG_DIR` (see `.env.example`) to also fan
  out to a `pino-roll` rotating file (daily rotation, 20 MB cap, 14-day retention) —
  `resolveLogDestination()` in `services/api/src/app.ts`. Same secret redaction (auth
  headers, cookies, TR phone/pin, `DB_ENCRYPTION_KEY`, …) applies to both sinks. Leave
  unset for Docker/prod setups that already capture stdout via journald/CloudWatch; the
  `docker-compose.yml` `api` service passes `LOG_DIR` through opt-in (unset by default)
  and mounts an `apilogs` volume for it.
- **Conventional Commits** (Release Please cuts versions). `detect-secrets` runs in
  pre-commit/CI against `.secrets.baseline`.
- **PR descriptions (and commit messages) stay generic.** No personal/account-holder
  names and no private account specifics (depot/account numbers, exact balances); keep
  them concise and high-level — describe the change and the class of problem, not the
  individual account that surfaced it.
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
**ci-node** at the root (so root scripts fan out via Turbo: lint, typecheck, build)
plus a self-contained **test-python** job (pytest over `services/api/python`, the
vendored pytr extraction tests — not covered by ci-node), then **docker-publish**
(root `Dockerfile`, builds `@portfolio/api`) once both test jobs pass. Tests run
**sharded 4-way** (`test-shards: "4"`) via `test:coverage:sharded` — the same Vitest
coverage run as `test:coverage`, but with `coverage.thresholds` disabled per-shard
(a single shard's inherently-partial coverage would otherwise trip the 70% gate); the
merged coverage across all 4 shards is what's actually checked against
`coverage-fail-under`, in a `test-merge` job that runs after the shard matrix. Turbo's
build/lint/typecheck cache is also persisted across runs (`turbo-cache: true`).
Sharding + caching cut the job from ~5m30s to ~2m (live-validated via a smoke-test PR
before adopting).
Caller jobs invoking reusable workflows with write scopes **must declare a
`permissions:` block** or the run fails at startup. `codeql`, `dependency-review`,
`release-please`, `cleanup-ghcr` are also wired.

`codeql` and `dependency-review` are gated on `github.event.repository.private == false`
— they need GitHub Advanced Security, which is free on public repos but not private ones.
The repo **is public** (confirmed 2026-07-16), so both are live on every PR, not
conditionally skipped.

Two more workflows are mention-triggered, not push/PR-triggered: **`claude.yml`** runs
Claude Code itself against `@claude`-mentioned issues/PR comments/reviews; **`hermes.yml`**
runs an on-demand PR review bot on `@s3ntin3l8-hermes` comment mentions (guarded against
re-triggering itself via `github.actor`, since a submitted review's body also matches the
mention substring — see the in-file comment on the Claude→Hermes cascade, `.github#527`).
`claude.yml` is a thin caller of the reusable `s3ntin3l8/.github/.github/workflows/claude-code.yml`
(same `workflow_call` pattern as `hermes.yml`/`hermes-review.yml`) — the trusted-commenter
gate, Node setup, and review-capable tool grants (including
`mcp__github_inline_comment__create_inline_comment` for inline suggested edits, plus
`gh pr review` for a formal Approve/Request-Changes verdict) live there once, shared with
`runway-ai-usage-tracker` and `claude-remote-session` (`.github#34`).
