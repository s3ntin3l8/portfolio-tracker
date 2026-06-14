import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";

export const loggingPlugin = fp(async (app: FastifyInstance) => {
  app.log.level = app.config.LOG_LEVEL;
  app.log.info({ msg: "Logging configured", level: app.config.LOG_LEVEL });
});