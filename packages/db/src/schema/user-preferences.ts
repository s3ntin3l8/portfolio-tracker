import {
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  jsonb,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./users.js";

export const userPreferences = pgTable("user_preferences", {
  userId: uuid("user_id")
    .primaryKey()
    .references(() => users.id, { onDelete: "cascade" }),
  dashboardPeriod: text("dashboard_period").notNull().default("max"),
  dashboardKpis: jsonb("dashboard_kpis").$type<string[]>(),
  costBasisMode: text("cost_basis_mode").notNull().default("purchase_price"),
  taxRegime: text("tax_regime").notNull().default("DE"),
  benchmarkSymbol: text("benchmark_symbol"),
  riskFreeRate: numeric("risk_free_rate"),
  retirementAge: integer("retirement_age"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}).enableRLS();

export const benchmarkPrices = pgTable(
  "benchmark_prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    date: date("date").notNull(),
    close: numeric("close").notNull(),
    currency: text("currency").notNull().default("USD"),
    source: text("source").notNull().default("yahoo"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("benchmark_prices_user_symbol_date_idx").on(t.userId, t.symbol, t.date),
    index("benchmark_prices_user_symbol_idx").on(t.userId, t.symbol),
  ],
).enableRLS();

export const fxRates = pgTable(
  "fx_rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    base: text("base").notNull(),
    quote: text("quote").notNull(),
    rate: numeric("rate").notNull(),
    date: date("date").notNull(),
  },
  (t) => [uniqueIndex("fx_rates_base_quote_date_idx").on(t.base, t.quote, t.date)],
).enableRLS();
