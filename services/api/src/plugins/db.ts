import fp from "fastify-plugin";
import type { FastifyInstance } from "fastify";
import { ensureDb, closeDb, getDb, setEncryption, warmPool, type DB } from "../db/client.js";
import { EncryptionService } from "../services/encryption.js";

export const dbPlugin = fp(async (app: FastifyInstance) => {
  // Run pending migrations and open the connection at startup.
  await ensureDb(app.config.DATABASE_URL);
  // Eagerly open a few pool connections now, at boot, instead of letting the first
  // real requests each pay a cold TCP+TLS handshake individually (see warmPool's doc
  // comment). Runs once per deploy, not per request.
  await warmPool();

  const db = getDb();
  const encryption = new EncryptionService({ key: app.config.DB_ENCRYPTION_KEY });

  app.decorate("db", db);
  app.decorate("encryption", encryption);
  // Make encryption available to service-layer code (e.g. resolveCredentials) that
  // doesn't have access to the Fastify app instance.
  setEncryption(encryption);

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
