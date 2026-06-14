# Node Backend Template

A production-ready [Fastify](https://fastify.dev/) backend template with
TypeScript, SQLite/[Drizzle](https://orm.drizzle.team/), encryption-at-rest,
security middleware, and full CI/CD.

## 🚀 Quick Start

```bash
make install          # install dependencies
cp .env.example .env  # configure environment (optional; defaults work)
make dev              # start the dev server on :3000
```

Then:

```bash
curl localhost:3000/health
curl localhost:3000/ready
curl -X POST localhost:3000/users -H 'content-type: application/json' \
  -d '{"name":"Ada","email":"ada@example.com","notes":"secret"}'
curl localhost:3000/users
```

## 📁 Structure

- `src/app.ts` — the app factory (`buildApp()`); registers plugins then routes.
- `src/plugins/` — `env` (validated config), `logging`, `security` (helmet,
  rate-limit, CORS), `db` (migrations + `app.db` / `app.encryption` decorators).
- `src/routes/` — `root`, `health` (`/health` liveness, `/ready` readiness),
  `users` (example CRUD using the DB + encryption).
- `src/services/` — `encryption` (AES-256-GCM), `date-utils`.
- `src/db/` — Drizzle schema, client, and seed. Migrations live in `drizzle/`.

## 🔧 Configuration

All config is validated at startup by `@fastify/env` (see `src/plugins/env.ts`).

| Variable            | Default            | Description                                              |
| ------------------- | ------------------ | ------------------------------------------------------- |
| `NODE_ENV`          | `development`      | `development` \| `production` \| `test`                 |
| `PORT`              | `3000`             | HTTP listen port                                        |
| `LOG_LEVEL`         | `info`             | pino log level                                          |
| `DATABASE_URL`      | `file:./data/app.db` | SQLite `file:` URL                                    |
| `DB_ENCRYPTION_KEY` | _(empty)_          | base64url 32-byte key; enables encryption-at-rest       |
| `CORS_ORIGIN`       | _(empty)_          | comma-separated allowlist; empty disables CORS          |
| `RATE_LIMIT_MAX`    | `100`              | max requests per window                                 |
| `RATE_LIMIT_WINDOW` | `1 minute`         | rate-limit window                                       |

Generate an encryption key:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 🛠️ Commands

- `make dev` — dev server with reload
- `make test` / `make test-coverage` — Vitest suite
- `make lint` / `make typecheck` — ESLint / `tsc`
- `make build` — production build to `dist/`
- `npm run db:generate` — generate a migration from schema changes
- `npm run db:migrate` — apply migrations (also run automatically at startup)
- `npm run db:seed` — seed initial data

## 🛡️ Security

- `@fastify/helmet` (security headers), `@fastify/rate-limit`, and
  `@fastify/cors` are wired into every app via `src/plugins/security.ts`.
- Optional AES-256-GCM encryption-at-rest via `DB_ENCRYPTION_KEY` (see the
  `users.notes` column for an example).
- CodeQL scanning and dependency review run in CI; `detect-secrets` runs
  pre-commit. Follows the
  [s3ntin3l8 Global Security Policy](https://github.com/s3ntin3l8/.github/blob/main/SECURITY.md).

## 🐳 Docker

```bash
docker build -t my-service .
docker run -p 3000:3000 \
  -e DB_ENCRYPTION_KEY="$(node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))")" \
  my-service
```

The image is multi-stage, runs as a non-root user, and ships a `HEALTHCHECK`.

## 📦 Releases

Automated via [Release Please](https://github.com/googleapis/release-please).
Use [Conventional Commits](https://www.conventionalcommits.org/) to trigger
version bumps.

## ✅ Using this template

1. Set `name` in `package.json` and update this README's title/description.
2. Update `image-name` in `.github/workflows/ci-cd.yml` and
   `release-please.yml` to your repo.
3. Replace `release-please-config.json` / manifest package name if needed.
4. Generate and set a real `DB_ENCRYPTION_KEY` for any non-local environment.
5. Replace the example `users` schema/route with your domain model.
