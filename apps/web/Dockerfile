# Monorepo image for the web app (@portfolio/web). Built from the repo root (context = .)
# so workspace packages resolve — mirrors the root Dockerfile's pattern. Standalone Next.js
# output (see next.config.mjs's `output: "standalone"` + `outputFileTracingRoot`): workspace
# packages are consumed via `transpilePackages`, so they're compiled directly into the built
# output — no separate packages/*/dist copy needed here (unlike the API's Dockerfile).

# --- Install all deps (incl. dev) and build the web app + its workspace deps ---
FROM node:26-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
COPY . .
RUN npm ci
# No runtime secrets needed at build time — the API URL is server-only, resolved at request
# time (see app/api/backend/[...path]/route.ts). The app-version NEXT_PUBLIC_* var is
# non-secret and inlined by next.config.mjs from the root package.json (already present via
# the `COPY . .` above) — no build arg needed for that one.
#
# NEXT_PUBLIC_LOGODEV_TOKEN (instrument-logo.tsx) DOES need a build arg: it's a publishable
# logo.dev key (safe client-side, endpoint-restricted), but like all NEXT_PUBLIC_* vars it's
# inlined into the client bundle at build time, not read at runtime — and `.env*` is
# .dockerignore'd out of this build's context, so without this arg the prod bundle silently
# ships `token === undefined` and every instrument falls back to the monogram (#543 follow-up).
ARG NEXT_PUBLIC_LOGODEV_TOKEN
ENV NEXT_PUBLIC_LOGODEV_TOKEN=$NEXT_PUBLIC_LOGODEV_TOKEN
RUN npx turbo run build --filter=@portfolio/web...

# --- Minimal runtime image ---
FROM node:26-slim AS production
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3005 \
    HOSTNAME=0.0.0.0

# .next/standalone mirrors the monorepo layout rooted at outputFileTracingRoot (the repo
# root) — it contains apps/web/server.js plus a pruned, self-contained node_modules. Static
# assets and public/ are deliberately NOT included in standalone output (per Next.js docs)
# and must be copied in separately.
COPY --from=build /app/apps/web/.next/standalone ./
COPY --from=build /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build /app/apps/web/public ./apps/web/public

RUN chown -R node:node /app
USER node

EXPOSE 3005
# Hits /api/auth/session, not `/` — `/` 307-redirects to the locale-prefixed path
# (next-intl), which most HTTP health-check semantics (including this one) don't follow,
# so it would read as unhealthy even when the app is fine. /api/auth/session always
# returns 200, signed in or not.
#
# Explicitly sends a Host header matching AUTH_URL: the proxy.ts host guard (421s
# anything not in WEB_ALLOWED_HOSTS / AUTH_URL's host, once NODE_ENV=production disables
# the localhost carve-out) would otherwise reject this in-container 127.0.0.1 request and
# make the healthcheck permanently fail in every real deployment — live-verified while
# building this Dockerfile (`docker exec` into a running container reproduced the 421).
# Uses node:http, NOT fetch: fetch (undici) silently drops a manually-set `Host` header
# (forbidden per the Fetch spec) and would keep sending the real 127.0.0.1 host regardless
# — also live-verified (fetch kept 421ing after "fixing" it once; raw http.request doesn't
# have that restriction and correctly gets 200).
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "\
    const http = require('node:http'); \
    const host = new URL(process.env.AUTH_URL || 'http://localhost:3005').host; \
    const req = http.request( \
      { host: '127.0.0.1', port: 3005, path: '/api/auth/session', headers: { host } }, \
      (res) => process.exit(res.statusCode === 200 ? 0 : 1), \
    ); \
    req.on('error', () => process.exit(1)); \
    req.end();"

CMD ["node", "apps/web/server.js"]
