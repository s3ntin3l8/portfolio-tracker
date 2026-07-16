import { pgTable, uuid, text, numeric, date, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { instruments } from "./instruments.js";
import { dividendStatusEnum } from "./enums.js";

export const dividendEvents = pgTable(
  "dividend_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    exDate: date("ex_date").notNull(),
    payDate: date("pay_date"),
    amountPerShare: numeric("amount_per_share").notNull(),
    currency: text("currency").notNull(),
    status: dividendStatusEnum("status").notNull().default("announced"),
    source: text("source"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("dividend_events_instrument_exdate_idx").on(t.instrumentId, t.exDate)],
).enableRLS();

export const prices = pgTable(
  "prices",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    close: numeric("close").notNull(),
    currency: text("currency").notNull(),
  },
  (t) => [uniqueIndex("prices_instrument_date_idx").on(t.instrumentId, t.date)],
).enableRLS();

export const lastPrices = pgTable("last_prices", {
  instrumentId: uuid("instrument_id")
    .primaryKey()
    .references(() => instruments.id, { onDelete: "cascade" }),
  price: numeric("price").notNull(),
  previousClose: numeric("previous_close"),
  currency: text("currency").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
}).enableRLS();
