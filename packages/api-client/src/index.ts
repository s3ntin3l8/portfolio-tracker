import type {
  PortfolioInput,
  TransactionInput,
  MergerInput,
  InstrumentInput,
  CorporateActionInput,
  ParsedTransaction,
  ParsedGoldContract,
  ImportIssue,
  UserUpdate,
  ProviderSettingUpdate,
  ProviderCredentialInput,
  ImportStrategy,
  ImportSettingsUpdate,
} from "@portfolio/schema";

export type { ImportIssue, ParsedGoldContract, ProviderCredentialInput } from "@portfolio/schema";
export type { ImportStrategy, ImportSettingsUpdate } from "@portfolio/schema";

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
  objectStorage: {
    /** Always false — screenshots are parsed in-memory and discarded. */
    configured: false;
    note: string;
  };
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
  createdAt: string;
}

export interface AccountHolderInput {
  name: string;
  type: AccountHolderType;
  birthYear?: number | null;
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
  /** When false, this portfolio is excluded from the aggregate net-worth/performance view. */
  includeInAggregate: boolean;
  /** Whether cash is inside this portfolio's investment boundary. `true` = savings/
   * deposit account (contribution = net external cash, net worth includes cash);
   * `false` = mixed/invest-only (contribution = net invested capital, cash excluded). */
  cashCounted: boolean;
}

/** Presentation metadata for an instrument; `null` on cash (instrument-less) rows. */
export interface InstrumentMeta {
  symbol: string;
  name: string;
  assetClass: string;
  unit: string;
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
  /** Free-text memo (counterparty, merchant, transfer reference). */
  description: string | null;
  /** User-defined labels for filtering and reporting. */
  tags: string[] | null;
  currency: string;
  executedAt: string;
  source: string;
  instrument: InstrumentMeta | null;
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
  xirr: number | null;
  portfolioCount: number;
  asOf: string;
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
 * - "scheduled"  — coupon from a bond's fixed schedule
 * - "projected"  — dividend projected from last year's actual (seasonal heuristic)
 * - "announced"  — ex-date announced by the issuer; amount may still change
 * - "paid"       — cash has settled; amount is final
 */
export interface UpcomingPayment {
  instrumentId: string;
  symbol: string;
  name: string | null;
  date: string; // YYYY-MM-DD — ex-date for dividends, coupon date for bonds
  amount: string;
  currency: string;
  kind: "coupon" | "dividend";
  status: "scheduled" | "projected" | "announced" | "paid";
}

/** Trailing-12-month income + yield for an income-paying holding (display currency). */
export interface InstrumentYield {
  instrumentId: string;
  symbol: string;
  name: string | null;
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
  instrumentId: string | null;
  symbol: string | null;
  name: string | null;
  type: string; // "dividend" | "coupon"
  date: string; // YYYY-MM-DD
  amount: string;
  currency: string;
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
  /** Source of the already-committed transaction (e.g. "csv", "screenshot"). */
  source: string | null;
  /** When the already-committed transaction executed (ISO date). */
  executedAt: string;
}

/** A draft enriched with a cross-source duplicate hint (otherwise a plain ParsedTransaction). */
export type DraftTransaction = ParsedTransaction & { likelyDuplicate?: LikelyDuplicate };

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
  /** Set when the file's account looks like it belongs to a different portfolio. */
  accountMismatch?: AccountMismatch | null;
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
  /** Set when the file's account looks like it belongs to a different portfolio. */
  accountMismatch?: AccountMismatch | null;
}

