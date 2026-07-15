import type {
  PortfolioInput,
  TransactionInput,
  MergerInput,
  InstrumentInput,
  CorporateActionInput,
  ParsedTransaction,
  ParsedGoldContract,
  ImportIssue,
  TaxComponents,
  UserUpdate,
  ApiTokenCreate,
  ProviderSettingUpdate,
  ProviderCredentialInput,
  ImportStrategy,
  ImportSettingsUpdate,
  StorageSettingsUpdate,
  StorageSecretInput,
  DocumentCategory,
} from "@portfolio/schema";

export { LOW_CONFIDENCE_THRESHOLD } from "@portfolio/schema";
export type { ImportIssue, ParsedGoldContract, ProviderCredentialInput } from "@portfolio/schema";
export type { ImportStrategy, ImportSettingsUpdate } from "@portfolio/schema";
export type { StorageSettingsUpdate, StorageSecretInput } from "@portfolio/schema";
export type { DocumentCategory } from "@portfolio/schema";

export interface AdminImportSettingsResponse {
  strategy: ImportStrategy;
}

// --- Response shapes (mirror the API) ------------------------------------

export interface User {
  id: string;
  authSub: string;
  email: string;
  name: string | null;
  displayCurrency: string;
  /** Derived from the Authentik admin group each request; gates the admin UI. */
  isAdmin: boolean;
}

/** A provider's API consumption against its plan (GET /admin/providers). */
export interface AdminProviderUsage {
  /** `provider` = live from the provider's API; `local` = our own call counter. */
  source: "provider" | "local";
  /** The window the counts cover. */
  window: "minute" | "day" | "month";
  /** Calls/credits used in the window, or null when unknown. */
  used: number | null;
  /** The plan cap for the window, or null when the API doesn't report it. */
  limit: number | null;
  /** When the window resets, ISO timestamp, when known. */
  resetAt?: string;
}

/** A market-data provider's effective config (GET/PATCH /admin/providers). No secrets. */
export interface AdminProvider {
  id: string;
  label: string;
  /** Whether this provider can be used (env key present or DB credential set). */
  configured: boolean;
  enabled: boolean;
  /** Fallback order; lower is tried first. */
  priority: number;
  /** API usage/quota, when available for this provider. */
  usage?: AdminProviderUsage | null;
  /** Whether an encrypted API key is stored in the DB (overrides the env key). */
  hasKey: boolean;
  /** Masked display of the DB key, e.g. "••••abc1", or null when no DB key is set. */
  keyHint: string | null;
  /** Whether a URL override is stored in the DB (for scraper-fed providers). */
  hasUrl: boolean;
  /**
   * Origin of the key/URL: "db" if an encrypted credential is stored in DB,
   * "env" if only an env var is set (no DB key), null if keyless (always-available providers).
   * Never exposes the key value — presence only.
   */
  keySource: "db" | "env" | null;
}

/** Wrapper returned by GET/PATCH /admin/providers and credential routes. */
export interface AdminProvidersResponse {
  providers: AdminProvider[];
  /** Whether server-side encryption is configured; gates the key-management UI. */
  encryptionEnabled: boolean;
}

/** One entry from GET /admin/audit. */
export interface AdminAuditEntry {
  id: string;
  actorSub: string;
  action: string;
  target: string;
  meta: unknown | null;
  at: string; // ISO timestamp
}

/** A vision LLM provider's effective config (GET/PATCH /admin/vision-providers). No secrets. */
export interface AdminVisionProvider {
  id: string;         // "claude" | "gemini" | "openrouter" | "ollama"
  label: string;
  /** Whether this provider can be used (env key/url present or DB credential set). */
  configured: boolean;
  enabled: boolean;
  /** Fallback order; lower is tried first. */
  priority: number;
  /** Whether an encrypted API key (or URL) is stored in the DB. */
  hasKey: boolean;
  /** Masked display of the DB key, e.g. "••••abc1", or null when no DB key is set. */
  keyHint: string | null;
  /** Whether a URL override is stored in the DB (for Ollama/LM Studio endpoint). */
  hasUrl: boolean;
  /**
   * Origin of the key/URL: "db" if an encrypted credential is stored in DB,
   * "env" if only an env var is set (no DB key), null if keyless.
   * Never exposes the key value — presence only.
   */
  keySource: "db" | "env" | null;
}

/** Wrapper returned by GET/PATCH /admin/vision-providers and credential routes. */
export interface AdminVisionProvidersResponse {
  providers: AdminVisionProvider[];
  /** Whether server-side encryption is configured; gates the key-management UI. */
  encryptionEnabled: boolean;
}

/** Row in the DB statistics table breakdown. */
export interface AdminStatsTable {
  name: string;
  /** Estimated live row count (pg_stat_user_tables.n_live_tup). Exact after ANALYZE. */
  rows: number | null;
  /** Table + index + toast size in bytes (pg_total_relation_size). */
  sizeBytes: number | null;
}

/** One background job as returned by GET /admin/jobs. */
export interface AdminJob {
  name: string;
  label: string;
  description: string;
  /** cron expression, or null for on-demand queues. */
  cron: string | null;
  /** ISO timestamp of the most recent completed or failed run, null = never run. */
  lastRunAt: string | null;
  /** Status of the last run, null = never run. */
  lastStatus: "completed" | "failed" | null;
  /** Whether this job supports a force flag that bypasses caches/stale checks. */
  supportsForce?: boolean;
}

/** Response from GET /admin/jobs. */
export interface AdminJobsResponse {
  /** false when pg-boss is not running (PGlite / test env). */
  schedulerAvailable: boolean;
  jobs: AdminJob[];
}

/** Server stats surfaced by GET /admin/stats (see #140). */
export interface AdminStats {
  db: {
    /** Total Postgres database size in bytes. Null when unavailable (PGlite / test). */
    sizeBytes: number | null;
    /** Per-table breakdown (key user-data tables only). Empty under PGlite. */
    tables: AdminStatsTable[];
  };
  objectStorage:
    | { configured: false }
    | {
        configured: true;
        provider?: string;
        objectCount?: number;
        totalBytes?: number;
        /** Free bytes on the underlying filesystem (folder provider only). */
        freeBytes?: number;
        /** Total filesystem capacity (folder provider only). */
        diskTotalBytes?: number;
        /** Error message when the stats fetch failed. */
        error?: string;
      };
}

/** One user as returned by GET /admin/users. */
export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  createdAt: string;
  portfolioCount: number;
  transactionCount: number;
  documentCount: number;
  storageBytes: number;
  tokenCount: number;
}

/** Storage provider admin config (GET /admin/storage-providers). */
export interface AdminStorageS3Config {
  endpoint: string;
  endpointSource: "db" | "env";
  region: string;
  regionSource: "db" | "env";
  bucket: string;
  bucketSource: "db" | "env";
  accessKeyId: string;
  accessKeyIdSource: "db" | "env";
  forcePathStyle: boolean;
  forcePathStyleSource: "db" | "env";
  signedUrlTtl: number;
  signedUrlTtlSource: "db" | "env";
  hasSecret: boolean;
  secretHint: string;
  secretSource: "db" | "env";
}

export interface AdminStorageResponse {
  activeProvider: "s3" | "folder";
  s3: AdminStorageS3Config;
  folder: {
    path: string;
    pathSource: "db" | "env";
  };
  encryptionEnabled: boolean;
}

export interface AdminStorageTestResult {
  ok: boolean;
  error?: string;
}

/** "self" | "child" | "other". A portfolio whose holder is "child" is a Kinderdepot. */
export type AccountHolderType = "self" | "child" | "other";

/** A person an investment account belongs to. Linked from any number of portfolios so
 * birth year + child-ness are entered once and shared (see issue #207). */
export interface AccountHolder {
  id: string;
  userId: string;
  name: string;
  type: AccountHolderType;
  /** Birth year — powers the "to age 18" forecast for a child. Null if unknown. */
  birthYear: number | null;
  // German tax profile (all optional).
  /** Annual Sparerpauschbetrag (e.g. "1000" for €1,000). Null = not configured. */
  taxAllowanceAnnual: string | null;
  /** Kapitalertragsteuer rate (e.g. "0.25" for 25%). Null = not configured (defaults to 0.25). */
  capitalGainsTaxRate: string | null;
  /** Church-tax surcharge flag. */
  churchTax: boolean | null;
  /** ISO-3166-1 alpha-2 tax residence (e.g. "DE"). Null = not configured. */
  taxResidence: string | null;
  createdAt: string;
}

export interface AccountHolderInput {
  name: string;
  type: AccountHolderType;
  birthYear?: number | null;
  taxAllowanceAnnual?: string | null;
  capitalGainsTaxRate?: string | null;
  churchTax?: boolean | null;
  taxResidence?: string | null;
}

// --- Tax optimization types -----------------------------------------------

/** One Verlusttopf's (loss pot's) netting result — see `AllowanceUsage.stockPot`/`generalPot`. */
export interface PotUsage {
  /** Tf-adjusted net gain/loss for this pot this year (decimal string, CAN be negative). */
  netGainLoss: string;
  /** Prior-year loss carry-forward subtracted from netGainLoss (decimal string, never negative). */
  carryForwardApplied: string;
  /** max(0, netGainLoss − carryForwardApplied) — this pot's own contribution to usedYtd. */
  used: string;
}

/** YTD usage of the annual Sparerpauschbetrag (§20 EStG). */
export interface AllowanceUsage {
  year: number;
  /** Annual allowance configured for this holder (decimal string). */
  allowanceAnnual: string;
  /**
   * Tf-adjusted realized gains/losses this year, summed across both pots (decimal string).
   * Symmetric — CAN be negative (a net loss year).
   */
  realizedGainsAdjusted: string;
  /** Dividend/interest/coupon income this year (decimal string, never negative). */
  incomeYtd: string;
  /** Tf-adjusted Vorabpauschale accrued this year (§18(3) InvStG), decimal string, never negative. */
  vorabpauschaleAccrued: string;
  /** Tf-adjusted Vorabpauschale disposal credit realized this year, decimal string, never negative. */
  vorabpauschaleCredited: string;
  /** Aktienverlusttopf — realized stock (assetClass="equity") gains/losses only. */
  stockPot: PotUsage;
  /** Allgemeiner Verlusttopf — fund/bond/derivative gains/losses, dividend/interest/coupon
   *  income, and the Vorabpauschale net. Gold/crypto are excluded from both pots. */
  generalPot: PotUsage;
  /** Total used = stockPot.used + generalPot.used, clamped to [0, allowanceAnnual]. */
  usedYtd: string;
  /**
   * max(0, (stockPot.used + generalPot.used) − allowanceAnnual) — the portion of this
   * year's gains/income that's actually taxable. Use this instead of re-deriving from
   * realizedGainsAdjusted/incomeYtd/usedYtd (no longer simply additive post-two-pot).
   */
  taxableExcess: string;
  /** Remaining allowance (never negative), decimal string. */
  remaining: string;
  /** Effective KapSt rate (decimal string, e.g. "0.25"). */
  taxRate: string;
  /** Estimated tax saved if you use the remaining allowance, decimal string. */
  taxSavingAvailable: string;
  /** Currency of all monetary amounts. */
  currency: string;
  /** Gross projected income for the rest of the year (dividends + coupons), decimal string. "0.00" when not available. */
  forecastIncomeRestOfYear: string;
  /** Projected full-year used = clamp(realized + incomeYtd + forecastIncomeRestOfYear, 0, allowance), decimal string. */
  projectedUsedFullYear: string;
  /** Projected remaining = allowanceAnnual − projectedUsedFullYear (never negative), decimal string. */
  projectedRemaining: string;
  /** Estimated tax saved against the projected remaining = projectedRemaining × taxRate, decimal string. */
  projectedTaxSavingAvailable: string;
}

