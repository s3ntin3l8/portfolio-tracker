import {
  pgTable,
  uuid,
  text,
  boolean,
  integer,
  date,
  numeric,
  jsonb,
  timestamp,
} from "drizzle-orm/pg-core";

export const providerSettings = pgTable("provider_settings", {
  provider: text("provider").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const providerUsage = pgTable("provider_usage", {
  provider: text("provider").primaryKey(),
  day: date("day"),
  callsDay: integer("calls_day").notNull().default(0),
  month: text("month"),
  callsMonth: integer("calls_month").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const scrapedQuotes = pgTable("scraped_quotes", {
  key: text("key").primaryKey(),
  value: numeric("value").notNull(),
  source: text("source"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const providerCredentials = pgTable("provider_credentials", {
  provider: text("provider").primaryKey(),
  apiKeyEnc: text("api_key_enc"),
  urlOverride: text("url_override"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const visionProviderSettings = pgTable("vision_provider_settings", {
  provider: text("provider").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorSub: text("actor_sub").notNull(),
  action: text("action").notNull(),
  target: text("target").notNull(),
  meta: jsonb("meta"),
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const importSettings = pgTable("import_settings", {
  id: integer("id").primaryKey().default(1),
  strategy: text("strategy").notNull().default("parser_first"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const storageSettings = pgTable("storage_settings", {
  id: integer("id").primaryKey().default(1),
  activeProvider: text("active_provider").notNull().default("s3"),
  s3Endpoint: text("s3_endpoint"),
  s3Region: text("s3_region"),
  s3Bucket: text("s3_bucket"),
  s3AccessKeyId: text("s3_access_key_id"),
  s3ForcePathStyle: boolean("s3_force_path_style"),
  s3SignedUrlTtl: integer("s3_signed_url_ttl"),
  s3SecretAccessKeyEnc: text("s3_secret_access_key_enc"),
  folderPath: text("folder_path"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