/** A past import in the user's history (draft, confirmed, or discarded). */
export interface ImportRecord {
  id: string;
  portfolioId: string | null;
  parser: string;
  status: "draft" | "confirmed" | "discarded";
  confidence: string | null;
  count: number;
  createdAt: string;
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

export type TrStatus =
  | "disconnected"
  // Push sent — awaiting the user's approval in the Trade Republic mobile app.
  | "awaiting_2fa"
  | "connected"
  | "expired"
  | "error";

export type TrImportCategory = "trade" | "income" | "cashflow" | "card";

/** TR's reported cash vs our derived cash, per currency (decimal strings). */
export interface CashReconciliation {
  checkedAt: string;
  cash: { currency: string; reported: string; derived: string; diff: string }[];
}

/** Public state of the user's Trade Republic connection — never includes secrets. */
export interface TrConnection {
  status: TrStatus;
  portfolioId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  /** Which event categories the sync stages; null = default (everything but card spending). */
  importCategories: TrImportCategory[] | null;
  /** Last cash reconciliation (TR-reported vs derived), or null until first synced. */
  lastReconciliation: CashReconciliation | null;
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

/** One selected draft that economically matches an already-committed transaction (#217). */
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

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetch ?? globalThis.fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
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
    return (await res.json()) as T;
  }

