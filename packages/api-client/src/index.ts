import type {
  PortfolioInput,
  TransactionInput,
  ParsedTransaction,
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

    listPortfolios: () => request<Portfolio[]>("GET", "/portfolios"),
    createPortfolio: (input: PortfolioInput) =>
      request<Portfolio>("POST", "/portfolios", input),

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

    getHoldings: (portfolioId: string) =>
      request<Holding[]>("GET", `/portfolios/${portfolioId}/holdings`),
    getSummary: (portfolioId: string) =>
      request<PortfolioSummary>("GET", `/portfolios/${portfolioId}/summary`),

    importCsv: (portfolioId: string, content: string) =>
      request<CsvImportResult>(
        "POST",
        `/portfolios/${portfolioId}/imports/csv`,
        { content },
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
