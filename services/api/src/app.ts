import Fastify from "fastify";
import type { FastifyBaseLogger } from "fastify";
import pino from "pino";
import type { DestinationStream } from "pino";
import pinoRoll from "pino-roll";
import sensible from "@fastify/sensible";
import multipart from "@fastify/multipart";
import { ZodError } from "zod";
import { envPlugin } from "./plugins/env.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { dbPlugin } from "./plugins/db.js";
import { authPlugin, type AuthPluginOptions } from "./plugins/auth.js";
import { rootRoute } from "./routes/root.js";
import { healthRoute } from "./routes/health.js";
import { meRoute } from "./routes/me.js";
import { portfoliosRoute } from "./routes/portfolios.js";
import { accountHoldersRoute } from "./routes/account-holders.js";
import { transactionsRoute } from "./routes/transactions.js";
import { instrumentsRoute } from "./routes/instruments.js";
import { quotesRoute } from "./routes/quotes.js";
import { internalMarketDataRoute } from "./routes/internal-market-data.js";
import { corporateActionsRoute } from "./routes/corporate-actions.js";
import { mergersRoute } from "./routes/mergers.js";
import { importsRoute } from "./routes/imports.js";
import { documentsRoute } from "./routes/documents.js";
import { trRoute } from "./routes/tr.js";
import { ibkrRoute } from "./routes/ibkr.js";
import { adminRoute } from "./routes/admin.js";
import { searchRoute } from "./routes/search.js";
import { storageRoute } from "./routes/storage.js";
import { targetsRoute } from "./routes/targets.js";
import { preferencesRoute } from "./routes/preferences.js";
import type { ScreenshotParser } from "./services/parsers/types.js";
import { getScreenshotParser } from "./services/screenshot-parser.js";
import { getPytrRunner } from "./services/pytr/runner.js";
import type { PytrRunner } from "./services/pytr/runner.js";
import { createFlexClient } from "./services/ibkr/flex-client.js";
import type { IbkrFlexClient } from "./services/ibkr/flex-client.js";
import type { StorageProvider } from "./storage/types.js";
import { storagePlugin } from "./plugins/storage.js";

export type BuildAppOptions = AuthPluginOptions & {
  // Injectable so tests can supply a mock parser instead of hitting Anthropic.
  screenshotParser?: ScreenshotParser;
  // Injectable so tests drive the pytr boundary without spawning Python.
  pytr?: PytrRunner;
  // Injectable so tests can mock the IBKR Flex client without real HTTP.
  ibkrFlex?: IbkrFlexClient;
  // Injectable so tests can supply a fake storage driver without hitting MinIO/S3.
  storage?: StorageProvider;
  /**
   * Test capture seam: pass an in-memory writable so test assertions can read NDJSON
   * log lines. Must NOT be used in production. Example:
   *   const lines: object[] = [];
   *   const logStream = { write(line: string) { lines.push(JSON.parse(line)); } };
   *   const app = await buildApp({ logStream });
   */
  logStream?: DestinationStream;
};

function trustedProxyConfig(): string[] | undefined {
  const raw = process.env.TRUSTED_PROXY_CIDRS?.trim();
  if (!raw) return undefined;
  return raw
    .split(",")
    .map((cidr) => cidr.trim())
    .filter((cidr) => cidr.length > 0);
}

/**
 * Resolve the pino destination stream.
 * - Tests pass an explicit logStream (in-memory capture) — returned as-is.
 * - When LOG_DIR is set in the environment, fan out to both stdout AND a rolling
 *   file (daily rotation, 20 MB size cap, 14 days of retention). Both sinks inherit
 *   the pino instance's `redact` config, so secrets never reach the file.
 * - Otherwise, log to stdout only (default and Docker/prod behaviour).
 */
export async function resolveLogDestination(
  injected?: DestinationStream,
): Promise<DestinationStream> {
  if (injected) return injected;

  const logDir = process.env.LOG_DIR?.trim();
  if (!logDir) return process.stdout;

  // pino-roll opens the file and rotates; the import is dynamic to avoid the
  // overhead + any file-handle leak in test runs (tests inject a stream directly).
  const rollStream = await pinoRoll({
    file: `${logDir}/api.log`,
    frequency: "daily",
    size: "20m",
    limit: { count: 14 },
    mkdir: true,
    sync: false,
  });

  return pino.multistream([{ stream: process.stdout }, { stream: rollStream }]);
}

