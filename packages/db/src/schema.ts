import { relations, sql } from "drizzle-orm";
import {
  pgEnum,
  pgTable,
  uuid,
  text,
  numeric,
  integer,
  boolean,
  timestamp,
  date,
  jsonb,
  uniqueIndex,
  index,
  primaryKey,
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
  // Interest on uninvested cash — income, not a contribution. See transactionTypeSchema.
  "interest",
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

export const trConnectionStatusEnum = pgEnum("tr_connection_status", [
  "disconnected",
  "awaiting_2fa",
  "connected",
  "expired",
  "error",
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
    // "standard" | "child". Child portfolios expose a beneficiary birth year and
    // the "to age 18" forecast target; standard portfolios hide both.
    portfolioType: text("portfolio_type").notNull().default("standard"),
    // Optional birth year of the account's beneficiary (e.g. a child's savings
    // account) — powers the "to age 18" forecast target.
    birthYear: integer("birth_year"),
    // Optional brokerage/custodian the portfolio is held at (e.g. Trade Republic,
    // DKB, Stockbit). Free text; powers the brokerage logo on the dashboard.
    brokerage: text("brokerage"),
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

// A user's link to their Trade Republic account (one per user for v1). Phone, PIN and
// the pytr cookie session are encrypted at rest (EncryptionService) — never plaintext.
// pytr sync writes drafts into screenshotImports (parser='pytr'); see services/pytr.
export const trConnections = pgTable("tr_connections", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id")
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: "cascade" }),
  // Which portfolio confirmed pytr transactions land in.
  portfolioId: uuid("portfolio_id").references(() => portfolios.id, {
    onDelete: "set null",
  }),
  phoneEnc: text("phone_enc").notNull(),
  pinEnc: text("pin_enc").notNull(),
  // The pytr cookie file contents (encrypted). Null until the 2FA pairing completes.
  sessionEnc: text("session_enc"),
  status: trConnectionStatusEnum("status").notNull().default("disconnected"),
  // Which event categories to stage as drafts (trade/income/cashflow/card). Null = the
  // default set (everything except day-to-day card spending). TR is a full bank account,
  // so this keeps card noise out of the portfolio unless explicitly opted in.
  importCategories: jsonb("import_categories").$type<string[]>(),
  // Last cash reconciliation: TR's reported balance vs our derived balance per currency.
  // { checkedAt, cash: [{ currency, reported, derived, diff }] }. Null until first synced.
  lastReconciliation: jsonb("last_reconciliation"),
  lastSyncAt: timestamp("last_sync_at", { withTimezone: true }),
  lastError: text("last_error"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// A durable record of Trade Republic timeline events the user has already resolved — either
// confirmed into a transaction or discarded. The sync excludes these from new drafts, so a
// purposely-deleted transaction (or a discarded draft) stays gone instead of resurfacing.
// Survives independent of the transactions table and the (ephemeral) collector draft; cleared
// only by an explicit re-import. Keyed by portfolio (one pytr connection ↔ one portfolio).
export const trResolvedEvents = pgTable(
  "tr_resolved_events",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull(),
    resolution: text("resolution").notNull(), // 'confirmed' | 'discarded'
    resolvedAt: timestamp("resolved_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.eventId] })],
);

// Server-wide market-data provider config, editable by admins from the UI. Global (not
// user-scoped) — this is a single-operator self-host setting. Rows OVERRIDE the env-derived
// defaults: a missing row means "use the registry default" (enabled if its key/url is set,
// default registration priority). Lower `priority` is tried first. API keys stay in env for
// now (see #106); only enable/disable + ordering live here.
export const providerSettings = pgTable("provider_settings", {
  // Registry id, e.g. "twelvedata" | "goldapi" | "antam" | "nav" | "eodhd" | "yahoo".
  provider: text("provider").primaryKey(),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Local count of API calls we've made per provider, used as the usage fallback for
// providers without a live usage endpoint (e.g. OpenFIGI) and as a cross-check for the
// rest. Windows roll over lazily on write (when `day`/`month` no longer match now).
export const providerUsage = pgTable("provider_usage", {
  provider: text("provider").primaryKey(),
  day: date("day"),
  callsDay: integer("calls_day").notNull().default(0),
  month: text("month"), // 'YYYY-MM'
  callsMonth: integer("calls_month").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Cache of values scraped from unofficial web sources (Antam gold buyback, reksa-dana
// NAV) by the scheduler and served back to the market-data providers via the internal
// routes. A cache, not primary state — safe to truncate; a missing/stale key just makes
// the provider fall through. Keys: "gold:antam-buyback" and "nav:<fund-symbol>".
export const scrapedQuotes = pgTable("scraped_quotes", {
  key: text("key").primaryKey(),
  value: numeric("value").notNull(),
  source: text("source"), // e.g. "harga-emas" | "bibit"
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
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
    // Tax withheld/corrected (e.g. dividend withholding, Steuerkorrektur). Informational —
    // the broker's `price`/cash already nets it; kept for reporting. Null = unknown.
    tax: numeric("tax"),
    // The broker's actual executed per-share price, when reported (TR's Aktienkurs). `price`
    // stays the cash-consistent figure; this is the truer cost-basis input for later use.
    executedPrice: numeric("executed_price"),
    // FX rate at execution for non-base-currency holdings (units of `currency` per foreign).
    fxRate: numeric("fx_rate"),
    venue: text("venue"), // execution venue/exchange when the broker reports it
    // Source-document references (e.g. TR postbox docs): [{ id, type, date }]. The actual
    // file URL is short-lived/presigned, so only the reference is stored (see issue #150).
    documentRefs: jsonb("document_refs"),
    // Sub-type within an action — e.g. saveback / roundup for TR savings-plan-funded buys.
    kind: text("kind"),
    description: text("description"), // memo: transfer counterparty (+ IBAN), card merchant
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

// Daily net-worth snapshots per portfolio — one row per (portfolio, date), in the
// portfolio's base currency. Powers the dashboard's value-over-time chart; written
// by the daily scheduler job and derived from transactions, so it's a cache, not
// primary state.
export const portfolioSnapshots = pgTable(
  "portfolio_snapshots",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    date: date("date").notNull(),
    netWorth: numeric("net_worth").notNull(),
    currency: text("currency").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("portfolio_snapshots_portfolio_date_idx").on(
      t.portfolioId,
      t.date,
    ),
  ],
);

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

export const usersRelations = relations(users, ({ one, many }) => ({
  portfolios: many(portfolios),
  trConnection: one(trConnections, {
    fields: [users.id],
    references: [trConnections.userId],
  }),
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
