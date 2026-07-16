import {
  pgTable,
  uuid,
  text,
  numeric,
  date,
  timestamp,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";
import { portfolios } from "./portfolios.js";

export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    netWorth: numeric("net_worth").notNull(),
    marketValue: numeric("market_value").notNull().default("0"),
    effectiveFlow: numeric("effective_flow").notNull().default("0"),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("portfolio_snapshots_portfolio_date_idx").on(t.portfolioId, t.date)],
).enableRLS();

export const portfolioIntradaySnapshots = pgTable(
  "portfolio_intraday_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    capturedAt: timestamp("captured_at", { withTimezone: true }).notNull(),
    netWorth: numeric("net_worth").notNull(),
    marketValue: numeric("market_value").notNull().default("0"),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("portfolio_intraday_snapshots_portfolio_captured_idx").on(t.portfolioId, t.capturedAt),
  ],
).enableRLS();
