import { desc, sql } from "drizzle-orm";
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
import { portfolios } from "./portfolios.js";
import { instruments } from "./instruments.js";
import { screenshotImports } from "./screenshot-imports.js";
import { txTypeEnum, txStatusEnum, txSourceEnum } from "./enums.js";
import { loans } from "./loans.js";

export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    instrumentId: uuid("instrument_id").references(() => instruments.id, {
      onDelete: "restrict",
    }),
    type: txTypeEnum("type").notNull(),
    quantity: numeric("quantity").notNull().default("0"),
    price: numeric("price").notNull().default("0"),
    fees: numeric("fees").notNull().default("0"),
    tax: numeric("tax"),
    executedPrice: numeric("executed_price"),
    fxRate: numeric("fx_rate"),
    perShare: numeric("per_share"),
    shares: numeric("shares"),
    nativeCurrency: text("native_currency"),
    grossNative: numeric("gross_native"),
    vorabBase: numeric("vorab_base"),
    venue: text("venue"),
    documentRefs: jsonb("document_refs"),
    kind: text("kind"),
    status: txStatusEnum("status").notNull().default("normal"),
    description: text("description"),
    tags: text("tags").array(),
    currency: text("currency").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    source: txSourceEnum("source").notNull().default("manual"),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    savingsPlanId: text("savings_plan_id"),
    loanId: uuid("loan_id").references(() => loans.id, {
      onDelete: "set null",
    }),
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("transactions_portfolio_id_idx").on(t.portfolioId),
    index("transactions_portfolio_executed_at_idx").on(t.portfolioId, desc(t.executedAt)),
    index("transactions_instrument_id_idx").on(t.instrumentId),
    index("transactions_import_id_status_idx").on(t.importId, t.status),
    index("transactions_description_trgm_idx").using("gin", t.description.op("gin_trgm_ops")),
    uniqueIndex("transactions_dedup_idx")
      .on(t.portfolioId, t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
).enableRLS();
