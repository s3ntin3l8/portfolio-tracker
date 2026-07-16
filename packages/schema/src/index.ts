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
  // A standalone tax debit NOT tied to a disposal — e.g. German Vorabpauschale (advance
  // lump-sum fund tax). Cash outflow (like `fee`), never income or a contribution.
  // Withholding tax *on* a dividend/sale stays in the transaction `tax` FIELD, not here.
  "tax",
  "split",
  "bonus",
  "rights",
  "savings_plan",
  "deposit",
  "withdrawal",
  // Broker-credited cash bonus (e.g. TR Kindergeld/promo bonus) — lump-sum income,
  // not a user contribution. Distinct from `bonus` (which means zero-cash share receipts)
  // and `interest` (uninvested-cash interest) so it can be labelled "Bonus" in the UI.
  "bonus_cash",
  // Installment-financing legs (e.g. Pegadaian/Galeri24 gold cicilan). The outstanding
  // liability is derived from these; excluded from XIRR/contributions by design.
  "loan_drawdown",
  "loan_repayment",
  // Depot-to-depot securities transfers (Depotübertrag). Cash-neutral — shares move
  // in/out at the user's carried cost basis, not at market. NOT a contribution (transfer_in
  // is capital already owned, not new money injected) — BUT for cash-inside portfolios the
  // carried cost is counted as contributed value (see contributions.ts insideMonths).
  // Replaces the former `bonus` + `kind:"transfer_in"` convention (PR #309).
  "transfer_in",
  "transfer_out",
  // Manual, null-instrument signed cash true-up. `price` carries the signed EUR delta
  // (user-entered, not derived from `type`). For known broker-feed-vs-reality gaps with
  // no feed-side signal to detect automatically — a bookkeeping correction, never a
  // contribution, never a trade, excluded from XIRR. Manual-only: never emitted by an
  // importer, so it is NOT in `parsedActionSchema` below.
  "adjustment",
]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const costBasisModeSchema = z.enum(["purchase_price", "total_paid"]);
export type CostBasisMode = z.infer<typeof costBasisModeSchema>;

export const transactionSourceSchema = z.enum(["screenshot", "csv", "manual", "pytr", "pdf"]);
export type TransactionSource = z.infer<typeof transactionSourceSchema>;

// Parse-confidence cutoff (0–1): a source row below this is "low confidence" and its draft is
// flagged for review. Deterministic parsers emit 1; only lossy LLM-vision parses fall under it.
// Shared so the API ("needs review" marker) and the web (import-review badge/filter) agree.
export const LOW_CONFIDENCE_THRESHOLD = 0.9;

// --- Primitives ----------------------------------------------------------

// Money/quantities are decimal strings (matches Postgres `numeric`, preserves
// precision — never a float).
export const decimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "must be a decimal string");

// ISO-4217-style 3-letter currency code, normalised to upper case.
export const currencyCode = z
  .string()
  .trim()
  .length(3)
  .transform((s) => s.toUpperCase());

// --- API inputs ----------------------------------------------------------

// A person an investment account belongs to. Birth year + type live here (not on
// the portfolio) so they are entered once and shared across that person's portfolios.
export const accountHolderInputSchema = z.object({
  name: z.string().trim().min(1),
  // "self" | "child" | "other". A portfolio whose holder is "child" is treated as a
  // child/Kinderdepot (drives the "to age 18" forecast and the TR Kinderdepot guard).
  type: z.enum(["self", "child", "other"]).default("other"),
  // Optional birth year — powers the "to age 18" forecast for a child.
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  // German tax profile (all optional).
  taxAllowanceAnnual: decimalString.nullable().optional(),
  capitalGainsTaxRate: decimalString.nullable().optional(),
  churchTax: z.boolean().nullable().optional(),
  taxResidence: z.string().trim().length(2).nullable().optional(),
});
export type AccountHolderInput = z.infer<typeof accountHolderInputSchema>;

