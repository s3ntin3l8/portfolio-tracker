# CLAUDE.md — Portfolio Tracker (monorepo)

Indonesian-first personal portfolio tracker: import transactions from **screenshots**
(LLM vision) and **CSV**, track **equities, gold, bonds, mutual funds (reksa dana),
and cash** with live IDX prices and a real-time gold ticker. Built to expand to
**Trade Republic / international** later. Full architecture: `.claude/plans/`.

## Stack & topology

- **Monorepo:** npm workspaces + **Turborepo**. Node ≥26, ESM, TypeScript.
- **`services/api`** — **Fastify 5 + Drizzle (Postgres)**. The only thing that touches
  the DB; hosts auth, market-data jobs, screenshot parsing, future Trade Republic
  (`pytr`). Started from `s3ntin3l8/node-backend-template`.
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

## Conventions

- **ESM throughout** (`"type": "module"`); `.ts` sources import with `.js` specifiers
  (NodeNext resolution). Prefer `import type` (ESLint-enforced).
- **Money is never a float** — use Postgres `numeric`/decimal; every amount carries an
  explicit currency.
- **Transactions are the source of truth.** Holdings, P&L, cash balance, XIRR and net
  worth are derived in `packages/core` — never stored as primary state.
- **Imports never auto-commit.** Screenshot/CSV parses become *draft* records that the
  user confirms before a transaction is written; imports are idempotent. Raw
  screenshots are deleted after a confirmed parse (parsed JSON is kept).
- **Tests** live in each workspace's `test/`. The API uses an embedded **PGlite**
  Postgres (`pglite://` URLs) so tests need no external DB; `app.inject()` for routes.
- Config is read from `app.config` (typed in `services/api/src/plugins/env.ts`), not
  `process.env` directly. After editing `services/api/src/db/schema.ts`, run
  `npm run db:generate` and commit the migration.
- **Conventional Commits** (Release Please cuts versions). `detect-secrets` runs in
  pre-commit/CI against `.secrets.baseline`.
- **Before committing:** `npm run lint && npm run typecheck && npm test`.

## CI/CD

`.github/workflows/` are thin callers of the reusable workflows in
[`s3ntin3l8/.github`](https://github.com/s3ntin3l8/.github): `ci-cd.yml` runs
**ci-node** at the root (so root scripts fan out via Turbo: lint, typecheck,
test:coverage, build) then **docker-publish** (root `Dockerfile`, builds `@portfolio/api`).
Caller jobs invoking reusable workflows with write scopes **must declare a
`permissions:` block** or the run fails at startup. `codeql`, `dependency-review`,
`release-please`, `cleanup-ghcr` are also wired.

## Phased plan (see `.claude/plans/`)

0. **Restructure** (this) — monorepo, API→Postgres, web skeleton, compose, CI.
1. Foundation — Authentik OIDC, full schema (`packages/db`+`core`), design system +
   screens (ui-ux-pro-max), manual transaction CRUD.
2. Market data (IDX + gold spot + Antam + bonds/funds) via the provider abstraction.
3. Screenshot ingest (Claude default, Ollama/LM Studio/Gemini/OpenRouter fallbacks) + CSV.
4. v1 features — dividends, corporate actions, XIRR, net-worth dashboard.
5. International — Trade Republic (`pytr`, EODHD/OpenFIGI), then native mobile.
