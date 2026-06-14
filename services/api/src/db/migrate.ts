import { ensureDb, closeDb } from "./client.js";

/**
 * Standalone migration runner. Applies all pending Drizzle migrations (from
 * @portfolio/db) against DATABASE_URL, then exits. The API also migrates on startup
 * via the db plugin; this is for CI/deploy and manual runs. Load env with
 * `--env-file` (Node) or run via the `db:migrate` script.
 */
async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  await ensureDb(url);
  console.log("migrations applied");
  await closeDb();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
