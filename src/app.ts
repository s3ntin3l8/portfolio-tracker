import Fastify from "fastify";
import sensible from "@fastify/sensible";
import { envPlugin } from "./plugins/env.js";
import { loggingPlugin } from "./plugins/logging.js";
import { securityPlugin } from "./plugins/security.js";
import { dbPlugin } from "./plugins/db.js";
import { rootRoute } from "./routes/root.js";
import { healthRoute } from "./routes/health.js";
import { usersRoute } from "./routes/users.js";

export async function buildApp() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || "info",
    },
  });

  await app.register(envPlugin);
  await app.register(loggingPlugin);
  await app.register(sensible);
  await app.register(securityPlugin);
  await app.register(dbPlugin);

  await app.register(rootRoute);
  await app.register(healthRoute);
  await app.register(usersRoute);

  return app;
}
