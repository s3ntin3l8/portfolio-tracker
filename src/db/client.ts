import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import * as schema from "./schema.js";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import path from "node:path";
import fs from "node:fs";

let dbInstance: ReturnType<typeof drizzle> | null = null;
let sqliteInstance: Database.Database | null = null;

export function getDb(databaseUrl?: string) {
  if (dbInstance) return dbInstance;

  const url = databaseUrl || process.env.DATABASE_URL || "file:./data/app.db";
  const dbPath = url.replace("file:", "");

  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  sqliteInstance = new Database(dbPath);
  dbInstance = drizzle(sqliteInstance, { schema });

  return dbInstance;
}

export function closeDb() {
  if (sqliteInstance) {
    sqliteInstance.close();
  }
  sqliteInstance = null;
  dbInstance = null;
}

export function ensureDb(databaseUrl?: string) {
  const db = getDb(databaseUrl);
  const migrationsFolder = path.resolve("drizzle");
  migrate(db, { migrationsFolder });
  return db;
}