export async function buildApp(opts: BuildAppOptions = {}) {
  // Build the pino logger eagerly so we can (a) set redact paths at construction time
  // (they can't be patched in after the fact) and (b) accept a custom stream for test
  // log capture. The level is set from process.env here; loggingPlugin re-reconciles it
  // from the validated app.config after envPlugin runs.
  const loggerInstance = pino(
    {
      level: process.env.LOG_LEVEL || "info",
      redact: {
        paths: [
          // Standard HTTP fields emitted by Fastify's req/res serializers.
          "req.headers.authorization",
          "req.headers.cookie",
          // Vision-provider API keys (in-process, never in req headers; defence-in-depth).
          'req.headers["x-api-key"]',
          // Trade Republic credentials — passed via env to Python, logged in structured objs.
          "phone",
          "pin",
          "*.phone",
          "*.pin",
          "wafToken",
          "sessionData",
          // Encryption key — should never appear in logs, but guard the config object.
          "DB_ENCRYPTION_KEY",
          "config.DB_ENCRYPTION_KEY",
          // Raw image/document bytes — log only `bytes` (length), never the base64 payload.
          "image",
          "data",
        ],
        censor: "[Redacted]",
      },
    },
    await resolveLogDestination(opts.logStream),
  );

  // Cast to FastifyBaseLogger: pino.Logger is a superset of FastifyBaseLogger. The cast
  // ensures Fastify infers `FastifyInstance<..., FastifyBaseLogger, ...>` consistently
  // with the rest of the codebase (server.ts, tests). Runtime behaviour is identical.
  const app = Fastify({
    loggerInstance: loggerInstance as FastifyBaseLogger,
    trustProxy: trustedProxyConfig(),
  });

  // Tolerate an empty application/json body. Fastify's default parser rejects a
  // request that advertises application/json with no body (FST_ERR_CTP_EMPTY_JSON_BODY
  // → 400), which breaks bodyless DELETEs from clients that always set the header.
  // Genuinely malformed JSON still surfaces as a 400.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (_req, body, done) => {
    if (body === "" || body == null) return done(null, undefined);
    try {
      done(null, JSON.parse(body as string));
    } catch (err) {
      (err as { statusCode?: number }).statusCode = 400;
      done(err as Error, undefined);
    }
  });

  // Surface zod validation failures as 400s instead of 500s.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "validation_error", issues: error.issues });
    }
    app.log.error(error);
    const err = error as { statusCode?: number; message?: string };
    return reply.code(err.statusCode ?? 500).send({ error: err.message || "internal_error" });
  });

  await app.register(envPlugin);
  await app.register(loggingPlugin);
  await app.register(sensible);
  // Allow multipart/form-data uploads (screenshot imports). 25 MB per file; single file
  // per request. The limit is caught in-route (→ 413) to avoid leaking FST_* error codes.
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024, files: 1 } });
  await app.register(securityPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin, opts);

  const screenshotParser = opts.screenshotParser ?? (await getScreenshotParser());
  app.decorate("screenshotParser", screenshotParser);
  // Log the selected vision provider once at startup (only for the real singleton, not
  // test-injected mocks — those are controlled by the test and shouldn't pollute logs).
  if (!opts.screenshotParser) {
    const pinned = !!process.env.SCREENSHOT_PARSER?.trim();
    app.log.info(
      { provider: screenshotParser.name, configured: screenshotParser.isConfigured(), pinned },
      "vision provider selected",
    );
  }

  app.decorate("pytr", opts.pytr ?? getPytrRunner(app.config, app.log));
  app.decorate(
    "ibkrFlex",
    opts.ibkrFlex ?? createFlexClient({ baseUrl: app.config.IBKR_FLEX_BASE_URL }),
  );

  // Storage — injectable in tests (pass opts.storage); the real plugin handles
  // bucket auto-creation on non-production environments so local MinIO just works.
  if (opts.storage) {
    app.decorate("storage", opts.storage);
  } else {
    await app.register(storagePlugin);
  }

  await app.register(rootRoute);
  await app.register(healthRoute);
  await app.register(meRoute);
  await app.register(portfoliosRoute);
  await app.register(accountHoldersRoute);
  await app.register(transactionsRoute);
  await app.register(instrumentsRoute);
  await app.register(quotesRoute);
  await app.register(internalMarketDataRoute);
  await app.register(corporateActionsRoute);
  await app.register(mergersRoute);
  await app.register(importsRoute);
  await app.register(documentsRoute);
  await app.register(trRoute);
  await app.register(ibkrRoute);
  await app.register(adminRoute);
  await app.register(searchRoute);
  await app.register(targetsRoute);
  await app.register(preferencesRoute);
  // Public file-serving for the folder storage provider (no auth — token in query string).
  await app.register(storageRoute);

  return app;
}

declare module "fastify" {
  interface FastifyInstance {
    screenshotParser: ScreenshotParser;
    pytr: PytrRunner;
    ibkrFlex: IbkrFlexClient;
    storage: StorageProvider;
  }
}
