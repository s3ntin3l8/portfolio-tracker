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
# Migrations are applied at startup by ensureDb() (resolves ../../drizzle).
COPY --from=build /app/services/api/drizzle ./services/api/drizzle
COPY --from=build /app/services/api/package.json ./services/api/package.json

RUN chown -R node:node /app
USER node

EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "services/api/dist/server.js"]