/** A single harvest suggestion: an open position that could be (partially) realized tax-free. */
export interface HarvestSuggestion {
  instrumentId: string;
  /** Gross unrealized gain of the full open position (decimal string). */
  unrealizedGross: string;
  /** Teilfreistellung rate applied (decimal string, 0–1). */
  tfRate: string;
  /** Tf-adjusted unrealized gain = gross × (1 − tfRate), decimal string. */
  unrealizedAdjusted: string;
  /** How much gross gain you can realize tax-free given the remaining allowance. */
  harvestableGross: string;
  /** Estimated tax saved if you harvest exactly `harvestableGross`. */
  taxSaving: string;
  /** Instrument metadata (symbol, name, etc.) enriched by the API. */
  instrument: {
    symbol: string;
    name: string;
    assetClass: string;
    market: string;
  } | null;
}

/** Distribution context returned by tax endpoints — shows how the per-person cap
 *  is being used across a holder's depots. */
export interface TaxDistribution {
  /** The holder's per-person Sparerpauschbetrag cap (€1,000 single / €2,000 joint), decimal string. */
  holderAllowanceCap: string;
  /** Sum of all per-depot FSA allocations for this holder, decimal string. */
  totalAllocated: string;
  /** How much of the cap is still unallocated (holderAllowanceCap − totalAllocated, ≥0), decimal string. */
  remainingToDistribute: string;
  /** True when the depots' total allocation exceeds the cap; year-end Anlage KAP will reconcile. */
  overAllocated: boolean;
}

/** Response from GET /portfolios/:id/tax */
export interface PortfolioTaxSummary {
  year: number;
  currency: string;
  allowanceUsage: AllowanceUsage;
  harvestSuggestions: HarvestSuggestion[];
  /**
   * Whether this response applied the holder's seeded loss carry-forward. False for a
   * multi-depot holder — a per-person carry-forward can't be correctly attributed to just
   * one of several depots; see GET /networth/tax for the authoritative combined figure.
   */
  carryForwardApplied: boolean;
  /** Distribution context for the holder's full FSA allocation (used by the edit-portfolio modal). */
  holderDistribution: TaxDistribution;
  /** Teilfreistellung rate per instrumentId, the same map `allowanceUsage`/
   *  `harvestSuggestions` were computed with — lets the frontend Tf-adjust a per-disposal
   *  figure without re-deriving the asset-class-default rate (which could silently
   *  disagree whenever a manual per-instrument override is set on the backend). */
  tfRatesByInstrument: Record<string, string>;
}

/** One holder's entry in the GET /networth/tax response. */
export interface TaxSummaryHolder {
  holder: {
    id: string;
    name: string;
    /** Per-person Sparerpauschbetrag cap (€1,000 / €2,000 jointly assessed). */
    taxAllowanceAnnual: string | null;
    capitalGainsTaxRate: string | null;
    churchTax: boolean | null;
    taxResidence: string | null;
  };
  year: number;
  currency: string;
  allowanceUsage: AllowanceUsage;
  harvestSuggestions: HarvestSuggestion[];
  /** Always true here — this route aggregates every depot for the holder. */
  carryForwardApplied: boolean;
  /** Distribution summary across this holder's depots. */
  distribution: TaxDistribution;
  /** See {@link PortfolioTaxSummary.tfRatesByInstrument}'s doc comment. */
  tfRatesByInstrument: Record<string, string>;
}

export interface Portfolio {
  id: string;
  userId: string;
  name: string;
  baseCurrency: string;
  /** The person this portfolio belongs to, or null when unassigned. */
  accountHolderId: string | null;
  /** "standard" | "child". Derived: "child" iff the linked holder is type "child". */
  portfolioType: "standard" | "child";
  /** Beneficiary birth year, derived from the linked holder, or null. */
  birthYear: number | null;
  /** Brokerage/custodian the portfolio is held at (free text), or null. */
  brokerage: string | null;
  /** Name of the person the portfolio belongs to, derived from the linked holder, or null. */
  accountHolder: string | null;
  /** Brokerage/bank account number used for screenshot auto-detect, or null. */
  accountNumber: string | null;
  /** IBAN, matched alongside accountNumber for import auto-detect, or null. */
  iban: string | null;
  /** When false, this portfolio is excluded from the aggregate net-worth/performance view. */
  includeInAggregate: boolean;
  /** Whether cash is inside this portfolio's investment boundary. `true` = savings/
   * deposit account (contribution = net external cash, net worth includes cash);
   * `false` = mixed/invest-only (contribution = net invested capital, cash excluded). */
  cashCounted: boolean;
  /** When true, the negative-cash data-integrity guard is suppressed for this portfolio —
   *  for accounts where a buy routinely posts before its funding deposit clears. */
  allowNegativeCash: boolean;
  /** Opt-in per-portfolio source-document retention (issue #231). When false (default),
   * uploaded PDFs/screenshots are parsed in memory and never persisted (privacy-by-default).
   * When true, the source file is kept after import confirmation. */
  documentRetention: boolean;
  /** Per-depot Freistellungsauftrag (FSA) allocation in EUR (decimal string), or null when
   *  no FSA has been submitted for this depot. The holder's taxAllowanceAnnual cap must not
   *  be exceeded in aggregate across all the holder's portfolios. */
  taxAllowanceAnnual: string | null;
  /** Number of transactions in the portfolio. Populated only by the list endpoint
   *  (GET /portfolios) — used by the delete-confirm UI; omitted on create/edit responses. */
  transactionCount?: number;
}

/** Presentation metadata for an instrument; `null` on cash (instrument-less) rows. */
export interface InstrumentMeta {
  symbol: string;
  name: string;
  /** Clean human-readable name (e.g. "Apple Inc.") from provider enrichment; null until
   *  resolved. Presentation should prefer `displayName ?? name`. */
  displayName: string | null;
  assetClass: string;
  unit: string;
  /** Exchange/venue (IDX, XETRA, XAU, …). Used for region breakdown in allocation analytics. */
  market: string;
  /** GICS-style sector populated by the sector-enrichment job; null until enriched. */
  sector: string | null;
  /** Per-sector weights for ETFs (GICS-style sector name → fraction 0–1). Null for non-ETFs. */
  sectorWeights: Record<string, number> | null;
  /** Per-country weights for ETFs (country name → fraction 0–1). Null for non-ETFs. */
  countryWeights: Record<string, number> | null;
}

/** A single slice in an allocation breakdown (one category in one dimension). */
export interface AllocationSlice {
  /** Canonical category key (asset-class name, currency code, region code, sector name, …). */
  key: string;
  /** Value in the display currency (decimal string). */
  value: string;
  /** Percentage of total, 0–100, rounded to 4 dp. */
  pct: number;
}

/** An individual holding ranked by portfolio weight. */
export interface AllocationTopHolding {
  instrumentId: string;
  name?: string;
  assetClass?: string;
  /** Market value in the display currency (decimal string). */
  value: string;
  /** Percentage of total, 0–100. */
  pct: number;
}

/** HHI-based concentration summary. */
export interface ConcentrationInfo {
  /** Herfindahl-Hirschman Index, 0–10 000. */
  hhi: number;
  top1Pct: number;
  top5Pct: number;
  label: "diversified" | "moderate" | "concentrated";
}

/**
 * Full allocation breakdown across four dimensions + concentration analytics.
 * All monetary values are in the portfolio's display currency (decimal strings).
 */
export interface AllocationBreakdown {
  byAssetClass: AllocationSlice[];
  byCurrency: AllocationSlice[];
  byRegion: AllocationSlice[];
  bySector: AllocationSlice[];
  topHoldings: AllocationTopHolding[];
  concentration: ConcentrationInfo;
}

// --- Rebalancing / drift types -------------------------------------------

/** A user-defined target weight for one allocation dimension slice. */
export interface TargetWeight {
  key: string;
  targetPct: number;
}

/** Actual vs. target drift for one allocation slice. */
export interface DriftRow {
  key: string;
  label?: string;
  targetPct: number;
  actualPct: number;
  /** Signed drift in pp: `actualPct − targetPct`. Positive = over target. */
  driftPct: number;
  actualValue: string;
  status: "over" | "under" | "on_target";
}

/** A recommended trade action to move toward target allocation. */
export interface TradeAction {
  key: string;
  label?: string;
  /** Absolute value in the display currency (always positive). */
  deltaValue: string;
  side: "buy" | "sell";
}

export interface Instrument {
  id: string;
  isin: string | null;
  wkn: string | null;
  symbol: string;
  market: string;
  assetClass: string;
  unit: string;
  currency: string;
  name: string;
}

/** An instrument result from the global search — extends the catalog record with
 *  an `owned` flag indicating whether the authenticated user holds or has transacted
 *  this instrument (owned results sort first in the response). */
export interface SearchInstrumentResult extends Instrument {
  sector: string | null;
  owned: boolean;
}

/** A transaction result from the global search — a minimal display record
 *  matched by description or tags, enriched with instrument name/symbol. */
export interface SearchTransactionResult {
  id: string;
  portfolioId: string;
  portfolioName: string | null;
  type: string;
  currency: string;
  executedAt: string;
  description: string | null;
  tags: string[] | null;
  instrument: { symbol: string; name: string } | null;
}

/** Aggregated payload returned by `GET /search`. */
export interface GlobalSearchResult {
  instruments: SearchInstrumentResult[];
  transactions: SearchTransactionResult[];
}

/** A market-data discovery match used to prefill the manual-entry form. */
export interface InstrumentSearchResult {
  symbol: string;
  name: string;
  market: string;
  assetClass: string;
  currency: string;
  isin?: string;
  wkn?: string;
  source: string;
}

/** A selectable gold buyback source (Antam, Galeri24, …) mapped to its routing market. */
export interface GoldSource {
  market: string;
  label: string;
}

export interface CorporateAction {
  id: string;
  instrumentId: string;
  type: string;
  ratio: string;
  exDate: string;
  terms: string | null;
}

export interface Candle {
  date: string; // YYYY-MM-DD
  close: string;
  /** Native quote currency; absent for gold/crypto whose currency is encoded in the symbol pair. */
  currency?: string;
}

export interface QuoteRef {
  symbol: string;
  market: string;
  assetClass: string;
  currency: string;
}

export interface Quote extends QuoteRef {
  price: string;
  asOf: string;
}

/** A single source-provenance record for a transaction (#230).
 * One row per import/upload that contributed data; multiple rows appear for split orders. */
export interface SourceSummary {
  id: string;
  sourceType: string;
  externalId: string | null;
  orderRef: string | null;
  /** documentId links to the stored PDF that produced this source row (null when no PDF was retained). */
  documentId: string | null;
  /** Per-component tax breakdown from the settlement PDF (null for CSV/timeline sources). */
  taxComponents: TaxComponents | null;
  createdAt: string;
  /** Human-readable display name for the document this row resolves to (null when none is
   * retained) — synthesized to match the actual download filename, not the literal stored name. */
  filename: string | null;
  /** True when a document can be downloaded for this row (own documentId or import-linked doc). */
  hasDocument: boolean;
}

/** Visibility status of a transaction (see the API's transaction_status enum). */
export type TransactionStatus = "normal" | "archived" | "cash_neutral" | "draft";

