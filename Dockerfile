# Monorepo image for the API service (@portfolio/api). Built from the repo root so
# workspace packages resolve. Context = repo root (matches docker-publish.yml).

# --- Install all deps (incl. dev) and build the API + its workspace deps ---
FROM node:26-slim AS build
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
COPY . .
RUN npm ci
RUN npx turbo run build --filter=@portfolio/api...

# --- Production-only dependencies (hoisted at the workspace root) ---
FROM node:26-slim AS prod-deps
WORKDIR /app
ENV NPM_CONFIG_FETCH_RETRIES=5 \
    NPM_CONFIG_FETCH_RETRY_MINTIMEOUT=20000 \
    NPM_CONFIG_FETCH_RETRY_MAXTIMEOUT=120000
COPY . .
RUN npm ci --omit=dev

# --- Minimal runtime image ---
FROM node:26-slim AS production
WORKDIR /app
ENV NODE_ENV=production

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/services/api/dist ./services/api/dist
COPY --from=build /app/services/api/package.json ./services/api/package.json
# Workspace packages the API imports at runtime (node_modules/@portfolio/* are
# symlinks into these). Migrations are applied at startup from @portfolio/db.
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/packages/db/drizzle ./packages/db/drizzle
COPY --from=build /app/packages/db/package.json ./packages/db/package.json
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/core/package.json ./packages/core/package.json
COPY --from=build /app/packages/schema/dist ./packages/schema/dist
COPY --from=build /app/packages/schema/package.json ./packages/schema/package.json
COPY --from=build /app/packages/market-data/dist ./packages/market-data/dist
COPY --from=build /app/packages/market-data/package.json ./packages/market-data/package.json

# --- Trade Republic sync (pytr) runs as a Python subprocess ---
# Install pytr into an isolated venv (sidesteps PEP-668 on slim). DELIBERATELY do NOT
# run `playwright install`: with PYTR_WAF_STRATEGY=awswaf the headless-browser code path
# is never taken, so no Chromium (~400MB) is pulled. Without the venv the feature simply
# returns 503 — it never crashes the API.
# `git` is required because requirements.txt pins pytr to an exact upstream commit
# (git+https), not a PyPI release — see services/api/python/requirements.txt.
COPY services/api/python ./services/api/python
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv git \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/pytr-venv \
    && /opt/pytr-venv/bin/pip install --no-cache-dir -r ./services/api/python/requirements.txt
ENV PYTR_PYTHON_BIN=/opt/pytr-venv/bin/python

# Pre-create /app/logs (default LOG_DIR mount point, see docker-compose.yml) so a fresh
# named volume mounted there inherits node:node ownership from the image instead of
# root's default — otherwise the non-root `node` user can't mkdir/write into it.
RUN mkdir -p /app/logs && chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/server.js"]