// PATCH variant: every field optional, without create-time defaults.
export const accountHolderPatchSchema = z.object({
  name: z.string().trim().min(1).optional(),
  type: z.enum(["self", "child", "other"]).optional(),
  birthYear: z.number().int().min(1900).max(2100).nullable().optional(),
  // German tax profile fields (all optional; null clears the value).
  // Annual Sparerpauschbetrag — decimal string, e.g. "1000" (€1,000).
  taxAllowanceAnnual: decimalString.nullable().optional(),
  // Flat Kapitalertragsteuer rate — decimal string, e.g. "0.25" (25%).
  capitalGainsTaxRate: decimalString.nullable().optional(),
  // Church-tax surcharge flag.
  churchTax: z.boolean().nullable().optional(),
  // ISO-3166-1 alpha-2 tax residence, e.g. "DE".
  taxResidence: z.string().trim().length(2).nullable().optional(),
});
export type AccountHolderPatch = z.infer<typeof accountHolderPatchSchema>;

export const portfolioInputSchema = z.object({
  name: z.string().min(1),
  baseCurrency: currencyCode.default("IDR"),
  // The person this portfolio belongs to. Child-ness and beneficiary birth year
  // derive from this holder. Nullable so a PATCH can unassign it.
  accountHolderId: z.guid().nullable().optional(),
  // Optional brokerage/custodian (free text). Nullable so a PATCH can clear it.
  brokerage: z.string().trim().nullable().optional(),
  // Optional account number (SID, depot number, broker account ID). Used for auto-detecting
  // which portfolio a screenshot belongs to. Nullable so a PATCH can clear it.
  accountNumber: z.string().trim().nullable().optional(),
  // Optional IBAN, matched alongside accountNumber during import auto-detect. Nullable so a
  // PATCH can clear it.
  iban: z.string().trim().nullable().optional(),
  // Whether this portfolio is included in the net-worth aggregate. Defaults to true
  // so new portfolios are counted without any explicit action.
  includeInAggregate: z.boolean().default(true),
  // Where this portfolio's investment boundary sits. `true` = cash inside the
  // boundary (savings/deposit account): contribution = net external cash, net worth
  // includes cash. `false` (default) = cash outside (mixed/invest-only): contribution
  // = net invested capital, cash excluded from net worth.
  cashCounted: z.boolean().default(false),
  // Opt-out for the negative-cash data-integrity guard. When true, the cash balance may dip
  // below zero without flagging — for accounts where a buy routinely posts before its funding
  // deposit clears. Only meaningful when cashCounted is true. Defaults to false.
  allowNegativeCash: z.boolean().default(false),
  // Opt-in source-document retention (issue #231). When false (default), uploaded
  // PDFs/screenshots are parsed in memory and never persisted (privacy-by-default).
  // When true, the source file is kept after import confirmation.
  documentRetention: z.boolean().default(false),
  // Per-depot Freistellungsauftrag (FSA) allocation in EUR. Must not exceed the holder's
  // taxAllowanceAnnual cap (€1,000 single / €2,000 jointly assessed). Null = no FSA
  // submitted for this depot; the tax page shows "unconfigured" until filled in.
  taxAllowanceAnnual: decimalString.nullable().optional(),
});
export type PortfolioInput = z.infer<typeof portfolioInputSchema>;

// PATCH variant: every field optional and, crucially, WITHOUT the create-time
// defaults — a partial update must never reset an omitted field (e.g. silently
// flipping the currency back to IDR or the type back to "standard").
export const portfolioPatchSchema = z.object({
  name: z.string().min(1).optional(),
  baseCurrency: currencyCode.optional(),
  accountHolderId: z.guid().nullable().optional(),
  brokerage: z.string().trim().nullable().optional(),
  accountNumber: z.string().trim().nullable().optional(),
  iban: z.string().trim().nullable().optional(),
  includeInAggregate: z.boolean().optional(),
  cashCounted: z.boolean().optional(),
  allowNegativeCash: z.boolean().optional(),
  documentRetention: z.boolean().optional(),
  taxAllowanceAnnual: decimalString.nullable().optional(),
});
export type PortfolioPatch = z.infer<typeof portfolioPatchSchema>;

// Editable user profile fields. Both optional so the settings screen can PATCH a
// subset; identity fields (email, authSub) come from the IdP and are never updated here.
export const userUpdateSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  displayCurrency: currencyCode.optional(),
});
export type UserUpdate = z.infer<typeof userUpdateSchema>;