export interface Transaction {
  id: string;
  portfolioId: string;
  instrumentId: string | null;
  type: string;
  quantity: string;
  price: string;
  fees: string;
  /** Informational only — broker price/cash already nets it; null = unknown. */
  tax: string | null;
  /** FX rate at execution for cross-currency holdings; null for same-currency. */
  fxRate: string | null;
  /** Dividend/coupon per-share rate, in the instrument's native currency (income rows only).
   *  Informational — `price`/`quantity` keep their existing net-cash/zero-quantity semantics. */
  perShare?: string | null;
  /** Shares the per-share rate above was paid on. NOT the same as `quantity` (always "0" for
   *  income transactions). */
  shares?: string | null;
  /** The instrument's native currency for a foreign-currency income payment, when it differs
   *  from `currency` (the cash actually credited, e.g. EUR). */
  nativeCurrency?: string | null;
  /** Gross payment amount in `nativeCurrency`, before FX conversion and withholding tax. */
  grossNative?: string | null;
  /** True when `shares`/`perShare` were derived read-time from holdings history (#508)
   *  rather than parsed from the source — the value is an approximation (own-currency
   *  gross/shares, not the native-currency rate a settlement PDF would print) and may
   *  disagree with a later-imported authoritative value for the same payment. */
  sharesEstimated?: boolean;
  /** Free-text memo (counterparty, merchant, transfer reference). */
  description: string | null;
  /** User-defined labels for filtering and reporting. */
  tags: string[] | null;
  currency: string;
  executedAt: string;
  source: string;
  /** Sub-type within an action (saveback/roundup/transfer_in/merger); null for most rows. */
  kind: string | null;
  /** Visibility status: "normal" (default), "archived" (ignored in all derivations),
   * or "cash_neutral" (keeps shares but contributes no cash). */
  status: TransactionStatus;
  importId: string | null;
  /** Import dedup key; null for manually-entered transactions. */
  externalId: string | null;
  instrument: InstrumentMeta | null;
  /** True when the parent import has a retained source document available for download (#231). */
  hasDocument: boolean;
  /** True when at least one source row has per-component taxComponents (i.e. a settlement PDF was parsed). */
  hasFullTaxDetail: boolean;
  /** True when a source row's parse confidence is low (a lossy LLM-vision parse) — the table
   *  flags such draft rows for review. Deterministic imports are never flagged. */
  needsReview?: boolean;
  /** All source-provenance rows for this transaction; empty when none have been written yet. */
  sources: SourceSummary[];
  /** Present only when the list was fetched with `?convertTo=` (#465): the rate to
   *  multiply an amount in `currency` by to get `displayCurrency`, at this row's own
   *  trade date. `"1"` for same-currency rows and unknown FX pairs (unconverted). */
  displayRate?: string;
  /** The scope currency `displayRate` converts into; present alongside `displayRate`. */
  displayCurrency?: string;
}

/** Result of a read-only merge simulation (`previewMergeTransactions`). `ok: false` means the
 *  guardrails blocked it (different instrument, incompatible type, loan-linked leg, or the
 *  transaction wasn't found) — `blockedReason` is a `cannot_merge_<reason>`-style key for i18n. */
export interface MergePreview {
  ok: boolean;
  blockedReason?:
    | "not_found"
    | "same_transaction"
    | "different_instrument"
    | "incompatible_type"
    | "loan_linked";
  merged?: {
    quantity: string;
    price: string;
    executedAt: string;
    type: string;
    currency: string;
    tax: string | null;
    fees: string | null;
    executedPrice: string | null;
    fxRate: string | null;
    venue: string | null;
    perShare: string | null;
    shares: string | null;
    nativeCurrency: string | null;
    grossNative: string | null;
    documentCount: number;
  };
}

export interface Holding {
  instrumentId: string;
  quantity: string;
  avgCost: string;
  costBasis: string;
  realizedPnL: string;
  /** Currency in which cost basis and realized P&L are denominated (the trade/buy currency).
   * Null when the instrument has had no price-bearing transactions. Usually the same as the
   * quote currency, but differs for cross-currency holdings (e.g. US stocks bought in EUR). */
  costCurrency: string | null;
}

export type AnomalyCode =
  | "oversell"
  | "sell_before_acquisition"
  | "negative_cash"
  | "income_on_non_held"
  | "missing_transfer_basis"
  | "zero_price"
  | "reconciliation_gap"
  | "reconciliation_drift"
  | "position_gap";

export interface Anomaly {
  code: AnomalyCode;
  severity: "error" | "warning";
  scope: "transaction" | "instrument" | "portfolio";
  transactionId?: string;
  instrumentId?: string;
  meta?: Record<string, unknown>;
}

export interface HoldingsResult {
  holdings: Holding[];
  anomalies: Anomaly[];
}

export interface AnomaliesResult {
  anomalies: Anomaly[];
}

/** A standing open FIFO lot (acquisition order), for a per-lot cost-basis display. */
export interface LotView {
  acqDate: string; // ISO date (YYYY-MM-DD)
  qty: string;
  unitCost: string;
  cost: string;
}

export interface HoldingValuation extends Holding {
  price: string | null;
  currency: string | null;
  marketValue: string | null;
  unrealizedPnL: string | null;
  /** Market value FX-converted to the display currency (null when unpriced). */
  marketValueDisplay: string | null;
  /** Cost basis FX-converted to the display currency. */
  costBasisDisplay: string;
  /** Unrealized P&L in the display currency (null when unpriced). */
  unrealizedPnLDisplay: string | null;
  previousClose: string | null;
  dayChange: string | null;
  dayChangePct: string | null;
  instrument: InstrumentMeta | null;
  /** Standing open FIFO lots (oldest first); undefined when the API didn't attach them. */
  lots?: LotView[];
  /**
   * Recent daily closes (oldest→newest, instrument currency) for the mobile holdings
   * sparkline. Populated by the route layer from the `prices` table, not by
   * `summarizePortfolio` — same attach-after-valuing pattern as `lots`. Undefined or a
   * <2-length array when there isn't enough stored history to draw a line.
   */
  sparkline?: number[];
}

export interface PortfolioSummary {
  displayCurrency: string;
  holdings: HoldingValuation[];
  cash: Record<string, string>;
  /** Whether `cash` is meaningful (inside the boundary + funding recorded). When false,
   * `cash` is empty and excluded from net worth — UI shows "not tracked" vs a real 0. */
  cashTracked: boolean;
  netWorth: string;
  totalCost: string;
  totalMarketValue: string;
  totalUnrealizedPnL: string;
  totalRealizedPnL: string;
  /** Outstanding loan liabilities in the display currency (already netted from netWorth). */
  totalLiabilities: string;
  totalIncome: string;
  totalDayChange: string;
  /** Wealth denominated in each currency (display-currency magnitudes). */
  exposureByCurrency: Record<string, string>;
  /** Allocation breakdown across asset class, currency, region, sector + concentration. */
  allocation?: AllocationBreakdown;
  /**
   * Per-dimension drift vs. user targets.
   * Keys are dimension names ('asset_class', 'currency', 'region', 'sector');
   * only dimensions where the user has saved targets are included.
   * Absent when the user has no targets for this scope.
   */
  drift?: Record<string, DriftRow[]>;
}

export interface PortfolioPerformance {
  /** Money-weighted annualised return (XIRR), or null when undefined. */
  xirr: number | null;
  netWorth: string;
  asOf: string;
}

/** Net worth aggregated across all of a user's portfolios. */
export interface NetWorth {
  displayCurrency: string;
  holdings: HoldingValuation[];
  cash: Record<string, string>;
  /** Whether `cash` is meaningful (at least one portfolio tracks cash). When false,
   * `cash` is empty and excluded from net worth — UI shows "not tracked" vs a real 0. */
  cashTracked: boolean;
  netWorth: string;
  totalCost: string;
  totalMarketValue: string;
  totalUnrealizedPnL: string;
  totalRealizedPnL: string;
  /** Outstanding loan liabilities in the display currency (already netted from netWorth). */
  totalLiabilities: string;
  totalIncome: string;
  totalDayChange: string;
  /** Wealth denominated in each currency (display-currency magnitudes). */
  exposureByCurrency: Record<string, string>;
  /** Allocation breakdown across asset class, currency, region, sector + concentration. */
  allocation?: AllocationBreakdown;
  /**
   * Per-dimension drift vs. user targets. Same structure as `PortfolioSummary.drift`.
   * Keys are dimension names; only dimensions with saved targets are present.
   */
  drift?: Record<string, DriftRow[]>;
  xirr: number | null;
  /** Period-scoped XIRR (ytd / 1y / 5y). Null when period is "max" or no snapshot data. */
  periodXirr?: number | null;
  /** Period P&L in display currency (string decimal). Null for "max" or no snapshot data. */
  periodPnL?: string | null;
  /** Period P&L as a fraction (e.g. 0.12 = 12%). Null for "max" or no snapshot data. */
  periodPnLPct?: string | null;
  /** The active period: "ytd" | "1y" | "5y" | "max". */
  period?: string;
  portfolioCount: number;
  asOf: string;
}

/** User dashboard preferences (period selector, KPI layout). */
export interface UserPreferences {
  dashboardPeriod: "ytd" | "1y" | "5y" | "max";
  dashboardKpis: string[] | null;
  /** Global cost-basis method — replaces the old per-page `?costBasis=` toggle. */
  costBasisMode: "purchase_price" | "total_paid";
  /** Global tax regime — drives the Tax screen (DE/ID) and the sparplan harvest gate. */
  taxRegime: "DE" | "ID";
}

/** A personal access token's metadata (never the secret). */
export interface ApiToken {
  id: string;
  name: string;
  tokenPrefix: string;
  scope: "read" | "write";
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

/** The create response — the only place the plaintext `token` is ever returned. */
export interface ApiTokenWithSecret extends ApiToken {
  token: string;
}

/** A point on a net-worth-over-time series (display/base currency). */
export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  netWorth: string;
}

/**
 * A point on a TWR performance series. Superset of NetWorthPoint — existing callers
 * that only read `netWorth` continue to work.
 */
export interface PerformancePoint {
  date: string; // YYYY-MM-DD
  /** Net worth in display currency (incl. cash + liabilities). */
  netWorth: string;
  /** Holdings market value only (excl. cash), in display/base currency. Optional for back-compat. */
  marketValue?: string;
  /** TWR index level (base 100). Optional for back-compat. */
  index?: string;
  /** Percentage return since inception: (index/100 − 1) × 100. Optional for back-compat. */
  pct?: string;
}

/**
 * A timestamped intraday point (range=1d/7d), from the timestamped intraday-snapshot
 * table rather than the day-grained one. Uses a distinct `at` (ISO datetime) key
 * instead of `date` so callers can tell the two shapes apart. No TWR index/pct —
 * that needs day-level flow data the intraday table doesn't carry.
 */
export interface IntradayPoint {
  at: string; // ISO datetime
  netWorth: string;
  marketValue: string;
}

/** A point on either the daily (`date`) or intraday (`at`) history series. */
export type HistoryPoint = PerformancePoint | IntradayPoint;

/** True when a HistoryPoint came from the 1d/7d intraday branch. */
export function isIntradayPoint(p: HistoryPoint): p is IntradayPoint {
  return "at" in p;
}

/** A projected future coupon payment for a held bond (instrument currency). */
export interface ProjectedCoupon {
  instrumentId: string;
  symbol: string;
  name: string | null;
  date: string; // YYYY-MM-DD
  amount: string;
  currency: string;
}

/**
 * A single entry in the upcoming-payments table, covering bond coupons and equity
 * dividends at every stage of the lifecycle:
 * - "scheduled"      — coupon from a bond's fixed schedule
 * - "projected"      — dividend projected from last year's actual (seasonal heuristic)
 * - "grown"          — projected with a YoY per-share growth multiplier applied
 * - "announced"      — ex-date announced by the issuer; amount may still change
 * - "paid"           — cash has settled; amount is final
 */
export interface UpcomingPayment {
  instrumentId: string;
  symbol: string;
  name: string | null;
  /** Clean display name resolved by the metadata enrichment job, when available.
   *  UI should prefer `displayName ?? name` so a raw broker-style name doesn't leak. */
  displayName: string | null;
  date: string; // YYYY-MM-DD — ex-date for dividends, coupon date for bonds
  amount: string;
  currency: string;
  kind: "coupon" | "dividend";
  status: "scheduled" | "projected" | "grown" | "announced" | "paid";
  /** The YoY per-share growth multiplier applied when `status === "grown"`. */
  growthApplied?: number;
  /** True when the projected amount assumes continued savings-plan share accumulation. */
  assumesContributions?: boolean;
  /**
   * Per-share dividend amount in `currency` (split-adjusted). Absent for coupons and
   * unlinked rows. Multiply by `quantity` to reproduce `amount`.
   */
  perShare?: string;
  /** Share count used for this payment (split-adjusted, same basis as `perShare`). */
  quantity?: string;
}

