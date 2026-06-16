import type {
  PortfolioInput,
  TransactionInput,
  InstrumentInput,
  CorporateActionInput,
  ParsedTransaction,
  UserUpdate,
} from "@portfolio/schema";

// --- Response shapes (mirror the API) ------------------------------------

export interface User {
  id: string;
  authSub: string;
  email: string;
  name: string | null;
  displayCurrency: string;
}

export interface Portfolio {
  id: string;
  userId: string;
  name: string;
  baseCurrency: string;
  /** "standard" | "child". Child portfolios expose the birth year + age-18 target. */
  portfolioType: "standard" | "child";
  /** Beneficiary birth year (e.g. a child's account), or null. */
  birthYear: number | null;
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
  source: string;
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
}

export interface HoldingValuation extends Holding {
  price: string | null;
  currency: string | null;
  marketValue: string | null;
  unrealizedPnL: string | null;
  previousClose: string | null;
  dayChange: string | null;
  dayChangePct: string | null;
  instrument: InstrumentMeta | null;
}

export interface PortfolioSummary {
  displayCurrency: string;
  holdings: HoldingValuation[];
  cash: Record<string, string>;
  netWorth: string;
  totalCost: string;
  totalMarketValue: string;
  totalUnrealizedPnL: string;
  totalRealizedPnL: string;
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
  netWorth: string;
  totalCost: string;
  totalMarketValue: string;
  totalUnrealizedPnL: string;
  totalRealizedPnL: string;
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

/** A projected future coupon payment for a held bond (instrument currency). */
export interface ProjectedCoupon {
  instrumentId: string;
  symbol: string;
  name: string | null;
  date: string; // YYYY-MM-DD
  amount: string;
  currency: string;
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
  lifetimeTotal: string;
  byInstrument: InstrumentIncome[];
  byAssetClass: AssetClassIncome[];
  byCurrency: CurrencyIncome[];
  paymentCount: number;
  averagePerPayment: string;
  yields: InstrumentYield[];
  upcoming: ProjectedCoupon[];
  events: IncomeEvent[];
}

/** Contribution analytics + forecast seed for a savings/Sparplan account. */
export interface ContributionStats {
  displayCurrency: string;
  totalContributed: string;
  totalWithdrawn: string;
  netContributed: string;
  monthsActive: number;
  monthlyAverage: string;
  /** Net contribution per calendar month, ascending by `month` (YYYY-MM). */
  series: { month: string; contributed: string }[];
  currentValue: string;
  /** (currentValue − netContributed) / netContributed, or null when no basis. */
  simpleGainPct: number | null;
  xirr: number | null;
  /** Default annual return to seed the forecast (xirr clamped, else "0.07"). */
  seedAnnualReturn: string;
  /** Beneficiary birth year for the "to age 18" target (single portfolio only). */
  birthYear: number | null;
  /** "standard" | "child"; gates the "to age 18" forecast target. */
  portfolioType: "standard" | "child";
  asOf: string;
}

export interface CsvImportResult {
  importId: string;
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
}

export interface ScreenshotImportResult {
  importId: string;
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
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

export type TrStatus =
  | "disconnected"
  // Push sent — awaiting the user's approval in the Trade Republic mobile app.
  | "awaiting_2fa"
  | "connected"
  | "expired"
  | "error";

/** Public state of the user's Trade Republic connection — never includes secrets. */
export interface TrConnection {
  status: TrStatus;
  portfolioId: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
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

export interface ApiClientConfig {
  baseUrl: string;
  getToken?: () => string | undefined | Promise<string | undefined>;
  /** Override fetch (tests / non-browser runtimes). Defaults to global fetch. */
  fetch?: typeof fetch;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export function createApiClient(config: ApiClientConfig) {
  const doFetch = config.fetch ?? globalThis.fetch;

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = await config.getToken?.();
    // Only declare a JSON content-type when we actually send a body. A bodyless
    // request (e.g. DELETE) that still advertises application/json trips Fastify's
    // FST_ERR_CTP_EMPTY_JSON_BODY → 400 before the route handler runs.
    const hasBody = body !== undefined;
    const res = await doFetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        ...(hasBody ? { "content-type": "application/json" } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: hasBody ? JSON.stringify(body) : undefined,
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

    getNetWorth: () => request<NetWorth>("GET", "/networth"),
    getIncome: () => request<IncomeStats>("GET", "/networth/income"),
    getPortfolioIncome: (portfolioId: string) =>
      request<IncomeStats>("GET", `/portfolios/${portfolioId}/income`),
    getContributions: () =>
      request<ContributionStats>("GET", "/networth/contributions"),
    getPortfolioContributions: (portfolioId: string) =>
      request<ContributionStats>(
        "GET",
        `/portfolios/${portfolioId}/contributions`,
      ),
    getNetWorthHistory: (range = "1y") =>
      request<NetWorthPoint[]>(
        "GET",
        `/networth/history?range=${encodeURIComponent(range)}`,
      ),
    getPortfolioHistory: (portfolioId: string, range = "1y") =>
      request<NetWorthPoint[]>(
        "GET",
        `/portfolios/${portfolioId}/history?range=${encodeURIComponent(range)}`,
      ),

    listPortfolios: () => request<Portfolio[]>("GET", "/portfolios"),
    createPortfolio: (input: PortfolioInput) =>
      request<Portfolio>("POST", "/portfolios", input),
    updatePortfolio: (portfolioId: string, input: Partial<PortfolioInput>) =>
      request<Portfolio>("PATCH", `/portfolios/${portfolioId}`, input),
    deletePortfolio: (portfolioId: string) =>
      request<void>("DELETE", `/portfolios/${portfolioId}`),

    listTransactions: (portfolioId: string) =>
      request<Transaction[]>("GET", `/portfolios/${portfolioId}/transactions`),
    createTransaction: (
      portfolioId: string,
      input: Omit<TransactionInput, "portfolioId">,
    ) =>
      request<Transaction>(
        "POST",
        `/portfolios/${portfolioId}/transactions`,
        input,
      ),
    updateTransaction: (
      portfolioId: string,
      txId: string,
      input: Omit<TransactionInput, "portfolioId">,
    ) =>
      request<Transaction>(
        "PATCH",
        `/portfolios/${portfolioId}/transactions/${txId}`,
        input,
      ),
    deleteTransaction: (portfolioId: string, txId: string) =>
      request<void>(
        "DELETE",
        `/portfolios/${portfolioId}/transactions/${txId}`,
      ),
    bulkDeleteTransactions: (portfolioId: string, ids: string[]) =>
      request<{ deleted: number }>(
        "POST",
        `/portfolios/${portfolioId}/transactions/bulk-delete`,
        { ids },
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
      request<Instrument[]>(
        "GET",
        `/instruments${q ? `?q=${encodeURIComponent(q)}` : ""}`,
      ),
    /** Discover instruments from market data (ticker/name search or ISIN). */
    lookupInstruments: (q: string) =>
      request<InstrumentSearchResult[]>(
        "GET",
        `/instruments/lookup?q=${encodeURIComponent(q)}`,
      ),
    getInstrument: (id: string) =>
      request<Instrument>("GET", `/instruments/${id}`),
    getInstrumentHistory: (id: string, range = "1y") =>
      request<Candle[]>(
        "GET",
        `/instruments/${id}/history?range=${encodeURIComponent(range)}`,
      ),
    createInstrument: (input: InstrumentInput) =>
      request<Instrument>("POST", "/instruments", input),

    createCorporateAction: (input: CorporateActionInput) =>
      request<CorporateAction>("POST", "/corporate-actions", input),
    updateCorporateAction: (id: string, input: Partial<CorporateActionInput>) =>
      request<CorporateAction>("PATCH", `/corporate-actions/${id}`, input),
    deleteCorporateAction: (id: string) =>
      request<void>("DELETE", `/corporate-actions/${id}`),
    listCorporateActions: (instrumentId: string) =>
      request<CorporateAction[]>(
        "GET",
        `/instruments/${instrumentId}/corporate-actions`,
      ),

    getHoldings: (portfolioId: string) =>
      request<Holding[]>("GET", `/portfolios/${portfolioId}/holdings`),
    getSummary: (portfolioId: string) =>
      request<PortfolioSummary>("GET", `/portfolios/${portfolioId}/summary`),
    getPerformance: (portfolioId: string) =>
      request<PortfolioPerformance>(
        "GET",
        `/portfolios/${portfolioId}/performance`,
      ),

    importCsv: (
      portfolioId: string,
      content: string,
      format: "auto" | "generic" | "dkb" | "ibkr" | "coinbase" = "auto",
    ) =>
      request<CsvImportResult>(
        "POST",
        `/portfolios/${portfolioId}/imports/csv`,
        { content, format },
      ),
    importScreenshot: (
      portfolioId: string,
      image: string,
      mimeType = "image/png",
    ) =>
      request<ScreenshotImportResult>(
        "POST",
        `/portfolios/${portfolioId}/imports/screenshot`,
        { image, mimeType },
      ),
    confirmImport: (importId: string, transactions: ParsedTransaction[]) =>
      request<{ confirmed: number; transactions: Transaction[] }>(
        "POST",
        `/imports/${importId}/confirm`,
        { transactions },
      ),
    listImports: () => request<ImportRecord[]>("GET", "/imports"),
    /** Discard a draft import (draft → discarded). */
    discardImport: (importId: string) =>
      request<void>("POST", `/imports/${importId}/discard`),
    /** Undo an import: remove any transactions it wrote, then mark it discarded. */
    deleteImport: (importId: string) =>
      request<{ removed: number }>("DELETE", `/imports/${importId}`),

    // --- Trade Republic ---
    getTrConnection: () => request<TrConnection>("GET", "/tr/connection"),
    connectTr: (input: TrConnectInput) =>
      request<{ status: TrStatus }>("POST", "/tr/connection", input),
    // No code in the v2 push-approval flow: this long-polls until the user approves the
    // login in the TR mobile app (or it is declined / the window expires).
    verifyTr: () => request<{ status: TrStatus }>("POST", "/tr/connection/verify"),
    syncTr: () => request<TrSyncResult>("POST", "/tr/connection/sync"),
    disconnectTr: () => request<void>("DELETE", "/tr/connection"),
  };
}