// Personal access token creation (POST /me/tokens). `scope` defaults to read-only —
// the safer default for a long-lived credential. `expiresInDays`, when given, sets an
// absolute expiry; omit it for a non-expiring token.
export const apiTokenCreateSchema = z.object({
  name: z.string().min(1).max(120),
  scope: z.enum(["read", "write"]).default("read"),
  expiresInDays: z.number().int().positive().max(3650).optional(),
});
export type ApiTokenCreate = z.infer<typeof apiTokenCreateSchema>;

// Admin-editable market-data or vision provider config (PATCH /admin/providers or
// PATCH /admin/vision-providers). The id must match a known registry provider
// (validated server-side); `enabled` toggles it and `priority` orders the fallback
// chain (lower = tried first).
export const providerSettingUpdateSchema = z.object({
  id: z.string().min(1),
  enabled: z.boolean(),
  priority: z.number().int().min(0),
});
export type ProviderSettingUpdate = z.infer<typeof providerSettingUpdateSchema>;
export const providerSettingsUpdateSchema = z.array(providerSettingUpdateSchema);

// Admin credential write body (PUT /admin/providers/:id/credential or
// PUT /admin/vision-providers/:id/credential). At least one of apiKey or urlOverride
// must be provided. Storing a key requires encryption to be enabled server-side.
export const providerCredentialSchema = z
  .object({
    apiKey: z.string().min(1).optional(),
    urlOverride: z.string().url().optional(),
  })
  .refine((v) => v.apiKey !== undefined || v.urlOverride !== undefined, {
    message: "at least one of apiKey or urlOverride is required",
  });
export type ProviderCredentialInput = z.infer<typeof providerCredentialSchema>;

// Global import strategy for the unstructured path (screenshots + PDFs), editable by
// admins (GET/PATCH /admin/import-settings). Picks the FIRST extraction choice:
//   "parser_first" — deterministic broker parser first, vision-LLM fallback (default).
//   "vision_only"  — always use the vision-LLM; skip the deterministic parser.
// Does not affect CSV imports.
export const importStrategySchema = z.enum(["parser_first", "vision_only"]);
export type ImportStrategy = z.infer<typeof importStrategySchema>;
export const importSettingsUpdateSchema = z.object({
  strategy: importStrategySchema,
});
export type ImportSettingsUpdate = z.infer<typeof importSettingsUpdateSchema>;

// Admin storage provider config (GET/PATCH /admin/storage-providers).
// Single-active selection: the admin picks one backend at a time.
export const storageProviderSchema = z.enum(["s3", "folder"]);
export type StorageProviderType = z.infer<typeof storageProviderSchema>;

// Update body for PATCH /admin/storage-providers (non-secret fields only).
// Null values clear the DB override and revert to the env default.
export const storageSettingsUpdateSchema = z.object({
  activeProvider: storageProviderSchema.optional(),
  s3Endpoint: z.string().nullable().optional(),
  s3Region: z.string().min(1).nullable().optional(),
  s3Bucket: z.string().min(1).nullable().optional(),
  s3AccessKeyId: z.string().nullable().optional(),
  s3ForcePathStyle: z.boolean().nullable().optional(),
  s3SignedUrlTtl: z.number().int().positive().nullable().optional(),
  folderPath: z.string().nullable().optional(),
});
export type StorageSettingsUpdate = z.infer<typeof storageSettingsUpdateSchema>;

// Body for PUT /admin/storage-providers/s3/secret.
export const storageSecretSchema = z.object({
  apiKey: z.string().min(1),
});
export type StorageSecretInput = z.infer<typeof storageSecretSchema>;

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
  wkn: z.string().optional(),
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
  // Dividend/coupon per-share rate + shares paid on (income rows only, manual entry —
  // see parsedTransactionSchema for the same fields on the import path). Informational;
  // `price`/`quantity` keep their existing net-cash / zero-quantity semantics.
  perShare: decimalString.nullable().optional(),
  shares: decimalString.nullable().optional(),
  // The instrument's native currency for a foreign-currency income payment, when it
  // differs from `currency` (which stays the cash actually credited).
  nativeCurrency: currencyCode.nullable().optional(),
  // Gross payment amount in `nativeCurrency`, before FX conversion and withholding tax.
  grossNative: decimalString.nullable().optional(),
  // Free-text memo (e.g. counterparty name, card merchant, transfer IBAN).
  description: z.string().nullable().optional(),
  // User-defined labels for filtering/reporting.
  tags: z.array(z.string()).nullable().optional(),
  currency: currencyCode,
  executedAt: z.coerce.date(),
  source: transactionSourceSchema.default("manual"),
  externalId: z.string().optional(),
  // Sub-type within an action (e.g. saveback / roundup for TR; merger for fund mergers;
  // transfer_in for free share receipts). Validated loosely so legacy/unrecognised strings
  // don't 400; the UI constrains input to the known set.
  kind: z.string().nullable().optional(),
});
export type TransactionInput = z.infer<typeof transactionInputSchema>;