/** Trailing-12-month income + yield for an income-paying holding (display currency). */
export interface InstrumentYield {
  instrumentId: string;
  symbol: string;
  name: string | null;
  /** Clean display name resolved by the metadata enrichment job, when available. */
  displayName: string | null;
  /** Asset class for icon/tint (e.g. equity, etf, bond). Mirrors the
   *  `instrument.assetClass` shape used by holdings/trades tables. */
  assetClass: string | null;
  trailingIncome: string;
  marketValue: string;
  costBasis: string;
  /** Trailing income ÷ market value (current yield), or null when value is zero. */
  yield: string | null;
  /** Trailing income ÷ cost basis (yield on cost), or null when cost is zero. */
  yieldOnCost: string | null;
  currency: string;
}

/** A single dividend/coupon cash event (native currency), for the event log. */
export interface IncomeEvent {
  /** The underlying transaction id, when known — lets the UI open its detail sheet. */
  transactionId?: string | null;
  /** The portfolio the underlying transaction belongs to. */
  portfolioId?: string | null;
  instrumentId: string | null;
  symbol: string | null;
  name: string | null;
  /** Clean display name resolved by the metadata enrichment job, when available. */
  displayName: string | null;
  type: string; // "dividend" | "coupon"
  date: string; // YYYY-MM-DD
  amount: string;
  currency: string;
  /**
   * Per-share dividend amount in `currency` (split-adjusted). Absent for coupons and
   * unlinked rows. Multiply by `quantity` to reproduce `amount`.
   */
  perShare?: string;
  /** Share count at the time of payment (split-adjusted, same basis as `perShare`). */
  quantity?: string;
}

export interface YearIncome {
  year: string;
  total: string;
  paymentCount: number;
}
export interface MonthIncome {
  month: string; // YYYY-MM
  total: string;
}
export interface InstrumentIncome {
  instrumentId: string | null;
  symbol: string | null;
  name: string | null;
  /** Clean display name resolved by the metadata enrichment job, when available. */
  displayName: string | null;
  total: string;
  pct: number;
}
export interface AssetClassIncome {
  assetClass: string;
  total: string;
  pct: number;
}
export interface CurrencyIncome {
  currency: string;
  totalNative: string;
  totalNormalized: string;
}

/**
 * Cash-interest subtotal — a standalone figure, NOT part of the dividend/coupon
 * headline totals on IncomeStats. All amounts are in `currency` (the display currency).
 */
export interface IncomeInterest {
  ytd: string;
  ttm: string;
  lifetime: string;
  currency: string;
}

/**
 * Dividend/coupon analytics + forward outlook for the active scope. All monetary
 * fields are in `displayCurrency` unless noted; `byCurrency` keeps the native sums.
 */
export interface IncomeStats {
  displayCurrency: string;
  byYear: YearIncome[];
  monthly: MonthIncome[];
  ttm: string;
  thisYear: string;
  lastYear: string;
  deltaAbs: string;
  deltaPct: number | null;
  forecastNextYear: string;
  /** Projected income from now to Dec 31 of the current year. */
  forecastRestOfYear: string;
  /** thisYear actuals + forecastRestOfYear (complete current-year outlook). */
  forecastFullYear: string;
  lifetimeTotal: string;
  byInstrument: InstrumentIncome[];
  byAssetClass: AssetClassIncome[];
  byCurrency: CurrencyIncome[];
  paymentCount: number;
  averagePerPayment: string;
  yields: InstrumentYield[];
  /** Upcoming bond coupons (next 12 months) and projected dividends (now → Dec 31). */
  upcoming: UpcomingPayment[];
  events: IncomeEvent[];
  /** Cash interest — a standalone subtotal, NOT part of the dividend/coupon headline
   *  totals above. Amounts in `displayCurrency`. */
  interest: IncomeInterest;
}

/** Contribution analytics + forecast seed for a savings/Sparplan account. */
export interface ContributionStats {
  displayCurrency: string;
  totalContributed: string;
  totalWithdrawn: string;
  netContributed: string;
  /** Elapsed calendar months from first contribution month through the current month
   * (inclusive). Denominator for monthlyAverage — idle months dilute the average. */
  monthsElapsed: number;
  /** Distinct months with non-zero net activity. Kept for backward compat. */
  monthsActive: number;
  /** Net contribution divided by monthsElapsed (all months since start). */
  monthlyAverage: string;
  /** Net contribution per calendar month, ascending by `month` (YYYY-MM). */
  series: { month: string; contributed: string }[];
  /** Net contribution per calendar DAY, ascending by `date` (YYYY-MM-DD). Day-resolution
   * companion to `series`, used by the overlay chart so the contributed step lands on the
   * actual transaction day. */
  dailySeries: { date: string; contributed: string }[];
  currentValue: string;
  /** (currentValue − netContributed) / netContributed, or null when no basis. */
  simpleGainPct: number | null;
  /**
   * Cumulative total return — adds received security income (dividends/coupons) and
   * realized gains to the unrealized headline, over gross contributed capital:
   * (currentValue + Σ positive boundary flows − totalContributed) / totalContributed.
   * `null` for a single cash-inside portfolio (its `simpleGainPct` is already total return).
   */
  totalReturnPct: number | null;
  xirr: number | null;
  /** Default annual return to seed the forecast (xirr clamped, else "0.07"). */
  seedAnnualReturn: string;
  /** Beneficiary birth year for the "to age 18" target (single portfolio only). */
  birthYear: number | null;
  /** "standard" | "child"; gates the "to age 18" forecast target. */
  portfolioType: "standard" | "child";
  asOf: string;
}

/** One recurring-amount tier within a detected Sparplan's history (native currency). */
export interface AmountLevel {
  /** Median per-execution amount in the plan's native currency. */
  amount: string;
  /** `amount` converted to the display currency. */
  amountDisplay: string;
  currency: string;
  /** YYYY-MM-DD: first execution at this level. */
  since: string;
  /** YYYY-MM-DD: last execution at this level; null = current (latest) level. */
  until: string | null;
  executionCount: number;
}

/** A detected recurring savings plan for one instrument. */
export interface DetectedPlan {
  instrumentId: string;
  /** Instrument symbol (null when metadata unavailable). */
  symbol: string | null;
  /** Instrument display name (null when metadata unavailable). */
  name: string | null;
  /** Native execution currency. */
  currency: string;
  /** Most likely cadence: 1 (monthly), 3 (quarterly), 6 (semi-annual), 12 (annual). */
  cadenceMonths: number;
  /** Latest level's representative amount in native currency. */
  currentAmount: string;
  /** `currentAmount` converted to the display currency. */
  currentAmountDisplay: string;
  status: "active" | "stopped";
  /** YYYY-MM-DD: first ever execution. */
  firstExecution: string;
  /** YYYY-MM-DD: most recent execution. */
  lastExecution: string;
  executionCount: number;
  /** "tagged" = explicit savings_plan type or savingsPlanId; "heuristic" = inferred. */
  source: "tagged" | "heuristic";
  /** Chronological amount levels. length > 1 means step-increases were detected. */
  levels: AmountLevel[];
}

/** Recommended contribution amount for one savings-plan sleeve. */
export interface SparplanContributionSplit {
  /** instrumentId of the savings-plan sleeve. */
  key: string;
  /** Recommended contribution in the display currency (decimal string). */
  amount: string;
  /** Share of the monthly total, 0–100. */
  sharePct: number;
}

export interface SparplanStats {
  displayCurrency: string;
  plans: DetectedPlan[];
  /**
   * Sum of active plans' monthly-equivalent amounts in the display currency.
   * Quarterly/semi-annual plans are normalised to monthly (÷ cadenceMonths).
   */
  activeMonthlyTotalDisplay: string;
  activePlanCount: number;
  /**
   * Per-instrument drift rows when instrument targets are set for this portfolio.
   * Only present on the portfolio-scoped endpoint (GET /portfolios/:id/sparplan).
   */
  drift?: DriftRow[];
  /**
   * Recommended split of the monthly total across savings-plan sleeves to converge
   * toward the target weights. Only present when `drift` is present.
   */
  contributionSplit?: SparplanContributionSplit[];
  /**
   * Phase D: sell + buy trade recommendations with sells capped by the remaining
   * Sparerpauschbetrag allowance. Only present when `?includeSales=true` is passed
   * and the portfolio's holder has a tax profile configured.
   */
  tradeActions?: TradeAction[];
  /**
   * Tf-adjusted gain that would be realised by the recommended sell actions
   * (display currency, decimal string). Only present when `tradeActions` is present.
   */
  allowanceUsed?: string;
  /**
   * Remaining Sparerpauschbetrag after YTD income and realised gains
   * (display currency, decimal string). Only present when `tradeActions` is present.
   */
  remainingAllowance?: string;
  /**
   * True when `?includeSales=true` was requested but the portfolio's holder has no
   * `taxAllowanceAnnual` configured — the toggle should be disabled in the UI.
   * Never set under the Indonesian regime (no allowance concept to require).
   */
  taxUnavailable?: boolean;
  /**
   * The user's global tax regime, echoed back so the frontend can gate German-only
   * labels (allowance/harvest) without a separate preferences fetch. Only present
   * when `tradeActions` is present (i.e. `?includeSales=true`).
   */
  taxRegime?: "DE" | "ID";
}

export type TradeMethod = "average" | "fifo";

/** A matched disposal slice — FIFO: one consumed lot; average: the whole sell. */
export interface TradeLeg {
  acqDate: string; // YYYY-MM-DD
  sellDate: string; // YYYY-MM-DD
  quantity: string;
  cost: string; // display currency
  proceeds: string; // display currency
  gain: string; // display currency
  holdingDays: number;
  longTerm: boolean;
  taxYear: number;
}

/** A round-trip "trade" (position episode), money fields in display currency. */
export interface Trade {
  instrumentId: string;
  /** Instrument currency — the unit for avgEntryPrice / avgExitPrice. */
  currency: string;
  status: "open" | "closed";
  entryDate: string; // YYYY-MM-DD
  exitDate: string | null;
  holdingDays: number;
  /** Capital-weighted average holding period in days; equals holdingDays for a
   * lump-sum position, shorter for savings plans (gradual capital deployment). */
  avgHoldingDays: number;
  longTerm: boolean;
  quantity: string;
  avgEntryPrice: string; // instrument currency
  avgExitPrice: string | null; // instrument currency
  invested: string;
  realizedPnL: string;
  unrealizedPnL: string;
  dividends: string;
  totalReturn: string;
  totalReturnPct: number | null;
  annualizedPct: number | null;
  legs: TradeLeg[];
  instrument: InstrumentMeta | null;
}

export interface YearAmount {
  year: number;
  amount: string;
}
export interface YearTax {
  year: number;
  amount: string;
  tax: string;
}

/** The trade log for a scope: round-trip trades + tax-by-year breakdowns. */
export interface TradeLog {
  displayCurrency: string;
  method: TradeMethod;
  trades: Trade[];
  totalRealized: string;
  totalDividends: string;
  totalReturn: string;
  /** Fraction of closed trades with a positive total return; null if none closed. */
  winRate: number | null;
  realizedByYear: YearAmount[];
  dividendsByYear: YearTax[];
  /** Broker-credited bonuses by year (bonus_cash, saveback, free transfer_in).
   * Purely informational — NOT included in totalReturn or totalDividends. */
  bonusesByYear: YearAmount[];
}

/** A draft transaction matched a transaction already committed to the candidate portfolio
 * — likely a cross-format re-import (#196). The review screen pre-deselects these. */
export interface LikelyDuplicate {
  /**
   * "enrichment": different source and the import carries a document or taxComponents.
   *   → blue info badge; auto-applied at confirm time (no blocking 409).
   * "duplicate": same source or no new value.
   *   → amber warning badge; excluded from default "Confirm all", blocks with 409.
   */
  kind: "enrichment" | "duplicate";
  /** Source of the already-committed transaction (e.g. "csv", "screenshot"). */
  source: string | null;
  /** When the already-committed transaction executed (ISO date). */
  executedAt: string;
  /** Id of the matched committed transaction (for the Enrich existing action). */
  matchedTransactionId?: string;
}

