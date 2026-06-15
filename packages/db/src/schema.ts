import { relations, sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  numeric,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
} from "drizzle-orm/pg-core";

// --- Enums ---------------------------------------------------------------

export const assetClassEnum = pgEnum("asset_class", [
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
]);

export const unitEnum = pgEnum("unit", ["shares", "grams", "units"]);

export const txTypeEnum = pgEnum("transaction_type", [
  "buy",
  "sell",
  "dividend",
  "coupon",
  "fee",
  "split",
  "bonus",
  "rights",
  "savings_plan",
  "deposit",
  "withdrawal",
]);

export const txSourceEnum = pgEnum("transaction_source", [
  "screenshot",
  "csv",
  "manual",
  "pytr",
]);

export const corpActionTypeEnum = pgEnum("corporate_action_type", [
  "split",
  "bonus",
  "rights",
]);

export const importStatusEnum = pgEnum("import_status", [
  "draft",
  "confirmed",
  "discarded",
]);

// --- Tables --------------------------------------------------------------

// Users are keyed to the Authentik OIDC subject; the API never stores passwords.
export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  authSub: text("auth_sub").notNull().unique(),
  email: text("email").notNull(),
  name: text("name"),
  displayCurrency: text("display_currency").notNull().default("IDR"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const portfolios = pgTable(
  "portfolios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseCurrency: text("base_currency").notNull().default("IDR"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [index("portfolios_user_id_idx").on(t.userId)],
);

// Global reference data shared across users (not user-owned).
export const instruments = pgTable(
  "instruments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    isin: text("isin").unique(),
    symbol: text("symbol").notNull(),
    market: text("market").notNull(), // 'IDX' | 'XAU' | 'XETRA' | ...
    exchangeCode: text("exchange_code"), // cached for EU/ISIN resolution
    assetClass: assetClassEnum("asset_class").notNull(),
    unit: unitEnum("unit").notNull().default("shares"),
    currency: text("currency").notNull(),
    name: text("name").notNull(),
    // Bond-specific (nullable for non-bonds).
    faceValue: numeric("face_value"),
    couponRate: numeric("coupon_rate"),
    couponSchedule: text("coupon_schedule"), // e.g. 'semiannual'
    maturityDate: date("maturity_date"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("instruments_market_symbol_idx").on(t.market, t.symbol)],
);

// Screenshot/CSV import drafts. The raw image is deleted after a confirmed parse;
// the parsed JSON + audit link are retained.
export const screenshotImports = pgTable("screenshot_imports", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .references(() => users.id, { onDelete: "cascade" }),
  portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
    onDelete: "set null",
  }),
  storagePath: text("storage_path"), // null once the image is deleted
  parser: text("parser"), // claude | ollama | gemini | openrouter
  model: text("model"),
  parsedJson: jsonb("parsed_json"),
  confidence: numeric("confidence"),
  status: importStatusEnum("status").notNull().default("draft"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// The source of truth. Holdings, P&L, cash balance, XIRR and net worth are derived
// from these rows (in @portfolio/core), never stored.
export const transactions = pgTable(
  "transactions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    // Null for cash movements (deposit/withdrawal).
    instrumentId: uuid("instrument_id").references(() => instruments.id, {
      onDelete: "restrict",
    }),
    type: txTypeEnum("type").notNull(),
    quantity: numeric("quantity").notNull().default("0"), // in the instrument's unit
    price: numeric("price").notNull().default("0"),
    fees: numeric("fees").notNull().default("0"),
    currency: text("currency").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    source: txSourceEnum("source").notNull().default("manual"),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    savingsPlanId: text("savings_plan_id"),
    // Stable id from the source (broker ref / CSV row hash) for idempotent imports.
    externalId: text("external_id"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index("transactions_portfolio_id_idx").on(t.portfolioId),
    index("transactions_instrument_id_idx").on(t.instrumentId),
    // Prevent double-importing the same source row into a portfolio.
    uniqueIndex("transactions_dedup_idx")
      .on(t.portfolioId, t.source, t.externalId)
      .where(sql`${t.externalId} is not null`),
  ],
);

export const corporateActions = pgTable("corporate_actions", {
  id: uuid("id").primaryKey().defaultRandom(),
  instrumentId: uuid("instrument_id")
    .notNull()
    .references(() => instruments.id, { onDelete: "cascade" }),
  type: corpActionTypeEnum("type").notNull(),
  ratio: numeric("ratio").notNull(), // e.g. 2 for a 2:1 split
  exDate: date("ex_date").notNull(),
  terms: text("terms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// Historical daily closes.
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
);

// Latest-quote cache (one row per instrument).
export const lastPrices = pgTable("last_prices", {
  instrumentId: uuid("instrument_id")
    .primaryKey()
    .references(() => instruments.id, { onDelete: "cascade" }),
  price: numeric("price").notNull(),
  // Prior session's close, when the provider reports it — drives day-change/movers.
  previousClose: numeric("previous_close"),
  currency: text("currency").notNull(),
  asOf: timestamp("as_of", { withTimezone: true }).notNull(),
});

// FX rates for converting to a portfolio/display currency.
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
);

// --- Relations -----------------------------------------------------------

export const usersRelations = relations(users, ({ many }) => ({
  portfolios: many(portfolios),
}));

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  user: one(users, { fields: [portfolios.userId], references: [users.id] }),
  transactions: many(transactions),
}));

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  transactions: many(transactions),
  prices: many(prices),
  corporateActions: many(corporateActions),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  portfolio: one(portfolios, {
    fields: [transactions.portfolioId],
    references: [portfolios.id],
  }),
  instrument: one(instruments, {
    fields: [transactions.instrumentId],
    references: [instruments.id],
  }),
}));
