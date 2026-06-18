import { z } from "zod";

// --- Shared enums (mirror @portfolio/db) ---------------------------------

export const assetClassSchema = z.enum([
  "equity",
  "gold",
  "bond",
  "mutual_fund",
  "etf",
  "crypto",
  "derivative",
]);
export type AssetClass = z.infer<typeof assetClassSchema>;

export const unitSchema = z.enum(["shares", "grams", "units"]);
export type Unit = z.infer<typeof unitSchema>;

export const transactionTypeSchema = z.enum([
  "buy",
  "sell",
  "dividend",
  "coupon",
  // Interest paid on uninvested cash — income, NOT a contribution (kept distinct from
  // `deposit` so it doesn't inflate invested capital / depress money-weighted return).
  "interest",
  "fee",
  "split",
  "bonus",
  "rights",
  "savings_plan",
  "deposit",
  "withdrawal",
  // Installment-financing legs (e.g. Pegadaian/Galeri24 gold cicilan). The outstanding
  // liability is derived from these; excluded from XIRR/contributions by design.
  "loan_drawdown",
  "loan_repayment",
]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const costBasisModeSchema = z.enum(["purchase_price", "total_paid"]);
export type CostBasisMode = z.infer<typeof costBasisModeSchema>;

export const transactionSourceSchema = z.enum([
  "screenshot",
  "csv",
  "manual",
  "pytr",
]);
export type TransactionSource = z.infer<typeof transactionSourceSchema>;

// --- Primitives ----------------------------------------------------------

// Money/quantities are decimal strings (matches Postgres `numeric`, preserves
// precision — never a float).
export const decimalString = z
  .string()
  .regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");

// ISO-4217-style 3-letter currency code, normalised to upper case.
export const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

// --- API inputs ----------------------------------------------------------

export const portfolioInputSchema = z.object({
  name: z.string().min(1),
  baseCurrency: currencyCode.default("IDR"),
  // "standard" | "child". Only child portfolios carry a beneficiary birth year
  // and the "to age 18" forecast target.
  portfolioType: z.enum(["standard", "child"]).default("standard"),
  // Optional beneficiary birth year (e.g. a child's account). Nullable so a PATCH
  // can clear it.
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  // Optional brokerage/custodian (free text). Nullable so a PATCH can clear it.
  brokerage: z.string().trim().nullable().optional(),
  // Optional name of the person the portfolio belongs to (free text). Nullable so a
  // PATCH can clear it.
  accountHolder: z.string().trim().nullable().optional(),
  // Optional account number (SID, IBAN, broker account ID). Used for auto-detecting
  // which portfolio a screenshot belongs to. Nullable so a PATCH can clear it.
  accountNumber: z.string().trim().nullable().optional(),
  // Whether this portfolio is included in the net-worth aggregate. Defaults to true
  // so new portfolios are counted without any explicit action.
  includeInAggregate: z.boolean().default(true),
});
export type PortfolioInput = z.infer<typeof portfolioInputSchema>;

// PATCH variant: every field optional and, crucially, WITHOUT the create-time
// defaults — a partial update must never reset an omitted field (e.g. silently
// flipping the currency back to IDR or the type back to "standard").
export const portfolioPatchSchema = z.object({
  name: z.string().min(1).optional(),
  baseCurrency: currencyCode.optional(),
  portfolioType: z.enum(["standard", "child"]).optional(),
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  brokerage: z.string().trim().nullable().optional(),
  accountHolder: z.string().trim().nullable().optional(),
  accountNumber: z.string().trim().nullable().optional(),
  includeInAggregate: z.boolean().optional(),
});
export type PortfolioPatch = z.infer<typeof portfolioPatchSchema>;

// Editable user profile fields. Both optional so the settings screen can PATCH a
// subset; identity fields (email, authSub) come from the IdP and are never updated here.
export const userUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  displayCurrency: currencyCode.optional(),
});
export type UserUpdate = z.infer<typeof userUpdateSchema>;