/** A draft enriched with a cross-source duplicate hint (otherwise a plain ParsedTransaction). */
export type DraftTransaction = ParsedTransaction & { likelyDuplicate?: LikelyDuplicate };

/** Per-draft annotation returned by the preview duplicate-check endpoint (#259). */
export interface DuplicateAnnotation {
  /** Index into the import's stored draft list (parsedJson.drafts). */
  draftIndex: number;
  kind: "enrichment" | "duplicate";
  matchedTransactionId: string;
  matchedSource: string | null;
  matchedExecutedAt: string;
  name: string | null;
  action: string;
  quantity: string;
  executedAt: string;
}

/** Verdict that a file's account number conflicts with the chosen portfolio (#197). */
export interface AccountMismatch {
  /** `other_portfolio`: the file matches a *different* portfolio (named below).
   *  `no_match`: no portfolio matches, but the selected one has a differing account number. */
  kind: "other_portfolio" | "no_match";
  /** The likely-owner portfolio (only for `other_portfolio`). */
  matchedPortfolioId?: string;
  matchedName?: string;
  /** The account number detected on the file. */
  detected: string;
}

export interface CsvImportResult {
  importId: string;
  drafts: DraftTransaction[];
  contracts: ParsedGoldContract[];
  errors: ImportIssue[];
  /** True when the exact file was already uploaded and the existing draft was returned. */
  alreadyExists?: boolean;
  /** True when the exact file was already uploaded and fully confirmed. */
  alreadyConfirmed?: boolean;
  /** Portfolio whose accountNumber matched the file's detected account, if any. */
  matchedPortfolioId?: string | null;
  /** Portfolio to pre-select in the upload "confirm portfolio" step: the account match,
   *  else the user's sole portfolio. Null when neither applies (user must pick). */
  suggestedPortfolioId?: string | null;
  /** Set when the file's account looks like it belongs to a different portfolio. */
  accountMismatch?: AccountMismatch | null;
  /** A deterministic import whose account matched a portfolio was written straight
   *  into the transactions table as draft rows (no review step). `drafts` is then absent. */
  materialized?: boolean;
  /** Target portfolio for a materialized import. */
  portfolioId?: string;
  /** Number of draft transactions materialized. */
  materializedCount?: number;
}

export interface ScreenshotImportResult {
  importId: string;
  drafts: DraftTransaction[];
  /** Financed gold-purchase contracts (Pegadaian/Galeri 24 cicilan). */
  contracts: ParsedGoldContract[];
  errors: ImportIssue[];
  /** True when the exact image was already uploaded and the existing draft was returned. */
  alreadyExists?: boolean;
  /** True when the exact image was already uploaded and fully confirmed. */
  alreadyConfirmed?: boolean;
  /** Portfolio whose accountNumber matched the document's detected account, if any. */
  matchedPortfolioId?: string | null;
  /** Portfolio to pre-select in the upload "confirm portfolio" step: the account match,
   *  else the user's sole portfolio. Null when neither applies (user must pick). */
  suggestedPortfolioId?: string | null;
  /** Set when the file's account looks like it belongs to a different portfolio. */
  accountMismatch?: AccountMismatch | null;
  /** A deterministic PDF whose account matched a portfolio was written straight
   *  into the transactions table as draft rows (no review step). `drafts` is then absent. */
  materialized?: boolean;
  /** Target portfolio for a materialized import. */
  portfolioId?: string;
  /** Number of draft transactions materialized. */
  materializedCount?: number;
  /** Set when the uploaded PDF was recognized as an account-level report (e.g. the annual
   *  TR tax report) rather than a transaction statement — detected before the vision-LLM
   *  fallback ever runs, so no import row is created and no bytes are persisted. `drafts`/
   *  `contracts`/`errors`/`importId` are absent/meaningless on this branch; the caller
   *  should re-upload the same file to `uploadDocument()` (with a chosen portfolioId) to
   *  actually save it into the tax-reports inbox. */
  isReport?: boolean;
  reportCategory?: DocumentCategory;
  reportTaxYear?: number | null;
  reportTitle?: string;
}

/** Brief summary of a retained source document, embedded on ImportRecord (#231). */
export interface ImportDocumentSummary {
  id: string;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  storedAt: string;
}

/** A past import in the user's history (draft, confirmed, or discarded). */
export interface ImportRecord {
  id: string;
  portfolioId: string | null;
  parser: string;
  status: "draft" | "confirmed" | "discarded";
  confidence: string | null;
  count: number;
  /** Correlation id shared by all imports created in one upload step (null for legacy/
   *  single-file rows). Lets the import history group a same-step batch as one unit. */
  batchId: string | null;
  createdAt: string;
  /** Retained source document, if one exists and the portfolio has retention enabled. */
  document: ImportDocumentSummary | null;
  /**
   * The uploaded file's original name, for display — available even before confirm/retention
   * (a "staged" document still carries it), unlike {@link document} which is retained-only.
   * Never implies a downloadable file exists; use `document` for that.
   */
  originalFilename: string | null;
}

/** Signed-URL response for a retained source document. */
export interface DocumentUrlResponse {
  url: string;
  filename: string | null;
  mimeType: string;
}

/** An account-level document in the tax-reports inbox (TR postbox fetch or user upload). */
export interface InboxDocument {
  id: string;
  category: string;
  taxYear: number | null;
  /** "pytr" for a TR postbox fetch, "upload" for a user upload. */
  source: string | null;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  portfolioId: string | null;
  /** Display name of the linked portfolio/connection, when known — null for uploads with
   *  no portfolio selected. */
  portfolioLabel: string | null;
  storedAt: string;
}

/**
 * An event type that reached the importer but had no mapping (the safety net). A non-empty
 * list means a sync source (Trade Republic) emitted a type we don't yet classify — it is
 * excluded from balances until mapped.
 */
export interface UnmappedEventType {
  /** TR event type, or null for the schema-unparseable (e.g. null-eventType) case. */
  eventType: string | null;
  code: "unmapped_event_type" | "unparseable_event";
  message: string;
  count: number;
  lastSeen: string;
  /** Raw source-event fields for debugging / seeding a mapping. */
  sample: {
    isin?: string | null;
    name?: string | null;
    currency?: string | null;
    executedAt?: string | null;
    amount?: number | null;
    shares?: number | null;
  } | null;
}

/** A single import with its parsed drafts — used to review a staged draft. */
export interface ImportDetail {
  id: string;
  portfolioId: string | null;
  parser: string;
  status: "draft" | "confirmed" | "discarded";
  drafts: DraftTransaction[];
  contracts: ParsedGoldContract[];
  errors: ImportIssue[];
}

// --- Interactive Brokers ---

export type IbkrStatus = "disconnected" | "connected" | "expired" | "error";

/** Public state of the user's IBKR Flex connection — never includes the token. */
export interface IbkrConnection {
  status: IbkrStatus;
  portfolioId: string | null;
  flexAccountId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastReconciliation: CashReconciliation | null;
  syncing: boolean;
}

export interface IbkrConnectInput {
  token: string;
  queryId: string;
  portfolioId: string;
}

export interface IbkrSyncResult {
  status: IbkrStatus;
  importId?: string;
  drafts?: number;
  errors?: number;
  reconciliation?: CashReconciliation;
}

// --- Trade Republic ---

export type TrStatus =
  | "disconnected"
  // Push sent — awaiting the user's approval in the Trade Republic mobile app.
  | "awaiting_2fa"
  | "connected"
  | "expired"
  | "error";

/** TR's reported cash + position snapshot vs our derived figures (decimal strings). */
export interface CashReconciliation {
  checkedAt: string;
  cash: { currency: string; reported: string; derived: string; diff: string }[];
  /** Per-ISIN position diff (absent on older syncs before position snapshot was added). */
  positions?: { isin: string; reported: string; derived: string; diff: string }[] | null;
}

/** Public state of the user's Trade Republic connection — never includes secrets. */
export interface TrConnection {
  status: TrStatus;
  portfolioId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Last cash reconciliation (TR-reported vs derived), or null until first synced. */
  lastReconciliation: CashReconciliation | null;
  /** True while a background sync job is running. Poll GET /tr/connection to observe. */
  syncing: boolean;
}

export interface TrConnectInput {
  phone: string;
  pin: string;
  portfolioId: string;
  /** Break-glass: a manually pasted aws-waf-token instead of the solver. */
  wafToken?: string;
}

export interface TrSyncResult {
  status: TrStatus;
  importId?: string;
  drafts?: number;
  errors?: number;
  cancelled?: number;
  reconciliation?: CashReconciliation;
}

// --- Client --------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
  ) {
    super(`API request failed (${status})`);
    this.name = "ApiError";
  }
}

/**
 * Extract the machine-readable `error` code from a thrown error. The API reports
 * failures as `{ error: "<code>" }` (e.g. `pytr_not_available`, `encryption_required`);
 * this returns that code so callers can show a specific message instead of a generic
 * one. Returns null for non-ApiErrors or bodies without a string `error` field.
 */
export function apiErrorCode(err: unknown): string | null {
  if (!(err instanceof ApiError)) return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      "error" in parsed &&
      typeof (parsed as { error: unknown }).error === "string"
    ) {
      return (parsed as { error: string }).error;
    }
  } catch {
    // body wasn't JSON — fall through
  }
  return null;
}

/** The vision-provider failure detail carried by a 502 `screenshot_parse_failed` response. */
export interface VisionProviderError {
  /** Which provider failed ("claude" | "gemini" | "openrouter" | "ollama"), or null if absent. */
  provider: string | null;
  /** The provider's own HTTP status (429 rate-limit, 401/403 auth, 5xx down), or null if unknown. */
  providerStatus: number | null;
}

/**
 * Extract the vision-provider failure from a thrown 502
 * (`{ error: "screenshot_parse_failed", reason, provider, providerStatus }`). The web layer maps
 * `providerStatus` to a specific reason (rate-limit / provider-auth / provider-down) instead of a
 * generic "couldn't be read". Returns null for any other error.
 */
export function visionProviderErrorFromError(err: unknown): VisionProviderError | null {
  if (!(err instanceof ApiError) || err.status !== 502) return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { error?: unknown }).error === "screenshot_parse_failed"
    ) {
      const p = parsed as { provider?: unknown; providerStatus?: unknown };
      return {
        provider: typeof p.provider === "string" ? p.provider : null,
        providerStatus: typeof p.providerStatus === "number" ? p.providerStatus : null,
      };
    }
  } catch {
    // body wasn't JSON — fall through
  }
  return null;
}

/**
 * Extract the account-mismatch verdict from a thrown 409 (`{ error: "account_mismatch", … }`).
 * Returns null for any other error so callers can `if (accountMismatchFromError(err))` to
 * detect and re-prompt with `acknowledgeAccountMismatch`. (#197)
 */
export function accountMismatchFromError(err: unknown): AccountMismatch | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { error?: unknown }).error === "account_mismatch"
    ) {
      const { error: _omit, ...rest } = parsed as Record<string, unknown>;
      return rest as unknown as AccountMismatch;
    }
  } catch {
    // body wasn't JSON — fall through
  }
  return null;
}

/** One selected draft that economically matches an already-committed transaction (#217, #230). */
export interface DuplicateMatch {
  /** Instrument name/ISIN/ticker of the duplicated draft (best-effort, may be null). */
  name: string | null;
  action: string;
  quantity: string;
  /** The draft's own execution day (YYYY-MM-DD). */
  executedAt: string;
  /** Source of the already-committed transaction it matched (`csv` / `screenshot` / `pytr`). */
  matchedSource: string | null;
  /** Execution day of the committed match (YYYY-MM-DD). */
  matchedExecutedAt: string;
  /** Index of this draft in the submitted confirm-subset (for dropping it after enrich). */
  draftIndex: number;
  /** Id of the already-committed transaction — used to target the enrich route. */
  matchedTransactionId: string;
}

/** Verdict that a confirm contains cross-source economic duplicates (#217). */
export interface DuplicateConflict {
  count: number;
  duplicates: DuplicateMatch[];
}

