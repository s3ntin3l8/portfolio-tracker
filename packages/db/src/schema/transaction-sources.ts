import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { transactions } from "./transactions.js";
import { screenshotImports } from "./screenshot-imports.js";
import { documents } from "./documents.js";
import { txSourceTypeEnum } from "./enums.js";

export const transactionSources = pgTable(
  "transaction_sources",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    transactionId: uuid("transaction_id")
      .notNull()
      .references(() => transactions.id, { onDelete: "cascade" }),
    sourceType: txSourceTypeEnum("source_type").notNull(),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id"),
    orderRef: text("order_ref"),
    tax: numeric("tax"),
    fees: numeric("fees"),
    executedPrice: numeric("executed_price"),
    fxRate: numeric("fx_rate"),
    perShare: numeric("per_share"),
    shares: numeric("shares"),
    nativeCurrency: text("native_currency"),
    grossNative: numeric("gross_native"),
    vorabBase: numeric("vorab_base"),
    venue: text("venue"),
    taxComponents: jsonb("tax_components"),
    confidence: numeric("confidence"),
    rawData: jsonb("raw_data"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transaction_sources_tx_id_idx").on(t.transactionId),
    index("transaction_sources_document_id_idx").on(t.documentId),
    uniqueIndex("transaction_sources_dedup_idx")
      .on(t.transactionId, t.sourceType, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
).enableRLS();