// Admin-editable market-data provider config (PATCH /admin/providers). The id must match
// a known registry provider (validated server-side); `enabled` toggles it and `priority`
// orders the fallback chain (lower = tried first). API keys are NOT set here (see #106).
export const providerSettingUpdateSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  priority: z.number().int().min(0),
});
export type ProviderSettingUpdate = z.infer<typeof providerSettingUpdateSchema>;
export const providerSettingsUpdateSchema = z.array(providerSettingUpdateSchema);

export const corporateActionTypeSchema = z.enum(["split", "bonus", "rights"]);
export type CorporateActionType = z.infer<typeof corporateActionTypeSchema>;

export const corporateActionInputSchema = z.object({
  instrumentId: z.guid(),
  type: corporateActionTypeSchema,
  ratio: decimalString,
  exDate: z.coerce.date(),
  terms: z.string().optional(),
});
export type CorporateActionInput = z.infer<typeof corporateActionInputSchema>;

export const instrumentInputSchema = z.object({
  isin: z.string().optional(),
  symbol: z.string().min(1),
  market: z.string().min(1),
  assetClass: assetClassSchema,
  unit: unitSchema.default("shares"),
  currency: currencyCode,
  name: z.string().min(1),
});
export type InstrumentInput = z.infer<typeof instrumentInputSchema>;

export const transactionInputSchema = z.object({
  portfolioId: z.guid(),
  instrumentId: z.guid().nullable().optional(),
  type: transactionTypeSchema,
  quantity: decimalString.default("0"),
  price: decimalString.default("0"),
  fees: decimalString.default("0"),
  // Informational only — broker's price/cash already nets tax; kept for reporting.
  tax: decimalString.nullable().optional(),
  // FX rate at execution for cross-currency holdings (units of base currency per foreign).
  fxRate: decimalString.nullable().optional(),
  // Free-text memo (e.g. counterparty name, card merchant, transfer IBAN).
  description: z.string().nullable().optional(),
  // User-defined labels for filtering/reporting.
  tags: z.array(z.string()).nullable().optional(),
  currency: currencyCode,
  executedAt: z.coerce.date(),
  source: transactionSourceSchema.default("manual"),
  externalId: z.string().optional(),
});
export type TransactionInput = z.infer<typeof transactionInputSchema>;

// --- Screenshot / CSV parse output ---------------------------------------

// Actions a parser can emit. Securities trades + income (buy/sell/dividend/coupon),
// plus the cash/savings-plan flows the DKB Girokonto import produces (a savings-plan
// execution behaves as a buy; deposit/withdrawal are instrument-less cash movements).
// `bonus` = shares received with no cash (stock dividend / corporate bonus issue) —
// mirrored from the DB transaction type so share-based corp actions can be auto-mapped.
export const parsedActionSchema = z.enum([
  "buy",
  "sell",
  "dividend",
  "coupon",
  "interest",
  "savings_plan",
  "deposit",
  "withdrawal",
  "bonus",
]);
export type ParsedAction = z.infer<typeof parsedActionSchema>;

// What a ScreenshotParser (or CSV row) yields — a *draft* the user confirms before
// it becomes a transaction. Never auto-committed. `assetClass`/`unit` are nullish so
// cash rows (deposit/withdrawal), which have no instrument, can be represented;
// `exchangeCode`/`externalId` are optional enrichments (e.g. a broker's booking ref).
export const parsedTransactionSchema = z.object({
  assetClass: assetClassSchema.nullish(),
  action: parsedActionSchema,
  ticker: z.string().nullish(),
  isin: z.string().nullish(),
  name: z.string().nullish(),
  quantity: decimalString,
  unit: unitSchema.nullish(),
  price: decimalString,
  fees: decimalString.default("0"),
  total: decimalString.nullish(),
  currency: currencyCode,
  executedAt: z.coerce.date(),
  exchangeCode: z.string().nullish(),
  externalId: z.string().nullish(),
  // Groups recurring savings-plan executions (set by the Trade Republic importer).
  savingsPlanId: z.string().nullish(),
  // Broker enrichment (Trade Republic): informational metadata persisted on the
  // transaction. `tax`/`fxRate`/`executedPrice` are decimal strings; `kind` distinguishes
  // saveback/roundup; `documentRefs` are source-document pointers (see issue #150).
  tax: decimalString.nullish(),
  executedPrice: decimalString.nullish(),
  fxRate: decimalString.nullish(),
  venue: z.string().nullish(),
  kind: z.string().nullish(),
  description: z.string().nullish(),
  documentRefs: z
    .array(
      z.object({
        id: z.string(),
        type: z.string().nullish(),
        date: z.string().nullish(),
      }),
    )
    .nullish(),
  confidence: z.number().min(0).max(1),
});
export type ParsedTransaction = z.infer<typeof parsedTransactionSchema>;