/**
 * Extract the duplicate verdict from a thrown 409 (`{ error: "duplicate_transactions", … }`).
 * Returns null for any other error so callers can `if (duplicatesFromError(err))` to detect
 * and re-prompt with `acknowledgeDuplicates`. (#217)
 */
export function duplicatesFromError(err: unknown): DuplicateConflict | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  try {
    const parsed: unknown = JSON.parse(err.body);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed as { error?: unknown }).error === "duplicate_transactions"
    ) {
      const { count, duplicates } = parsed as Record<string, unknown>;
      return {
        count: typeof count === "number" ? count : 0,
        duplicates: Array.isArray(duplicates) ? (duplicates as DuplicateMatch[]) : [],
      };
    }
  } catch {
    // body wasn't JSON — fall through
  }
  return null;
}

export interface ApiClientConfig {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** Override fetch (tests / non-browser runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

/** Build the upload query string for the CSV/screenshot routes from the `force` re-import
 *  flag and the optional per-upload-step `batchId` correlation id. */
function uploadQuery(force: boolean, batchId?: string): string {
  const params = new URLSearchParams();
  if (force) params.set("force", "true");
  if (batchId) params.set("batchId", batchId);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timingEnabled =
    typeof (globalThis as Record<string, unknown>).process !== "undefined" &&
    typeof ((globalThis as Record<string, unknown>).process as Record<string, unknown>).env === "object" &&
    ((globalThis as Record<string, unknown>).process as Record<string, Record<string, string>>).env
      ?.TIMING_ENABLED === "true";

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const t0 = timingEnabled ? performance.now() : 0;
    const token = await config.getToken?.();
    // Only declare a JSON content-type when we actually send a body. A bodyless
    // request (e.g. DELETE) that still advertises application/json trips Fastify's
    // FST_ERR_CTP_EMPTY_JSON_BODY → 400 before the route handler runs.
    // For FormData (multipart/form-data) do NOT set the content-type header — the browser
    // must set it with the multipart boundary; setting it manually breaks the boundary.
    const hasBody = body !== undefined;
    const isForm = typeof FormData !== "undefined" && body instanceof FormData;
    const res = await doFetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        ...(hasBody && !isForm ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: isForm ? (body as FormData) : hasBody ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text());
    }
    if (res.status === 204) return undefined as T;
    const result = (await res.json()) as T;
    if (timingEnabled) {
      const durationMs = performance.now() - t0;
      console.log(
        JSON.stringify({
          level: "info",
          msg: `[timing] api-client request`,
          method,
          path,
          durationMs: Math.round(durationMs * 100) / 100,
        }),
      );
    }
    return result;
  }

