import type { FastifyInstance } from "fastify";
import { sql } from "drizzle-orm";

export async function healthRoute(app: FastifyInstance) {
  // Liveness: the process is up and serving.
  app.get("/health", async () => {
    return { status: "healthy" };
  });

  // Readiness: dependencies (the database) are reachable.
  app.get("/ready", async (_request, reply) => {
    try {
      app.db.run(sql`SELECT 1`);
      return { status: "ready" };
    } catch (err) {
      app.log.error(err);
      reply.code(503);
      return { status: "unavailable" };
    }
  });
}
