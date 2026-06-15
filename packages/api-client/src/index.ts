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
  xirr: number | null;
  portfolioCount: number;
  asOf: string;
}

/** A point on a net-worth-over-time series (display/base currency). */
export interface NetWorthPoint {
  date: string; // YYYY-MM-DD
  netWorth: string;
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
    const res = await doFetch(`${config.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
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
      format: "auto" | "generic" | "dkb" = "auto",
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
  };
}
