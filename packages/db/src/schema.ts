import { relations, sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
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
  // Broker-credited cash bonus (e.g. TR Kindergeld/promo bonus) — lump-sum income,
  // not a user contribution. Distinct from `bonus` (zero-cash share receipts) and
  // `interest` (uninvested-cash interest) so it renders with its own "Bonus" label.
  "bonus_cash",
  // Financing legs for installment purchases (e.g. Pegadaian/Galeri24 gold cicilan).
  // Source of truth for the outstanding-liability balance; excluded from XIRR/
  // contributions by the deposit/withdrawal whitelists, so a loan is not a flow.
  "loan_drawdown",
  "loan_repayment",
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

export const dividendStatusEnum = pgEnum("dividend_status", [
  "announced", // ex-date known, amount may still change
  "paid",      // cash has settled; amount is final
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

// A person an investment account belongs to (the user themselves, a child, a
// spouse, …). Defined once per user and linked from any number of portfolios so
// shared details — birth year today, a per-person tax allowance later — live in one
// place instead of being re-entered per portfolio. See issue #207 and CLAUDE.md.
export const accountHolders = pgTable(
  "account_holders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    // "self" | "child" | "other". A portfolio is a child/Kinderdepot iff its holder
    // is "child" — the single source of child-ness (drives the "to age 18" forecast
    // target and the Trade Republic Kinderdepot guard).
    type: text("type").notNull().default("other"),
    // Optional birth year — powers the "to age 18" savings forecast for a child.
    birthYear: integer("birth_year"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("account_holders_user_id_idx").on(t.userId)],
);

export const portfolios = pgTable(
  "portfolios",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    baseCurrency: text("base_currency").notNull().default("IDR"),
    // The person this portfolio belongs to. Nullable — an unassigned portfolio is
    // treated as "standard" with no beneficiary. Child-ness, beneficiary birth year
    // and the display name all derive from the linked holder (see accountHolders).
    accountHolderId: uuid("account_holder_id").references(() => accountHolders.id, {
      onDelete: "set null",
    }),
    // Optional brokerage/custodian the portfolio is held at (e.g. Trade Republic,
    // DKB, Stockbit). Free text; powers the brokerage logo on the dashboard.
    brokerage: text("brokerage"),
    // Optional brokerage/bank account number (e.g. SID, IBAN). Used for auto-detecting
    // which portfolio a screenshot belongs to when the account number appears in the document.
    accountNumber: text("account_number"),
    includeInAggregate: boolean("include_in_aggregate").notNull().default(true),
    // Where this portfolio's investment boundary sits (see `@portfolio/core`
    // contributionStats and the "one boundary per portfolio" rule in CLAUDE.md).
    // `true` = cash is INSIDE the boundary (Tagesgeld/Festgeld/savings depot):
    // contribution = net external cash (deposits − withdrawals), and net worth
    // includes cash. `false` = cash is OUTSIDE (mixed/checking, invest-only):
    // contribution = net invested capital, cash is excluded from this portfolio's
    // net worth. Income is never a contribution in either case.
    cashCounted: boolean("cash_counted").notNull().default(false),
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
    wkn: text("wkn").unique(),
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
  /** djb2 hash of the raw upload bytes — used to detect re-uploads of the same file. */
  contentHash: text("content_hash"),
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

// Admin-managed credentials for data providers (market-data + vision). A DB row
// overrides the corresponding env var; the env value is the fallback when no row
// exists. Keys are encrypted at rest (EncryptionService, enc: prefix) — never
// plaintext. Writing a key requires app.encryption.isEnabled; the write route
// refuses and warns in the UI when encryption is disabled.
// The `provider` field namespaces both market-data and vision providers
// (e.g. "twelvedata", "vision:gemini") so one table serves both registries.
export const providerCredentials = pgTable("provider_credentials", {
  provider: text("provider").primaryKey(),
  apiKeyEnc: text("api_key_enc"),     // encrypted; null for url-only or keyless providers
  urlOverride: text("url_override"),  // optional endpoint override (e.g. ANTAM_BUYBACK_URL)
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Vision screenshot-parser provider config, editable by admins. Mirrors
// provider_settings for the market-data chain (enable/priority DB-override env defaults).
export const visionProviderSettings = pgTable("vision_provider_settings", {
  provider: text("provider").primaryKey(), // e.g. "claude" | "gemini" | "openrouter" | "ollama"
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// Immutable audit trail for admin actions on provider config / credentials.
// actor_sub = the Authentik OIDC subject (not our DB user id) so the record
// survives user-row deletion. Secret values are NEVER logged — only the action + target.
export const adminAuditLog = pgTable("admin_audit_log", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorSub: text("actor_sub").notNull(),
  // "set_credential" | "clear_credential" | "update_providers" | "update_vision_providers" | "update_import_settings"
  action: text("action").notNull(),
  target: text("target").notNull(), // provider id, e.g. "twelvedata" or "vision:gemini"
  meta: jsonb("meta"),              // non-secret context, e.g. { keyHint: "••••abc1" }
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
});

// Global, single-row config for the unstructured import path (screenshots + PDFs),
// editable by admins from the UI. A single-operator self-host setting, so it is a
// singleton row (always id=1). `strategy` picks the FIRST extraction choice:
//   "parser_first" — try the deterministic broker parser (e.g. DKB securities PDFs),
//                    fall back to the vision-LLM for anything it doesn't recognise.
//   "vision_only"  — skip the deterministic parser entirely; always use the vision-LLM.
// Does NOT affect CSV imports (their own deterministic /imports/csv path). A missing
// row means the "parser_first" default.
export const importSettings = pgTable("import_settings", {
  id: integer("id").primaryKey().default(1), // enforced singleton (always id=1)
  strategy: text("strategy").notNull().default("parser_first"),
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
    // User-defined labels (e.g. ["tax-loss", "rebalance"]) for filtering and reporting.
    tags: text("tags").array(),
    currency: text("currency").notNull(),
    executedAt: timestamp("executed_at", { withTimezone: true }).notNull(),
    source: txSourceEnum("source").notNull().default("manual"),
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    savingsPlanId: text("savings_plan_id"),
    // Links a financing leg (and its paired buy) to the loan it belongs to. Null for
    // ordinary transactions. The outstanding balance is derived from these legs.
    loanId: uuid("loan_id").references((): AnyPgColumn => loans.id, {
      onDelete: "set null",
    }),
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

// Installment-financing contracts (e.g. Pegadaian/Galeri24 gold "MULIA" cicilan).
// Holds the immutable contract TERMS and amortization schedule only — never the
// outstanding balance, which is always derived in @portfolio/core from the loan's
// loan_drawdown/loan_repayment legs (mirrors how corporateActions store terms while
// the effect is derived). The financed asset is linked via instrumentId.
export const loans = pgTable(
  "loans",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    // The financed gold position.
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "restrict" }),
    // Audit link to the import that created the loan (so undo can remove it).
    importId: uuid("import_id").references(() => screenshotImports.id, {
      onDelete: "set null",
    }),
    contractNo: text("contract_no"),
    provider: text("provider"), // e.g. "GALERI24" | "PEGADAIAN"
    purchasePrice: numeric("purchase_price").notNull(), // G24 gold price (Harga Pembelian)
    downPayment: numeric("down_payment").notNull().default("0"), // uang muka
    adminFee: numeric("admin_fee").notNull().default("0"), // Biaya Administrasi
    discount: numeric("discount").notNull().default("0"), // promo (stored positive)
    principal: numeric("principal").notNull(), // Uang Pinjaman (financed amount)
    marginTotal: numeric("margin_total").notNull().default("0"), // total Sewa Modal
    tenorMonths: integer("tenor_months").notNull(),
    monthlyInstallment: numeric("monthly_installment").notNull().default("0"),
    startDate: date("start_date").notNull(), // Tgl Kredit
    // [{ n, dueDate, pokok, sewaModal, angsuran, sisaPokok }] — the full Jadwal Angsuran.
    schedule: jsonb("schedule"),
    // Default cost-basis presentation: 'purchase_price' | 'total_paid'.
    costBasisMode: text("cost_basis_mode").notNull().default("purchase_price"),
    currency: text("currency").notNull().default("IDR"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("loans_portfolio_id_idx").on(t.portfolioId),
    uniqueIndex("loans_portfolio_contract_idx")
      .on(t.portfolioId, t.provider, t.contractNo)
      .where(sql`${t.contractNo} is not null`),
  ],
);

// Provider-sourced dividend events: announced ex-dates and settled payments. Deduped
// by (instrumentId, exDate) — an upsert from the scheduler updates the amount and
// status as more information becomes available (announced → paid).
export const dividendEvents = pgTable(
  "dividend_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    instrumentId: uuid("instrument_id")
      .notNull()
      .references(() => instruments.id, { onDelete: "cascade" }),
    // The date the stock goes ex-dividend — the deduplication anchor.
    exDate: date("ex_date").notNull(),
    // Cash settlement date; may arrive days after ex-date, or be null when not yet announced.
    payDate: date("pay_date"),
    // Per-share cash amount in the instrument's native currency (unadjusted).
    amountPerShare: numeric("amount_per_share").notNull(),
    currency: text("currency").notNull(),
    status: dividendStatusEnum("status").notNull().default("announced"),
    // Provider that last wrote this row (debug/audit only; not a dedup key).
    source: text("source"),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("dividend_events_instrument_exdate_idx").on(t.instrumentId, t.exDate),
  ],
);

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
    /** Holdings market value (excl. cash), in the portfolio's base currency. Used for TWR. */
    marketValue: numeric("market_value").notNull().default("0"),
    /** Effective capital flow on this day (buys − sells − income for realSeries), base currency. */
    effectiveFlow: numeric("effective_flow").notNull().default("0"),
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
  accountHolders: many(accountHolders),
  trConnection: one(trConnections, {
    fields: [users.id],
    references: [trConnections.userId],
  }),
}));

export const accountHoldersRelations = relations(accountHolders, ({ one, many }) => ({
  user: one(users, { fields: [accountHolders.userId], references: [users.id] }),
  portfolios: many(portfolios),
}));

export const portfoliosRelations = relations(portfolios, ({ one, many }) => ({
  user: one(users, { fields: [portfolios.userId], references: [users.id] }),
  accountHolder: one(accountHolders, {
    fields: [portfolios.accountHolderId],
    references: [accountHolders.id],
  }),
  transactions: many(transactions),
  loans: many(loans),
}));

export const instrumentsRelations = relations(instruments, ({ many }) => ({
  transactions: many(transactions),
  prices: many(prices),
  corporateActions: many(corporateActions),
  dividendEvents: many(dividendEvents),
  loans: many(loans),
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
  loan: one(loans, {
    fields: [transactions.loanId],
    references: [loans.id],
  }),
}));

export const loansRelations = relations(loans, ({ one, many }) => ({
  portfolio: one(portfolios, {
    fields: [loans.portfolioId],
    references: [portfolios.id],
  }),
  instrument: one(instruments, {
    fields: [loans.instrumentId],
    references: [instruments.id],
  }),
  transactions: many(transactions),
}));
