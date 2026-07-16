import { pgTable, uuid, text, boolean, jsonb, timestamp, primaryKey } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { portfolios } from "./portfolios.js";
import { trConnectionStatusEnum, ibkrConnectionStatusEnum } from "./enums.js";

export const trConnections = pgTable("tr_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
    onDelete: "set null",
  }),
  phoneEnc: text("phone_enc").notNull(),
  pinEnc: text("pin_enc").notNull(),
  sessionEnc: text("session_enc"),
  status: trConnectionStatusEnum("status").notNull().default("disconnected"),
  importCategories: jsonb("import_categories").$type<string[]>(),
  lastReconciliation: jsonb("last_reconciliation"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  syncing: boolean("syncing").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const trResolvedEvents = pgTable(
  "tr_resolved_events",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    source: text("source").notNull().default("pytr"),
    eventId: text("event_id").notNull(),
    resolution: text("resolution").notNull(),
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.source, t.eventId] })],
).enableRLS();

export const ibkrConnections = pgTable("ibkr_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
    onDelete: "set null",
  }),
  tokenEnc: text("token_enc").notNull(),
  queryId: text("query_id").notNull(),
  flexAccountId: text("flex_account_id"),
  status: ibkrConnectionStatusEnum("status").notNull().default("disconnected"),
  lastReconciliation: jsonb("last_reconciliation"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  syncing: boolean("syncing").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();