// A fund merger / Fondsverschmelzung (ISIN change): the old instrument's position is
// closed and the new one opened, carrying cost basis — recorded as a paired sell+buy
// (both `kind:"merger"`, see the mergers route). `taxable` (steuerwirksam) deems a
// disposal at `marketValue`, realizing the gain and stepping the new basis up to market;
// otherwise the basis carries with no realized gain. Quantities differ by the exchange
// ratio. The legs' currency is derived from the instruments (must match).
export const mergerInputSchema = z
  .object({
    portfolioId: z.guid(),
    fromInstrumentId: z.guid(),
    toInstrumentId: z.guid(),
    outQty: decimalString,
    inQty: decimalString,
    executedAt: z.coerce.date(),
    taxable: z.boolean().default(false),
    marketValue: decimalString.optional(),
  })
  .refine((v) => v.fromInstrumentId !== v.toInstrumentId, {
    message: "from and to instruments must differ",
    path: ["toInstrumentId"],
  })
  .refine((v) => !v.taxable || v.marketValue !== undefined, {
    message: "marketValue is required for a taxable merger",
    path: ["marketValue"],
  });
export type MergerInput = z.infer<typeof mergerInputSchema>;

// --- Screenshot / CSV parse output ---------------------------------------

// Per-component tax breakdown emitted by PDF parsers.  Stored as jsonb on
// transaction_sources (open-ended set — brokers add components over time) and
// forwarded through the draft pipeline so the enrichment layer can persist them.
// All values are decimal strings (same convention as the parent parsedTransactionSchema).
export const taxComponentsSchema = z.object({
  kapitalertragsteuer: decimalString.nullish(),
  solidaritaetszuschlag: decimalString.nullish(),
  kirchensteuer: decimalString.nullish(),
  quellensteuer: decimalString.nullish(),
  stueckzinsen: decimalString.nullish(),
});
export type TaxComponents = z.infer<typeof taxComponentsSchema>;

