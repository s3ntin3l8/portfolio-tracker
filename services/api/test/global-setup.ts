import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { migrationsDir } from "@portfolio/db";

// Shared with test/setup.ts, which copies from this path into each file's own tmp
// dir. No cross-process handoff is needed beyond agreeing on this path — both this
// file (Vitest's main process) and test/setup.ts (a per-file worker process) compute
// the identical value deterministically.
export const PGLITE_TEMPLATE_DIR = path.join(os.tmpdir(), "portfolio-vitest-pglite-template");

/**
 * Runs once per `services/api` project run, in Vitest's main process, before any test
 * worker spawns. Builds one fully-migrated PGlite data directory that test/setup.ts
 * copies into each file's own tmp dir instead of every one of the ~55 DB-backed test
 * files independently bootstrapping a fresh PGlite cluster + replaying all 60
 * migrations (measured at ~1.4s per file; copying a pre-built dir instead measured at
 * ~0.13s — a ~10x reduction, with each copy fully independent of the template and of
 * every other copy).
 */
export default async function setup(): Promise<() => void> {
  fs.rmSync(PGLITE_TEMPLATE_DIR, { recursive: true, force: true });
  const client = new PGlite(PGLITE_TEMPLATE_DIR, { extensions: { pg_trgm } });
  const db = drizzle(client, {});
  await migrate(db, { migrationsFolder: migrationsDir });
  // Must close cleanly before any file copies from this directory, or the snapshot on
  // disk can be left in an inconsistent state.
  await client.close();

  return () => {
    fs.rmSync(PGLITE_TEMPLATE_DIR, { recursive: true, force: true });
  };
}