  /** Like `request` but returns a Blob — for binary downloads (zip exports etc.). */
  async function requestBlob(method: string, path: string): Promise<Blob> {
    const token = await config.getToken?.();
    const res = await doFetch(`${config.baseUrl}${path}`, {
      method,
      headers: { ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    if (!res.ok) {
      throw new ApiError(res.status, await res.text());
    }
    return res.blob();
  }

  return {
    me: () => request<User>("GET", "/me"),
    updateMe: (input: UserUpdate) => request<User>("PATCH", "/me", input),

    // Personal access tokens (programmatic API access scoped to the user).
    listApiTokens: () => request<ApiToken[]>("GET", "/me/tokens"),
    createApiToken: (input: ApiTokenCreate) =>
      request<ApiTokenWithSecret>("POST", "/me/tokens", input),
    deleteApiToken: (id: string) =>
      request<void>("DELETE", `/me/tokens/${encodeURIComponent(id)}`),

    // Admin: market-data provider config (enable/disable + fallback priority + credentials).
    getAdminProviders: () => request<AdminProvidersResponse>("GET", "/admin/providers"),
    updateAdminProviders: (input: ProviderSettingUpdate[]) =>
      request<AdminProvidersResponse>("PATCH", "/admin/providers", input),
    setAdminProviderCredential: (id: string, body: ProviderCredentialInput) =>
      request<AdminProvidersResponse>("PUT", `/admin/providers/${encodeURIComponent(id)}/credential`, body),
    clearAdminProviderCredential: (id: string) =>
      request<AdminProvidersResponse>("DELETE", `/admin/providers/${encodeURIComponent(id)}/credential`),
    getAdminAuditLog: () => request<AdminAuditEntry[]>("GET", "/admin/audit"),

    // Admin: vision LLM provider config (enable/disable + fallback priority + credentials).
    getAdminVisionProviders: () =>
      request<AdminVisionProvidersResponse>("GET", "/admin/vision-providers"),
    updateAdminVisionProviders: (input: ProviderSettingUpdate[]) =>
      request<AdminVisionProvidersResponse>("PATCH", "/admin/vision-providers", input),
    setAdminVisionProviderCredential: (id: string, body: ProviderCredentialInput) =>
      request<AdminVisionProvidersResponse>(
        "PUT",
        `/admin/vision-providers/${encodeURIComponent(id)}/credential`,
        body,
      ),
    clearAdminVisionProviderCredential: (id: string) =>
      request<AdminVisionProvidersResponse>(
        "DELETE",
        `/admin/vision-providers/${encodeURIComponent(id)}/credential`,
      ),

    // Admin: import strategy (deterministic parser vs vision-LLM) for screenshots/PDFs.
    getAdminImportSettings: () =>
      request<AdminImportSettingsResponse>("GET", "/admin/import-settings"),
    updateAdminImportSettings: (input: ImportSettingsUpdate) =>
      request<AdminImportSettingsResponse>("PATCH", "/admin/import-settings", input),

    // Admin: storage provider config (single-active S3 or folder, DB overrides env).
    getAdminStorageProviders: () =>
      request<AdminStorageResponse>("GET", "/admin/storage-providers"),
    updateAdminStorageProviders: (input: StorageSettingsUpdate) =>
      request<AdminStorageResponse>("PATCH", "/admin/storage-providers", input),
    setAdminStorageS3Secret: (body: StorageSecretInput) =>
      request<AdminStorageResponse>("PUT", "/admin/storage-providers/s3/secret", body),
    clearAdminStorageS3Secret: () =>
      request<AdminStorageResponse>("DELETE", "/admin/storage-providers/s3/secret"),
    testAdminStorageProvider: () =>
      request<AdminStorageTestResult>("POST", "/admin/storage-providers/test"),

    // Admin: server statistics (#140).
    getAdminStats: () => request<AdminStats>("GET", "/admin/stats"),

    // Admin: background jobs panel (#105 + Slice 5).
    getAdminJobs: () => request<AdminJobsResponse>("GET", "/admin/jobs"),
    triggerAdminJob: (name: string, opts?: { force?: boolean }) =>
      request<{ queued: boolean; name: string }>(
        "POST",
        `/admin/jobs/${encodeURIComponent(name)}/trigger`,
        opts?.force ? { force: true } : undefined,
      ),

    // Admin: user management (#486).
    getAdminUsers: () => request<AdminUser[]>("GET", "/admin/users"),
    adminRevokeUserTokens: (id: string) =>
      request<{ revoked: number }>("POST", `/admin/users/${encodeURIComponent(id)}/revoke-tokens`),
    adminDeleteUser: (id: string) =>
      request<{ deleted: boolean }>("POST", `/admin/users/${encodeURIComponent(id)}/delete`),

    getNetWorth: (
      costBasis?: "purchase_price" | "total_paid",
      holderId?: string,
      period?: string,
    ) => {
      const params = new URLSearchParams();
      if (costBasis) params.set("costBasis", costBasis);
      if (holderId) params.set("holderId", holderId);
      if (period && period !== "max") params.set("period", period);
      const qs = params.toString();
      return request<NetWorth>("GET", qs ? `/networth?${qs}` : "/networth");
    },

    getPreferences: () => request<UserPreferences>("GET", "/me/preferences"),
    putPreferences: (
      prefs: Partial<{
        dashboardPeriod: string;
        dashboardKpis: string[];
        costBasisMode: "purchase_price" | "total_paid";
        taxRegime: "DE" | "ID";
      }>,
    ) => request<UserPreferences>("PUT", "/me/preferences", prefs),
    getIncome: (holderId?: string) =>
      request<IncomeStats>(
        "GET",
        holderId ? `/networth/income?holderId=${encodeURIComponent(holderId)}` : "/networth/income",
      ),
    getPortfolioIncome: (portfolioId: string) =>
      request<IncomeStats>("GET", `/portfolios/${portfolioId}/income`),
    getIncomeEventsByYear: (year: number, holderId?: string) =>
      request<{ displayCurrency: string; events: IncomeEvent[] }>(
        "GET",
        holderId
          ? `/networth/income?eventsYear=${year}&holderId=${encodeURIComponent(holderId)}`
          : `/networth/income?eventsYear=${year}`,
      ),
    getContributions: (holderId?: string) =>
      request<ContributionStats>(
        "GET",
        holderId
          ? `/networth/contributions?holderId=${encodeURIComponent(holderId)}`
          : "/networth/contributions",
      ),
    getPortfolioContributions: (portfolioId: string) =>
      request<ContributionStats>("GET", `/portfolios/${portfolioId}/contributions`),
    getSparplan: (holderId?: string) =>
      request<SparplanStats>(
        "GET",
        holderId
          ? `/networth/sparplan?holderId=${encodeURIComponent(holderId)}`
          : "/networth/sparplan",
      ),
    getPortfolioSparplan: (portfolioId: string, includeSales?: boolean) =>
      request<SparplanStats>(
        "GET",
        `/portfolios/${portfolioId}/sparplan${includeSales ? "?includeSales=true" : ""}`,
      ),
    getNetWorthHistory: (range = "1y", opts?: { include?: string[]; exclude?: string[]; holderId?: string }) => {
      const params = new URLSearchParams({ range });
      if (opts?.include?.length) params.set("include", opts.include.join(","));
      if (opts?.exclude?.length) params.set("exclude", opts.exclude.join(","));
      if (opts?.holderId) params.set("holderId", opts.holderId);
      return request<HistoryPoint[]>("GET", `/networth/history?${params.toString()}`);
    },
    getPortfolioHistory: (portfolioId: string, range = "1y") =>
      request<HistoryPoint[]>(
        "GET",
        `/portfolios/${portfolioId}/history?range=${encodeURIComponent(range)}`,
      ),

    listPortfolios: () => request<Portfolio[]>("GET", "/portfolios"),
    listPortfolioValues: () => request<{ id: string; netWorth: string }[]>("GET", "/portfolios/values"),
    createPortfolio: (input: PortfolioInput) => request<Portfolio>("POST", "/portfolios", input),
    updatePortfolio: (portfolioId: string, input: Partial<PortfolioInput>) =>
      request<Portfolio>("PATCH", `/portfolios/${portfolioId}`, input),
    deletePortfolio: (portfolioId: string) => request<void>("DELETE", `/portfolios/${portfolioId}`),

    listAccountHolders: () => request<AccountHolder[]>("GET", "/account-holders"),
    createAccountHolder: (input: AccountHolderInput) =>
      request<AccountHolder>("POST", "/account-holders", input),
    updateAccountHolder: (holderId: string, input: Partial<AccountHolderInput>) =>
      request<AccountHolder>("PATCH", `/account-holders/${holderId}`, input),
    deleteAccountHolder: (holderId: string) =>
      request<void>("DELETE", `/account-holders/${holderId}`),

    /** `convertTo` requests a per-row `displayRate`/`displayCurrency` (trade-date FX into
     *  that currency) alongside each row's native amount — see issue #465. */
    listTransactions: (portfolioId: string, convertTo?: string) =>
      request<Transaction[]>(
        "GET",
        convertTo
          ? `/portfolios/${portfolioId}/transactions?convertTo=${encodeURIComponent(convertTo)}`
          : `/portfolios/${portfolioId}/transactions`,
      ),
    /** Paginated variant: returns one page + total count. Enrichment only runs on the
     *  returned page, so this is ~10× faster than fetching all 945+ rows. Accepts optional
     *  filter params (`type`, `year`, `q`) that are passed to the server and returns
     *  summary aggregates and available years when requested. */
    listTransactionsPaginated: (
      portfolioId: string,
      page: number,
      pageSize = 25,
      convertTo?: string,
      type?: string,
      year?: string,
      q?: string,
    ) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (convertTo) params.set("convertTo", convertTo);
      if (type) params.set("type", type);
      if (year) params.set("year", year);
      if (q) params.set("q", q);
      return request<{ rows: Transaction[]; total: number; summary?: { totalInvested: string; totalProceeds: string; totalIncome: string }; years?: string[] }>(
        "GET",
        `/portfolios/${portfolioId}/transactions?${params}`,
      );
    },
    /** Aggregate paginated transactions across all portfolios (networth scope).
     *  Same enrichment + filter pattern as the per-portfolio paginated variant. */
    listNetworthTransactionsPaginated: (
      page: number,
      pageSize = 25,
      type?: string,
      year?: string,
      q?: string,
    ) => {
      const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
      if (type) params.set("type", type);
      if (year) params.set("year", year);
      if (q) params.set("q", q);
      return request<{ rows: Transaction[]; total: number; years?: string[] }>(
        "GET",
        `/networth/transactions?${params}`,
      );
    },
    /** List income-only rows for a portfolio in the given tax year (lightweight, no instrument/sources enrichment). */
    listIncomeByYear: (portfolioId: string, year: number) =>
      request<Transaction[]>(
        "GET",
        `/portfolios/${portfolioId}/income-year?year=${year}`,
      ),
    /** Look up a single FX rate for a given currency pair and date. Returns null when no
     *  rate is available for that pair/date (caller falls back to 1:1). */
    getFxRate: (from: string, to: string, date: string) =>
      request<{ rate: string | null }>(
        "GET",
        `/fx-rate?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(date)}`,
      ),
    createTransaction: (portfolioId: string, input: Omit<TransactionInput, "portfolioId">) =>
      request<Transaction>("POST", `/portfolios/${portfolioId}/transactions`, input),
    updateTransaction: (
      portfolioId: string,
      txId: string,
      input: Omit<TransactionInput, "portfolioId">,
    ) => request<Transaction>("PATCH", `/portfolios/${portfolioId}/transactions/${txId}`, input),
    deleteTransaction: (portfolioId: string, txId: string) =>
      request<void>("DELETE", `/portfolios/${portfolioId}/transactions/${txId}`),
    /** Set a transaction's visibility status (archive a phantom, mark a reward-funded
     * buy cash_neutral, or restore to normal) without re-sending the whole row. */
    setTransactionStatus: (portfolioId: string, txId: string, status: TransactionStatus) =>
      request<Transaction>(
        "PATCH",
        `/portfolios/${portfolioId}/transactions/${txId}/status`,
        { status },
      ),
    bulkDeleteTransactions: (portfolioId: string, ids: string[]) =>
      request<{ deleted: number }>("POST", `/portfolios/${portfolioId}/transactions/bulk-delete`, {
        ids,
      }),
    /** Resolve draft transactions (from a sync/import) in bulk: "confirm" (→ normal, starts
     * counting) or "discard" (→ archived, kept but excluded from every derivation). One
     * request for N ids — used for both single-row and batch actions. */
    resolveDraftTransactions: (
      portfolioId: string,
      ids: string[],
      action: "confirm" | "discard",
    ) =>
      request<{ updated: number }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/resolve-drafts`,
        { ids, action },
      ),
    /** Confirm a single draft transaction (→ normal). */
    confirmDraftTransaction: (portfolioId: string, txId: string) =>
      request<{ updated: number }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/resolve-drafts`,
        { ids: [txId], action: "confirm" },
      ),
    /** Discard a single draft transaction (→ archived). */
    discardDraftTransaction: (portfolioId: string, txId: string) =>
      request<{ updated: number }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/resolve-drafts`,
        { ids: [txId], action: "discard" },
      ),
    /** Reassign transactions to another portfolio (move a wrong-portfolio import in one
     * action). Rows already in the target, or whose economic identity already exists there,
     * are skipped (`skippedConflicts`); financed-gold legs are skipped (`skippedLoans`). */
    reassignTransactions: (
      portfolioId: string,
      ids: string[],
      targetPortfolioId: string,
    ) =>
      request<{ moved: number; skippedConflicts: number; skippedLoans: number }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/reassign`,
        { ids, targetPortfolioId },
      ),
    /** Reassign every transaction an import wrote to another portfolio. */
    reassignImport: (importId: string, targetPortfolioId: string) =>
      request<{ moved: number; skippedConflicts: number; skippedLoans: number }>(
        "POST",
        `/imports/${importId}/reassign`,
        { targetPortfolioId },
      ),
    /** Record a fund merger (Fondsverschmelzung) as an atomic sell+buy pair. */
    createMerger: (portfolioId: string, input: Omit<MergerInput, "portfolioId">) =>
      request<Transaction[]>("POST", `/portfolios/${portfolioId}/mergers`, input),
    /** Read-only preview of merging two duplicate transactions — validates the guardrails
     * (same instrument, compatible type, no loan legs) and returns what the merged result
     * would look like, without writing anything. */
    previewMergeTransactions: (portfolioId: string, survivorId: string, absorbedId: string) =>
      request<MergePreview>(
        "GET",
        `/portfolios/${portfolioId}/transactions/merge-preview?survivorId=${survivorId}&absorbedId=${absorbedId}`,
      ),
    /** Merge two duplicate transactions (manual recovery when cross-source dedup misses a
     * pair). `survivorId` keeps its core economic fields; `absorbedId`'s sources/documents
     * fold in and it is deleted. */
    mergeTransactions: (portfolioId: string, survivorId: string, absorbedId: string) =>
      request<{ survivorId: string }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/merge`,
        { survivorId, absorbedId },
      ),

    getQuote: (ref: QuoteRef) =>
      request<Quote>(
        "GET",
        `/quotes?${new URLSearchParams({
          symbol: ref.symbol,
          market: ref.market,
          assetClass: ref.assetClass,
          currency: ref.currency,
        }).toString()}`,
      ),

    searchInstruments: (q?: string) =>
      request<Instrument[]>("GET", `/instruments${q ? `?q=${encodeURIComponent(q)}` : ""}`),

    /**
     * User-scoped global search across instruments (owned-first, with catalog fallback)
     * and transactions (matched by description / tags).  The `holderId` facet narrows
     * the transaction and owned-instrument results to a specific account holder's
     * portfolios.  Results are grouped: `instruments` and `transactions`.
     */
    globalSearch: (params: { q: string; holderId?: string; types?: string[]; limit?: number }) => {
      const p = new URLSearchParams({ q: params.q });
      if (params.holderId) p.set("holderId", params.holderId);
      if (params.limit != null) p.set("limit", String(params.limit));
      if (params.types && params.types.length > 0) {
        // Repeat the param for each type (array-in-querystring).
        for (const t of params.types) p.append("types", t);
      }
      return request<GlobalSearchResult>("GET", `/search?${p.toString()}`);
    },
    /** Discover instruments from market data (ticker/name search or ISIN). */
    lookupInstruments: (q: string) =>
      request<InstrumentSearchResult[]>("GET", `/instruments/lookup?q=${encodeURIComponent(q)}`),
    getInstrument: (id: string) => request<Instrument>("GET", `/instruments/${id}`),
    getInstrumentHistory: (id: string, range = "1y") =>
      request<Candle[]>("GET", `/instruments/${id}/history?range=${encodeURIComponent(range)}`),
    createInstrument: (input: InstrumentInput) =>
      request<Instrument>("POST", "/instruments", input),
    /** Update an instrument's identifiers (ISIN, WKN, symbol, name, assetClass, market). */
    updateInstrument: (
      id: string,
      patch: { isin?: string | null; wkn?: string | null; symbol?: string; name?: string; assetClass?: string; market?: string },
    ) => request<Instrument>("PATCH", `/instruments/${id}`, patch),
    /** On-demand Börse Frankfurt enrichment — returns results with ISIN + WKN. */
    enrichInstruments: (q: string) =>
      request<InstrumentSearchResult[]>("GET", `/instruments/enrich?q=${encodeURIComponent(q)}`),
    /** Configured gold buyback sources for the manual-entry gold flow. */
    getGoldSources: () => request<GoldSource[]>("GET", "/instruments/gold-sources"),

    createCorporateAction: (input: CorporateActionInput) =>
      request<CorporateAction>("POST", "/corporate-actions", input),
    updateCorporateAction: (id: string, input: Partial<CorporateActionInput>) =>
      request<CorporateAction>("PATCH", `/corporate-actions/${id}`, input),
    deleteCorporateAction: (id: string) => request<void>("DELETE", `/corporate-actions/${id}`),
    listCorporateActions: (instrumentId: string) =>
      request<CorporateAction[]>("GET", `/instruments/${instrumentId}/corporate-actions`),

    getHoldings: (portfolioId: string) =>
      request<HoldingsResult>("GET", `/portfolios/${portfolioId}/holdings`),
    getAnomalies: (portfolioId: string) =>
      request<AnomaliesResult>("GET", `/portfolios/${portfolioId}/anomalies`),
    /** Persistently dismiss a transaction-scoped anomaly (e.g. an accepted negative_cash). */
    dismissAnomaly: (portfolioId: string, transactionId: string, code: string) =>
      request<void>("POST", `/portfolios/${portfolioId}/anomalies/dismiss`, {
        transactionId,
        code,
      }),
    /** Undo a previously-dismissed anomaly (it reappears if still derived). */
    undismissAnomaly: (portfolioId: string, transactionId: string, code: string) =>
      request<void>("DELETE", `/portfolios/${portfolioId}/anomalies/dismiss`, {
        transactionId,
        code,
      }),
    getSummary: (portfolioId: string, costBasis?: "purchase_price" | "total_paid") =>
      request<PortfolioSummary>(
        "GET",
        costBasis
          ? `/portfolios/${portfolioId}/summary?costBasis=${costBasis}`
          : `/portfolios/${portfolioId}/summary`,
      ),
    getPerformance: (portfolioId: string) =>
      request<PortfolioPerformance>("GET", `/portfolios/${portfolioId}/performance`),

    // --- Allocation targets ---
    /** Fetch saved target weights for a portfolio-scoped dimension. */
    getPortfolioTargets: (portfolioId: string, dimension: string) =>
      request<TargetWeight[]>(
        "GET",
        `/portfolios/${portfolioId}/targets?dimension=${encodeURIComponent(dimension)}`,
      ),
    /**
     * Replace the entire target-weight set for a portfolio + dimension (atomic).
     * `targets` must sum to ~100. Passing an empty array clears all targets for
     * that (portfolioId, dimension) scope.
     */
    putPortfolioTargets: (
      portfolioId: string,
      dimension: string,
      targets: TargetWeight[],
    ) =>
      request<TargetWeight[]>(
        "PUT",
        `/portfolios/${portfolioId}/targets`,
        { dimension, targets },
      ),
    /** Fetch saved aggregate (networth-level) target weights for a dimension. */
    getNetworthTargets: (dimension: string) =>
      request<TargetWeight[]>(
        "GET",
        `/networth/targets?dimension=${encodeURIComponent(dimension)}`,
      ),
    /**
     * Replace the aggregate (networth-level) target-weight set for a dimension (atomic).
     */
    putNetworthTargets: (dimension: string, targets: TargetWeight[]) =>
      request<TargetWeight[]>("PUT", "/networth/targets", { dimension, targets }),

    getTrades: (
      portfolioId: string,
      method: TradeMethod = "average",
      costBasis?: "purchase_price" | "total_paid",
    ) => {
      const params = new URLSearchParams({ method });
      if (costBasis) params.set("costBasis", costBasis);
      return request<TradeLog>("GET", `/portfolios/${portfolioId}/trades?${params.toString()}`);
    },
    getNetWorthTrades: (
      method: TradeMethod = "average",
      costBasis?: "purchase_price" | "total_paid",
      holderId?: string,
    ) => {
      const params = new URLSearchParams({ method });
      if (costBasis) params.set("costBasis", costBasis);
      if (holderId) params.set("holderId", holderId);
      return request<TradeLog>("GET", `/networth/trades?${params.toString()}`);
    },

    /**
     * German Sparerpauschbetrag headroom + harvest suggestions for a single portfolio.
     * The portfolio's own `taxAllowanceAnnual` (per-depot Freistellungsauftrag allocation)
     * must be configured, otherwise the API returns 422 (tax_allowance_not_configured).
     * The response includes `holderDistribution` showing how much of the holder's cap
     * is allocated across their depots.
     */
    getPortfolioTax: (portfolioId: string, year?: number) => {
      const params = new URLSearchParams();
      if (year !== undefined) params.set("year", String(year));
      const qs = params.toString();
      return request<PortfolioTaxSummary>(
        "GET",
        `/portfolios/${portfolioId}/tax${qs ? `?${qs}` : ""}`,
      );
    },

    /**
     * Aggregated German tax summary across all of the user's portfolios, grouped by
     * holder. Only holders where at least one portfolio has a `taxAllowanceAnnual` (FSA
     * allocation) are returned. Each entry includes a `distribution` field showing how
     * much of the holder's per-person cap is allocated across their depots.
     * Optionally filter to a single holder via `holderId`.
     */
    getNetworthTax: (year?: number, holderId?: string) => {
      const params = new URLSearchParams();
      if (year !== undefined) params.set("year", String(year));
      if (holderId !== undefined) params.set("holderId", holderId);
      const qs = params.toString();
      return request<TaxSummaryHolder[]>(
        "GET",
        `/networth/tax${qs ? `?${qs}` : ""}`,
      );
    },

    // `force` re-imports a file the server would otherwise dedup against an earlier import
    // (e.g. the user deleted some of those transactions and wants them back). Survivors are
    // re-flagged at confirm time, so this never silently creates true duplicates (#229).
    importCsv: (
      content: string,
      filename?: string,
      format: "auto" | "generic" | "dkb" | "ibkr" | "ibkr-xml" | "coinbase" | "tr-csv" = "auto",
      force = false,
      batchId?: string,
    ) =>
      request<CsvImportResult>("POST", `/imports/csv${uploadQuery(force, batchId)}`, {
        content,
        filename,
        format,
      }),
    importScreenshot: (file: File | Blob, force = false, batchId?: string) => {
      const form = new FormData();
      // name hint for filename preservation; mime comes from the file part itself.
      form.append("file", file, (file as File).name ?? "upload");
      return request<ScreenshotImportResult>(
        "POST",
        `/imports/screenshot${uploadQuery(force, batchId)}`,
        form,
      );
    },
    confirmImport: (
      importId: string,
      transactions: ParsedTransaction[],
      contracts: ParsedGoldContract[] = [],
      portfolioId?: string,
      acknowledgeAccountMismatch = false,
      acknowledgeDuplicates = false,
    ) =>
      request<{
        confirmed: number;
        transactions: Transaction[];
        likelyDuplicates: number;
        enriched: number;
        skipped: number;
        /** Cash-movement rows dropped because the target portfolio is cash-outside (#326). */
        excludedCashMovements: number;
      }>(
        "POST",
        `/imports/${importId}/confirm`,
        {
          portfolioId,
          transactions,
          contracts,
          acknowledgeAccountMismatch,
          acknowledgeDuplicates,
        },
      ),
    /**
     * Materialize a staged import's parsed drafts into the chosen portfolio as `status='draft'`
     * transactions (the upload "confirm portfolio" step). Reads the server-stored drafts — it
     * never re-parses, so an account-mismatch acknowledge does not re-run a vision LLM. The
     * server returns a 409 `account_mismatch` verdict unless `acknowledgeAccountMismatch` is set.
     */
    materializeImport: (
      importId: string,
      portfolioId: string,
      acknowledgeAccountMismatch = false,
    ) =>
      request<{
        importId: string;
        materialized: boolean;
        portfolioId: string;
        materializedCount: number;
        excludedCashMovements: number;
        enrichedCount: number;
      }>("POST", `/imports/${importId}/materialize`, {
        portfolioId,
        acknowledgeAccountMismatch,
      }),
    /**
     * Read-only pre-flight for the upload modal's Confirm: for each (importId, portfolioId)
     * the user is about to commit, ask whether the file's detected account conflicts with the
     * *selected* portfolio — the same verdict the materialize/confirm guards apply. Returns only
     * the conflicting units so the modal can show the warning in place instead of as a
     * post-close toast. Writes nothing. (#197)
     */
    checkAccounts: (units: { importId: string; portfolioId: string }[]) =>
      request<{ mismatches: ({ importId: string } & AccountMismatch)[] }>(
        "POST",
        `/imports/account-check`,
        { units },
      ),
    /**
     * Preview which drafts in an import economically duplicate (or enrich) transactions in
     * the chosen portfolio — without persisting anything. Call this when the user selects or
     * changes the target portfolio in the review screen so badges appear before Confirm (#259).
     */
    checkImportDuplicates: (importId: string, portfolioId: string) =>
      request<{ annotations: DuplicateAnnotation[] }>(
        "POST",
        `/imports/${importId}/duplicates`,
        { portfolioId },
      ),
    listImports: () => request<ImportRecord[]>("GET", "/imports"),
    /** Safety net: event types that reached the importer but have no mapping yet. */
    getUnmappedEventTypes: () =>
      request<UnmappedEventType[]>("GET", "/imports/unmapped-types"),
    /** Fetch a single import with its parsed drafts (to review a staged draft). */
    getImport: (importId: string) => request<ImportDetail>("GET", `/imports/${importId}`),
    /** Discard a draft import (draft → discarded). */
    discardImport: (importId: string) => request<void>("POST", `/imports/${importId}/discard`),
    /** Undo an import: remove any transactions it wrote, then mark it discarded. */
    deleteImport: (importId: string) =>
      request<{ removed: number }>("DELETE", `/imports/${importId}`),
    /** Hard-delete a discarded import row (no-op on its already-removed children). */
    clearImport: (importId: string) =>
      request<void>("DELETE", `/imports/${importId}/clear`),
    /** Batch hard-delete of discarded imports (one request — used by "clear all"). */
    bulkClearImports: (ids: string[]) =>
      request<{ cleared: number }>("POST", `/imports/bulk-clear`, { ids }),
    /** Batch delete a mixed selection of imports in one request (avoids the N-per-row
     *  delete + refresh fan-out that trips the rate limiter). Dispatches per status server
     *  side: draft → discard, confirmed → undo, discarded → clear. Two-step semantics:
     *  undo/discard leave the row `discarded`; a follow-up call on those ids clears them. */
    bulkDeleteImports: (ids: string[]) =>
      request<{
        discarded: number;
        undone: number;
        cleared: number;
        removedTransactions: number;
      }>("POST", `/imports/bulk-delete`, { ids }),
    /** Return a signed URL for the retained source document of an import (#231). */
    getImportDocumentUrl: (importId: string) =>
      request<DocumentUrlResponse>("GET", `/imports/${importId}/document-url`),
    /** Return a signed URL for the retained source document of a transaction (#231). */
    getTransactionDocumentUrl: (portfolioId: string, txId: string) =>
      request<DocumentUrlResponse>("GET", `/portfolios/${portfolioId}/transactions/${txId}/document-url`),
    /** Return a signed URL for the PDF linked to a specific transaction_sources row (#230).
     * Allows per-leg downloads for split orders (each leg has its own documentId). */
    getSourceDocumentUrl: (portfolioId: string, txId: string, sourceId: string) =>
      request<DocumentUrlResponse>(
        "GET",
        `/portfolios/${portfolioId}/transactions/${txId}/sources/${sourceId}/document-url`,
      ),
    /**
     * Download all retained documents for a portfolio as a single zip archive.
     * Each entry carries a structured, date-first filename so its contents are
     * immediately identifiable (e.g. `2024-03-15_DKB-Depot_buy_VTI.pdf`).
     * Returns a Blob (application/zip) ready for client-side save.
     */
    exportPortfolioDocuments: (portfolioId: string) =>
      requestBlob("GET", `/portfolios/${portfolioId}/documents/export`),

    // --- Tax-reports inbox: account-level documents (TR postbox fetch + user uploads) that
    // don't belong to any single transaction — see storage/inbox.ts on the API side. -------
    /** List the current user's inbox documents, newest first (defaults to tax reports).
     *  `portfolioId` scopes to one account (e.g. the app-wide portfolio switcher). */
    listDocuments: (category?: DocumentCategory, portfolioId?: string) => {
      const params = new URLSearchParams();
      if (category) params.set("category", category);
      if (portfolioId) params.set("portfolioId", portfolioId);
      const qs = params.toString();
      return request<InboxDocument[]>("GET", `/documents${qs ? `?${qs}` : ""}`);
    },
    /** Signed URL for downloading an inbox document. */
    getDocumentUrl: (documentId: string) =>
      request<DocumentUrlResponse>("GET", `/documents/${documentId}/url`),
    /** Upload a tax PDF straight into the inbox. `portfolioId` is required — every inbox
     *  document must be associated with the account it covers. */
    uploadDocument: (
      file: File | Blob,
      opts: { category?: DocumentCategory; taxYear?: number; portfolioId: string },
    ) => {
      const form = new FormData();
      form.append("file", file, (file as File).name ?? "document.pdf");
      if (opts.category) form.append("category", opts.category);
      if (opts.taxYear != null) form.append("taxYear", String(opts.taxYear));
      form.append("portfolioId", opts.portfolioId);
      return request<{ id: string; duplicate: boolean; category: DocumentCategory; taxYear: number | null }>(
        "POST",
        "/documents",
        form,
      );
    },
    /** Delete an inbox document (removes the stored file too). */
    deleteDocument: (documentId: string) => request<void>("DELETE", `/documents/${documentId}`),
    /**
     * Enrich an already-confirmed transaction with a richer draft (e.g. PDF after CSV) (#230).
     *
     * Sends the full draft payload rather than a draftIndex — avoids the ambiguity between the
     * 409's draftIndex (into the confirm-subset) and the enrich route's stored-draft array.
     */
    enrichImport: (
      importId: string,
      enrichments: Array<{ draft: ParsedTransaction; targetTransactionId: string }>,
      portfolioId?: string,
    ) =>
      request<{ enriched: number; skipped: number[] }>("POST", `/imports/${importId}/enrich`, {
        portfolioId,
        enrichments,
      }),

    // --- Interactive Brokers ---
    getIbkrConnection: () => request<IbkrConnection>("GET", "/ibkr/connection"),
    connectIbkr: (input: IbkrConnectInput) =>
      request<{ status: IbkrStatus }>("POST", "/ibkr/connection", input),
    syncIbkr: () =>
      request<{ queued: boolean } | IbkrSyncResult>("POST", "/ibkr/connection/sync"),
    reimportIbkr: () => request<{ removed: number }>("POST", "/ibkr/connection/reimport"),
    disconnectIbkr: () => request<void>("DELETE", "/ibkr/connection"),

    // --- Trade Republic ---
    getTrConnection: () => request<TrConnection>("GET", "/tr/connection"),
    connectTr: (input: TrConnectInput) =>
      request<{ status: TrStatus }>("POST", "/tr/connection", input),
    // No code in the v2 push-approval flow: this long-polls until the user approves the
    // login in the TR mobile app (or it is declined / the window expires).
    verifyTr: () => request<{ status: TrStatus }>("POST", "/tr/connection/verify"),
    syncTr: () => request<{ queued: boolean } | TrSyncResult>("POST", "/tr/connection/sync"),
    reimportTr: () => request<{ removed: number }>("POST", "/tr/connection/reimport"),
    reprocessTrDocuments: () =>
      request<{ processed: number }>("POST", "/tr/connection/reprocess-documents"),
    disconnectTr: () => request<void>("DELETE", "/tr/connection"),
  };
}