// Actions a parser can emit. Securities trades + income (buy/sell/dividend/coupon),
// plus the cash/savings-plan flows the DKB Girokonto import produces (a savings-plan
// execution behaves as a buy; deposit/withdrawal are instrument-less cash movements).
// `bonus` = shares received with no cash (stock dividend / corporate bonus issue) —
// mirrored from the DB transaction type so share-based corp actions can be auto-mapped.
// `bonus_cash` = broker-credited cash bonus (e.g. TR Kindergeld/promo).
// `transfer_in`/`transfer_out` = depot-level position transfers (Depotübertrag), first-class
// from PR #309; both directions may appear in a broker export (e.g. IBKR Activity Flex).
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
  "bonus_cash",
  // Standalone tax debit (e.g. Vorabpauschale) — a cash outflow, not income. See txTypeEnum.
  "tax",
  "transfer_in",
  "transfer_out",
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
  wkn: z.string().nullish(),
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
  // Dividend/coupon per-share rate + shares paid on, in the instrument's native currency
  // (income rows only). Informational — `price`/`quantity` keep their existing net-cash /
  // zero-quantity semantics; see packages/db schema.ts for the full rationale.
  perShare: decimalString.nullish(),
  shares: decimalString.nullish(),
  // The instrument's native currency for a foreign-currency income payment, when it differs
  // from `currency` (which stays the cash actually credited, e.g. EUR).
  nativeCurrency: currencyCode.nullish(),
  // Gross payment amount in `nativeCurrency`, before FX conversion and withholding tax.
  grossNative: decimalString.nullish(),
  // Vorabpauschale taxable base (§18(3) InvStG advance lump-sum fund tax), gross — only set
  // on a `tax` action with `kind: "vorabpauschale"`. Unlike perShare/grossNative (pure
  // display enrichment) this feeds the core engine's FSA calculation directly.
  vorabBase: decimalString.nullish(),
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
  // Per-component tax breakdown (PDF parsers only). Stored on transaction_sources;
  // `tax` stays the gold-standard summed rollup on the transaction itself.
  taxComponents: taxComponentsSchema.nullish(),
  // TR AUFTRAG order reference, shared across split-order legs. Stored on
  // transaction_sources.orderRef for bookkeeping; each leg imports as a separate
  // transaction (one per settlement PDF — the intended behavior).
  orderRef: z.string().nullish(),
  // Additional source events folded into this one transaction (e.g. a TR perk cash credit
  // collapsed into the buy it funds — see collapsePerkFundedAcquisitions). Each is written
  // as its own transaction_sources row (same sourceType, distinct externalId) so the audit
  // trail and re-import / resolved-events-ledger dedup stay intact. The primary source keeps
  // `externalId` above; these are the consumed siblings.
  extraSources: z
    .array(
      z.object({
        externalId: z.string(),
        raw: z.unknown().nullish(),
      }),
    )
    .nullish(),
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
  // Machine-readable cause so surfaces can filter without parsing `message`. The safety net
  // (dashboard/admin alert) keys off `unmapped_event_type` / `unparseable_event` to flag TR
  // event types that reach the importer but have no mapping yet — a self-announcing gap.
  code: z.enum(["unmapped_event_type", "unparseable_event"]).optional(),
  line: z.number().optional(),
  eventId: z.string().optional(),
  eventType: z.string().optional(),
  raw: z
    .object({
      isin: z.string().nullish(),
      wkn: z.string().nullish(),
      name: z.string().nullish(),
      currency: z.string().nullish(),
      executedAt: z.string().nullish(),
      amount: z.number().nullish(),
      shares: z.number().nullish(),
    })
    .nullish(),
});
export type ImportIssue = z.infer<typeof importIssueSchema>;

// --- Allocation targets --------------------------------------------------

/**
 * Valid dimension values for allocation target sets.
 * 'instrument' is used for Sparplan per-instrument splits (Phase B).
 */
export const allocationDimensionSchema = z.enum([
  "asset_class",
  "currency",
  "region",
  "sector",
  "instrument",
]);
export type AllocationDimension = z.infer<typeof allocationDimensionSchema>;

/**
 * A single target weight entry.
 * `targetPct` must be 0–100 (validated at the set level to sum ≈ 100).
 */
export const allocationTargetEntrySchema = z.object({
  key: z.string().min(1),
  targetPct: z.number().min(0).max(100),
});

/**
 * Body schema for `PUT /networth/targets` and `PUT /portfolios/:id/targets`.
 * Replaces the entire (scope, dimension) set atomically.
 * `Σ targetPct` must be within 0.5 pp of 100 (accounts for rounding).
 */
export const allocationTargetSetSchema = z
  .object({
    dimension: allocationDimensionSchema,
    portfolioId: z.guid().nullable().optional(),
    targets: z.array(allocationTargetEntrySchema).min(1),
  })
  .refine(
    (d) => {
      const sum = d.targets.reduce((acc, t) => acc + t.targetPct, 0);
      return Math.abs(sum - 100) <= 0.5;
    },
    { message: "Target percentages must sum to 100 (±0.5)" },
  );
export type AllocationTargetSet = z.infer<typeof allocationTargetSetSchema>;

// --- Loss carry-forward (Verlustverrechnungstopf) -------------------------

/** One pot's carried-forward loss for a given tax year. */
export const lossCarryforwardEntrySchema = z.object({
  pot: z.enum(["stock", "general"]),
  amount: decimalString,
});
export type LossCarryforwardEntry = z.infer<typeof lossCarryforwardEntrySchema>;

/**
 * Body schema for `PUT /account-holders/:holderId/loss-carryforward`. Replaces the
 * entire (holderId, taxYear) set atomically — at most one entry per pot.
 */
export const lossCarryforwardSetSchema = z
  .object({
    taxYear: z.number().int().min(2000).max(2100),
    entries: z.array(lossCarryforwardEntrySchema).max(2),
  })
  .refine((d) => new Set(d.entries.map((e) => e.pot)).size === d.entries.length, {
    message: "At most one entry per pot",
  });