// --- Gold installment contract (Pegadaian / Galeri 24 "MULIA" cicilan) ----

// One row of the amortization schedule (Jadwal Angsuran): installment number, due
// date, principal portion (Pokok), financing margin (Sewa Modal), the total
// installment (Angsuran) and the remaining principal (Sisa Pokok).
export const loanScheduleRowSchema = z.object({
  n: z.number().int().positive(),
  dueDate: z.coerce.date(),
  pokok: decimalString,
  sewaModal: decimalString,
  angsuran: decimalString,
  sisaPokok: decimalString,
});
export type LoanScheduleRow = z.infer<typeof loanScheduleRowSchema>;

// A structured extraction of a financed gold-purchase contract. The vision model
// emits the RAW figures read off the (multi-page) contract; the API derives the
// transaction legs deterministically (see services/parsers/gold-contract). The
// gram weight comes from the Bukti Pembelian Emas page — never inferred from price.
export const parsedGoldContractSchema = z.object({
  provider: z.string().nullish(), // "GALERI24" | "PEGADAIAN"
  contractNo: z.string().nullish(), // No. Kontrak / No. Order
  currency: currencyCode.default("IDR"),
  grams: decimalString, // from the Bukti Pembelian Emas line item (e.g. "LM 50 Gram")
  goldName: z.string().nullish(), // "LM 50 Gram", seeds the instrument name
  purchasePrice: decimalString, // Harga Pembelian dari G24
  downPayment: decimalString.default("0"), // uang muka (Sejumlah Uang)
  adminFee: decimalString.default("0"), // Biaya Administrasi
  discount: decimalString.default("0"), // promo (Nominal), stored positive
  principal: decimalString, // Uang Pinjaman (financed amount)
  marginTotal: decimalString.default("0"), // total Sewa Modal
  tenorMonths: z.number().int().positive(), // Jangka Waktu (Bulan)
  monthlyInstallment: decimalString.default("0"), // Angsuran per Bulan
  startDate: z.coerce.date(), // Tgl Kredit
  costBasisMode: costBasisModeSchema.default("purchase_price"),
  schedule: z.array(loanScheduleRowSchema).default([]),
  confidence: z.number().min(0).max(1).default(1),
});
export type ParsedGoldContract = z.infer<typeof parsedGoldContractSchema>;

// A parse/skip outcome surfaced to the user instead of being silently dropped. `info` is
// ignorable (e.g. a card-verification ping); `attention` is something the user may want to
// map into a transaction. `raw` carries the source event fields to seed the mapping editor.
export const importIssueSchema = z.object({
  message: z.string(),
  severity: z.enum(["info", "attention"]).default("attention"),
  line: z.number().optional(),
  eventId: z.string().optional(),
  eventType: z.string().optional(),
  raw: z
    .object({
      isin: z.string().nullish(),
      name: z.string().nullish(),
      currency: z.string().nullish(),
      executedAt: z.string().nullish(),
      amount: z.number().nullish(),
      shares: z.number().nullish(),
    })
    .nullish(),
});
export type ImportIssue = z.infer<typeof importIssueSchema>;
