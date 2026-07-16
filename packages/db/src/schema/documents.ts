import { sql } from "drizzle-orm";
import { pgTable, uuid, text, integer, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { users } from "./users.js";
import { portfolios } from "./portfolios.js";
import { screenshotImports } from "./screenshot-imports.js";
import { transactions } from "./transactions.js";

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
      onDelete: "cascade",
    }),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "cascade",
    }),
    transactionId: uuid("transaction_id").references(() => transactions.id, {
      onDelete: "cascade",
    }),
    storageKey: text("storage_key").notNull(),
    mimeType: text("mime_type").notNull(),
    originalFilename: text("original_filename"),
    sizeBytes: integer("size_bytes"),
    status: text("status").notNull().default("staged"),
    source: text("source"),
    sourceEventId: text("source_event_id"),
    category: text("category").notNull().default("receipt"),
    taxYear: integer("tax_year"),
    storedAt: timestamp("stored_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("documents_import_id_status_idx").on(t.importId, t.status),
    index("documents_transaction_id_status_idx").on(t.transactionId, t.status),
    index("documents_user_id_idx").on(t.userId),
    uniqueIndex("documents_user_source_event_unique_idx")
      .on(t.userId, t.sourceEventId)
      .where(sql`${t.sourceEventId} is not null and ${t.category} = 'tax_report'`),
  ],
).enableRLS();