export type LossCarryforwardSet = z.infer<typeof lossCarryforwardSetSchema>;

// --- Global search -------------------------------------------------------

/**
 * Query schema for the user-scoped `GET /search` endpoint.  The `q` field is the
 * free-text term matched against instrument symbol/name/ISIN/WKN and transaction
 * description/tags.  Optional facets narrow results server-side; they are also the
 * contract that the future Cmd-K palette will consume.
 *
 * `holderId` mirrors the `/networth?holderId=` scoping pattern — restricts the
 * transaction (and owned-instrument) search to portfolios linked to that account holder.
 * `types` pre-filters the transaction result set to a subset of transaction types.
 * `limit` caps each result bucket (instruments and transactions independently).
 */
export const searchQuerySchema = z.object({
  q: z.string().trim().min(1),
  // Querystring parsers may deliver a single `?types=buy` as a string rather than
  // a one-element array.  preprocess normalises both shapes so the route handler
  // receives a consistent array.
  types: z.preprocess(
    (v) => (v == null ? undefined : Array.isArray(v) ? v : [v]),
    z.array(transactionTypeSchema).optional(),
  ),
  holderId: z.guid().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});
export type SearchQuery = z.infer<typeof searchQuerySchema>;

// --- User preferences / dashboard KPI config ---------------------------------

export const dashboardPeriodSchema = z.enum(["ytd", "1y", "5y", "max"]);
export type DashboardPeriod = z.infer<typeof dashboardPeriodSchema>;

export const KPI_KEYS = [
  "netWorth",
  "xirr",
  "dayChange",
  "totalPnL",
  "income",
  "cash",
  "positions",
] as const;
export type KpiKey = (typeof KPI_KEYS)[number];

export const taxRegimeSchema = z.enum(["DE", "ID"]);
export type TaxRegime = z.infer<typeof taxRegimeSchema>;

export const userPreferencesSchema = z.object({
  dashboardPeriod: dashboardPeriodSchema.optional(),
  dashboardKpis: z.array(z.enum(KPI_KEYS)).max(8).optional(),
  // Reuses the existing `costBasisModeSchema` (already used for the per-query
  // costBasis param elsewhere) rather than redeclaring it.
  costBasisMode: costBasisModeSchema.optional(),
  taxRegime: taxRegimeSchema.optional(),
  benchmarkSymbol: z.string().nullable().optional(),
  riskFreeRate: z.number().min(0).max(1).nullable().optional(),
  retirementAge: z.number().int().min(50).max(80).nullable().optional(),
});

// --- Document inbox (account-level documents not tied to a single transaction) ------

// "receipt" is the default/legacy category for existing per-transaction/import documents
// (screenshots, DKB/CSV statements, TR settlement PDFs) — unchanged behavior. "tax_report"
// is the first account-level inbox category (TR's annual Steuerreport + user uploads);
// more (cost_report, quarterly_report, …) can be added here later without a migration,
// since documents.category is a plain text column.
export const documentCategorySchema = z.enum(["receipt", "tax_report"]);
export type DocumentCategory = z.infer<typeof documentCategorySchema>;

// Multipart form fields alongside the uploaded file for POST /documents. portfolioId is
// required — every inbox document must be associated with the portfolio/account it covers
// (pytr-fetched reports already always carry one; this brings uploads to the same bar).
export const documentUploadFieldsSchema = z.object({
  category: documentCategorySchema.default("tax_report"),
  taxYear: z.coerce.number().int().min(1990).max(2100).optional(),
  portfolioId: z.string().uuid(),
});
export type DocumentUploadFields = z.infer<typeof documentUploadFieldsSchema>;

// Query params for GET /documents.
export const documentListQuerySchema = z.object({
  category: documentCategorySchema.optional(),
  /** Scope the list to one portfolio/account (e.g. the app-wide switcher selection). */
  portfolioId: z.string().uuid().optional(),
  /** Page number for server-side pagination (1-indexed). Omit for bare-array backward compat. */
  page: z.string().optional(),
  /** Page size (default 25, max 100). Only used when page is provided. */
  pageSize: z.string().optional(),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;
export type UserPreferencesInput = z.infer<typeof userPreferencesSchema>;
