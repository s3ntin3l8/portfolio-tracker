import { drizzle as drizzlePostgres } from "drizzle-orm/postgres-js";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { schema, migrationsDir } from "@portfolio/db";
import { EncryptionService } from "../services/encryption.js";

export type DB = PostgresJsDatabase<typeof schema>;

// Module-level EncryptionService singleton, set by the db plugin at startup.
// `getEncryption()` returns a disabled (passthrough) instance until `setEncryption()`
// is called, so callers in tests / early boot get a safe no-op.
const _disabledEncryption = new EncryptionService({ key: "" });
let encryptionInstance: EncryptionService | null = null;

export function setEncryption(enc: EncryptionService): void {
  encryptionInstance = enc;
}

/** The app-wide encryption service. Returns a disabled passthrough before the db plugin runs. */
export function getEncryption(): EncryptionService {
  return encryptionInstance ?? _disabledEncryption;
}

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

// Drizzle's default migrate() runs all pending migrations in a single transaction.
// That breaks when migration N does `ALTER TYPE ADD VALUE` and migration N+1 uses
// the new value: Postgres requires the ALTER TYPE to be committed first (PG error
// 55P04). Run each file in its own BEGIN/COMMIT so the constraint is satisfied.
//
// Tracks by hash (not timestamp watermark) to survive migration file regeneration
// during development, where the same schema change gets a new folderMillis after a
// `db:generate` re-run.
async function migrateOneByOne(folder: string): Promise<void> {
  const { readMigrationFiles } = await import("drizzle-orm/migrator");
  const migrations = readMigrationFiles({ migrationsFolder: folder });

  const conn = sql!;
  await conn`CREATE SCHEMA IF NOT EXISTS drizzle`;
  await conn`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `;

  const applied = await conn<{ hash: string }[]>`
    SELECT hash FROM drizzle.__drizzle_migrations
  `;
  const appliedHashes = new Set(applied.map((r) => r.hash));

  for (const migration of migrations) {
    if (appliedHashes.has(migration.hash)) continue;

    await conn.begin(async (tx) => {
      for (const stmt of migration.sql) {
        await tx.unsafe(stmt);
      }
      await tx`
        INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
        VALUES (${migration.hash}, ${migration.folderMillis})
      `;
    });
  }
}

export async function ensureDb(databaseUrl?: string): Promise<DB> {
  const db = await initDb(databaseUrl);
  if (pglite) {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await migrate(db as any, { migrationsFolder: migrationsDir });
  } else {
    await migrateOneByOne(migrationsDir);
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