  return {
    me: () => request<User>("GET", "/me"),
    updateMe: (input: UserUpdate) => request<User>("PATCH", "/me", input),

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

    // Admin: server statistics (#140).
    getAdminStats: () => request<AdminStats>("GET", "/admin/stats"),

    // Admin: background jobs panel (#105 + Slice 5).
    getAdminJobs: () => request<AdminJobsResponse>("GET", "/admin/jobs"),
    triggerAdminJob: (name: string) =>
      request<{ queued: boolean; name: string }>(
        "POST",
        `/admin/jobs/${encodeURIComponent(name)}/trigger`,
      ),

    getNetWorth: (costBasis?: "purchase_price" | "total_paid") =>
      request<NetWorth>("GET", costBasis ? `/networth?costBasis=${costBasis}` : "/networth"),
    getIncome: (holderId?: string) =>
      request<IncomeStats>(
        "GET",
        holderId ? `/networth/income?holderId=${encodeURIComponent(holderId)}` : "/networth/income",
      ),
    getPortfolioIncome: (portfolioId: string) =>
      request<IncomeStats>("GET", `/portfolios/${portfolioId}/income`),
    getContributions: (holderId?: string) =>
      request<ContributionStats>(
        "GET",
        holderId
          ? `/networth/contributions?holderId=${encodeURIComponent(holderId)}`
          : "/networth/contributions",
      ),
    getPortfolioContributions: (portfolioId: string) =>
      request<ContributionStats>("GET", `/portfolios/${portfolioId}/contributions`),
    getNetWorthHistory: (range = "1y", opts?: { include?: string[]; exclude?: string[] }) => {
      const params = new URLSearchParams({ range });
      if (opts?.include?.length) params.set("include", opts.include.join(","));
      if (opts?.exclude?.length) params.set("exclude", opts.exclude.join(","));
      return request<PerformancePoint[]>("GET", `/networth/history?${params.toString()}`);
    },
    getPortfolioHistory: (portfolioId: string, range = "1y") =>
      request<PerformancePoint[]>(
        "GET",
        `/portfolios/${portfolioId}/history?range=${encodeURIComponent(range)}`,
      ),

    listPortfolios: () => request<Portfolio[]>("GET", "/portfolios"),
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

    listTransactions: (portfolioId: string) =>
      request<Transaction[]>("GET", `/portfolios/${portfolioId}/transactions`),
    createTransaction: (portfolioId: string, input: Omit<TransactionInput, "portfolioId">) =>
      request<Transaction>("POST", `/portfolios/${portfolioId}/transactions`, input),
    updateTransaction: (
      portfolioId: string,
      txId: string,
      input: Omit<TransactionInput, "portfolioId">,
    ) => request<Transaction>("PATCH", `/portfolios/${portfolioId}/transactions/${txId}`, input),
    deleteTransaction: (portfolioId: string, txId: string) =>
      request<void>("DELETE", `/portfolios/${portfolioId}/transactions/${txId}`),
    bulkDeleteTransactions: (portfolioId: string, ids: string[]) =>
      request<{ deleted: number }>("POST", `/portfolios/${portfolioId}/transactions/bulk-delete`, {
        ids,
      }),
    /** Record a fund merger (Fondsverschmelzung) as an atomic sell+buy pair. */
    createMerger: (portfolioId: string, input: Omit<MergerInput, "portfolioId">) =>
      request<Transaction[]>("POST", `/portfolios/${portfolioId}/mergers`, input),

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
    /** Discover instruments from market data (ticker/name search or ISIN). */
    lookupInstruments: (q: string) =>
      request<InstrumentSearchResult[]>("GET", `/instruments/lookup?q=${encodeURIComponent(q)}`),
    getInstrument: (id: string) => request<Instrument>("GET", `/instruments/${id}`),
    getInstrumentHistory: (id: string, range = "1y") =>
      request<Candle[]>("GET", `/instruments/${id}/history?range=${encodeURIComponent(range)}`),
    createInstrument: (input: InstrumentInput) =>
      request<Instrument>("POST", "/instruments", input),
    /** Update an instrument's identifiers (ISIN, WKN, symbol, name, assetClass). */
    updateInstrument: (
      id: string,
      patch: { isin?: string | null; wkn?: string | null; symbol?: string; name?: string; assetClass?: string },
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
      request<Holding[]>("GET", `/portfolios/${portfolioId}/holdings`),
    getSummary: (portfolioId: string, costBasis?: "purchase_price" | "total_paid") =>
      request<PortfolioSummary>(
        "GET",
        costBasis
          ? `/portfolios/${portfolioId}/summary?costBasis=${costBasis}`
          : `/portfolios/${portfolioId}/summary`,
      ),
    getPerformance: (portfolioId: string) =>
      request<PortfolioPerformance>("GET", `/portfolios/${portfolioId}/performance`),

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
    ) => {
      const params = new URLSearchParams({ method });
      if (costBasis) params.set("costBasis", costBasis);
      return request<TradeLog>("GET", `/networth/trades?${params.toString()}`);
    },

    // `force` re-imports a file the server would otherwise dedup against an earlier import
    // (e.g. the user deleted some of those transactions and wants them back). Survivors are
    // re-flagged at confirm time, so this never silently creates true duplicates (#229).
    importCsv: (
      content: string,
      format: "auto" | "generic" | "dkb" | "ibkr" | "coinbase" = "auto",
      force = false,
    ) =>
      request<CsvImportResult>("POST", `/imports/csv${force ? "?force=true" : ""}`, {
        content,
        format,
      }),
    importScreenshot: (file: File | Blob, force = false) => {
      const form = new FormData();
      // name hint for filename preservation; mime comes from the file part itself.
      form.append("file", file, (file as File).name ?? "upload");
      return request<ScreenshotImportResult>(
        "POST",
        `/imports/screenshot${force ? "?force=true" : ""}`,
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
      request<{ confirmed: number; transactions: Transaction[]; likelyDuplicates: number }>(
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
    listImports: () => request<ImportRecord[]>("GET", "/imports"),
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

    // --- Trade Republic ---
    getTrConnection: () => request<TrConnection>("GET", "/tr/connection"),
    connectTr: (input: TrConnectInput) =>
      request<{ status: TrStatus }>("POST", "/tr/connection", input),
    // No code in the v2 push-approval flow: this long-polls until the user approves the
    // login in the TR mobile app (or it is declined / the window expires).
    verifyTr: () => request<{ status: TrStatus }>("POST", "/tr/connection/verify"),
    syncTr: () => request<TrSyncResult>("POST", "/tr/connection/sync"),
    updateTrCategories: (importCategories: TrImportCategory[]) =>
      request<TrConnection>("PATCH", "/tr/connection", { importCategories }),
    reimportTr: () => request<{ removed: number }>("POST", "/tr/connection/reimport"),
    disconnectTr: () => request<void>("DELETE", "/tr/connection"),
  };
}
