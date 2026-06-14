import Fastify from "fastify";
import sensible from "@fastify/sensible";
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
import { transactionsRoute } from "./routes/transactions.js";

export type BuildAppOptions = AuthPluginOptions;

export async function buildApp(opts: BuildAppOptions = {}) {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  // Surface zod validation failures as 400s instead of 500s.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply
        .code(400)
        .send({ error: "validation_error", issues: error.issues });
    }
    app.log.error(error);
    const err = error as { statusCode?: number; message?: string };
    return reply
      .code(err.statusCode ?? 500)
      .send({ error: err.message || "internal_error" });
  });

  await app.register(envPlugin);
  await app.register(loggingPlugin);
  await app.register(sensible);
  await app.register(securityPlugin);
  await app.register(dbPlugin);
  await app.register(authPlugin, opts);

  await app.register(rootRoute);
  await app.register(healthRoute);
  await app.register(meRoute);
  await app.register(portfoliosRoute);
  await app.register(transactionsRoute);

  return app;
}
