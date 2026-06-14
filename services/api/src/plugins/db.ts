import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { ensureDb, closeDb, getDb, type DB } from "../db/client.js";
import { EncryptionService } from "../services/encryption.js";

export const dbPlugin = fp(async (app: FastifyInstance) => {
  // Run pending migrations and open the connection at startup.
  await ensureDb(app.config.DATABASE_URL);

  const db = getDb();
  const encryption = new EncryptionService({ key: app.config.DB_ENCRYPTION_KEY });

  app.decorate("db", db);
  app.decorate("encryption", encryption);

  app.addHook("onClose", async () => {
    await closeDb();
  });

  app.log.info({
    msg: "Database ready",
    encryption: encryption.isEnabled ? "enabled" : "disabled",
  });
});

declare module "fastify" {
  interface FastifyInstance {
    db: DB;
    encryption: EncryptionService;
  }
}
