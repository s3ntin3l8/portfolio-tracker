import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export const loggingPlugin = fp(async (app: FastifyInstance) => {
  // Reconcile: the Fastify logger was constructed with process.env.LOG_LEVEL before
  // envPlugin ran. Now that app.config is available and enum-validated, re-apply the
  // level so any .env default or validation coercion takes effect.
  app.log.level = app.config.LOG_LEVEL;
  app.log.debug({ level: app.config.LOG_LEVEL }, "logging configured");
});