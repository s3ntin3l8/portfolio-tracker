import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { trConnections } from "@portfolio/db";
import { serialize, getConnection } from "./tr/_shared.js";
import { registerPairingRoutes } from "./tr/pairing.js";
import { registerSyncRoutes } from "./tr/sync.js";
import { registerDocumentRoutes } from "./tr/documents.js";

export async function trRoute(app: FastifyInstance) {
  // Current connection state (no secrets).
  app.get("/tr/connection", { preHandler: app.authenticate }, async (request) => {
    const id = request.userId;
    return serialize(await getConnection(app, id));
  });

  registerPairingRoutes(app);
  registerSyncRoutes(app);
  registerDocumentRoutes(app);

  // Disconnect: wipe the stored connection (and any pending pairing).
  app.delete("/tr/connection", { preHandler: app.authenticate }, async (request, reply) => {
    const id = request.userId;
    app.pytr.cancelPairing(id);
    await app.db.delete(trConnections).where(eq(trConnections.userId, id));
    request.log.info({ userId: id }, "tr disconnected");
    reply.code(204);
    return null;
  });
}
