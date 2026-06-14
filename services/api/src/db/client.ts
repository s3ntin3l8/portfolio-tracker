import path from "node:path";
import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

export type DB = PostgresJsDatabase<typeof schema>;

let dbInstance: DB | null = null;
let sql: ReturnType<typeof postgres> | null = null;
// PGlite (embedded Postgres) instance, used for tests / driverless local runs.
let pglite: { close: () => Promise<void> } | null = null;

const PGLITE_PREFIX = "pglite://";

/**
 * Use the embedded PGlite engine when running tests or when the URL opts into it
 * (`pglite://<dataDir>` or empty). This keeps unit tests self-contained — no
 * external Postgres required — while production uses a real Postgres via postgres-js.
 */
function pgliteDataDir(url: string | undefined): string | undefined {
  if (url?.startsWith(PGLITE_PREFIX)) {
    const dir = url.slice(PGLITE_PREFIX.length);
    return dir.length > 0 ? dir : undefined;
  }
  if (process.env.NODE_ENV === "test") return undefined; // in-memory
  return undefined;
}

function usePglite(url: string | undefined): boolean {
  return process.env.NODE_ENV === "test" || !url || url.startsWith(PGLITE_PREFIX);
}

const migrationsFolder = path.resolve(import.meta.dirname, "../../drizzle");

export async function initDb(databaseUrl?: string): Promise<DB> {
  if (dbInstance) return dbInstance;
  const url = databaseUrl ?? process.env.DATABASE_URL;

  if (usePglite(url)) {
    const { PGlite } = await import("@electric-sql/pglite");
    const { drizzle: drizzlePglite } = await import("drizzle-orm/pglite");
    const dataDir = pgliteDataDir(url);
    const client = dataDir ? new PGlite(dataDir) : new PGlite();
    pglite = client;
    dbInstance = drizzlePglite(client, { schema }) as unknown as DB;
  } else {
    sql = postgres(url!, { max: 10 });
    dbInstance = drizzlePostgres(sql, { schema });
  }

  return dbInstance;
}

export function getDb(): DB {
  if (!dbInstance) {
    throw new Error("Database not initialized — call initDb()/ensureDb() first");
  }
  return dbInstance;
}

export async function ensureDb(databaseUrl?: string): Promise<DB> {
  const db = await initDb(databaseUrl);
  if (pglite) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder });
  }
  return db;
}

export async function closeDb(): Promise<void> {
  if (sql) await sql.end();
  if (pglite) await pglite.close();
  sql = null;
  pglite = null;
  dbInstance = null;
}
