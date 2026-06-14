import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, migrationsDir } from "@portfolio/db";

export type DB = PostgresJsDatabase<typeof schema>;

let dbInstance: DB | null = null;
let sql: ReturnType<typeof postgres> | null = null;
// PGlite (embedded Postgres) instance, used for tests / driverless local runs.
let pglite: { close: () => Promise<void> } | null = null;

const PGLITE_PREFIX = "pglite://";

function pgliteDataDir(url: string | undefined): string | undefined {
  if (url?.startsWith(PGLITE_PREFIX)) {
    const dir = url.slice(PGLITE_PREFIX.length);
    return dir.length > 0 ? dir : undefined;
  }
  return undefined;
}

/**
 * Use embedded PGlite for tests / when the URL opts in (`pglite://<dataDir>` or
 * empty); production uses a real Postgres via postgres-js.
 */
function usePglite(url: string | undefined): boolean {
  return process.env.NODE_ENV === "test" || !url || url.startsWith(PGLITE_PREFIX);
}

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
    // Remote Postgres (e.g. Supabase) requires SSL; local does not.
    const isLocal = /@(localhost|127\.0\.0\.1|0\.0\.0\.0|postgres)[:/]/.test(url!);
    sql = postgres(url!, { max: 10, ssl: isLocal ? undefined : "require" });
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
    await migrate(db as any, { migrationsFolder: migrationsDir });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: migrationsDir });
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
