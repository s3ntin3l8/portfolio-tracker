import "server-only";
import { cache } from "react";
import { cookies } from "next/headers";
import { createApiClient } from "@portfolio/api-client";
import type {
  ApiClient,
  Portfolio,
  AccountHolder,
  User,
  NetWorth,
  PortfolioSummary,
  PortfolioPerformance,
  Transaction,
  HoldingValuation,
  Instrument,
  Candle,
  CorporateAction,
  InsightsResponse,
} from "@portfolio/api-client";
import type { IdYearInput } from "@portfolio/core";
import {
  SELECTED_PORTFOLIO_COOKIE,
  HOLDER_SCOPE_PREFIX,
  qualifyingHolders,
} from "@/lib/portfolio-selection";
import { toApiRange, type InstrumentPriceRange } from "@/lib/instrument-price-range";
import { accessTokenFromCookieHeader } from "@/lib/session-token";

export type Scope =
  | { kind: "all" }
  | { kind: "portfolio"; portfolioId: string }
  | { kind: "holder"; holderId: string };

async function getRawScope(): Promise<Scope> {
  const value = (await cookies()).get(SELECTED_PORTFOLIO_COOKIE)?.value;
  if (!value || value === "all") return { kind: "all" };
  if (value.startsWith(HOLDER_SCOPE_PREFIX)) {
    return { kind: "holder", holderId: value.slice(HOLDER_SCOPE_PREFIX.length) };
  }
  return { kind: "portfolio", portfolioId: value };
}

export async function getSelectedPortfolioId(): Promise<string | null> {
  const scope = await getRawScope();
  return scope.kind === "portfolio" ? scope.portfolioId : null;
}

const apiBaseUrl = process.env.API_URL ?? "";
const authConfigured = Boolean(process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER);

const getServerApi = cache(async (): Promise<ApiClient | null> => {
  if (!authConfigured) return null;
  const cookieHeader = (await cookies())
    .getAll()
    .map((c) => `${c.name}=${c.value}`)
    .join("; ");
  const token = await accessTokenFromCookieHeader(cookieHeader);
  if (!token) return null;
  return createApiClient({ baseUrl: apiBaseUrl, getToken: () => token });
});

function normalizeCostBasis(
  costBasis?: "purchase_price" | "total_paid",
): "purchase_price" | "total_paid" {
  return costBasis ?? "purchase_price";
}

const listPortfoliosCached = cache(async (): Promise<Portfolio[]> => {
  const api = await getServerApi();
  if (!api) return [];
  return api.listPortfolios();
});

const listAccountHoldersCached = cache(async (): Promise<AccountHolder[]> => {
  const api = await getServerApi();
  if (!api) return [];
  return api.listAccountHolders();
});

const meCached = cache(async (): Promise<User | null> => {
  const api = await getServerApi();
  if (!api) return null;
  return api.me();
});

const getSummaryCached = cache(
  async (
    portfolioId: string,
    costBasis: "purchase_price" | "total_paid",
  ): Promise<PortfolioSummary> => {
    const api = await getServerApi();
    if (!api) throw new Error("api unavailable");
    return api.getSummary(portfolioId, costBasis);
  },
);

const getPerformanceCached = cache(async (portfolioId: string): Promise<PortfolioPerformance> => {
  const api = await getServerApi();
  if (!api) throw new Error("api unavailable");
  return api.getPerformance(portfolioId);
});

const getNetWorthCached = cache(
  async (
    costBasis: "purchase_price" | "total_paid",
    holderId: string | undefined,
    period: string,
  ): Promise<NetWorth> => {
    const api = await getServerApi();
    if (!api) throw new Error("api unavailable");
    return api.getNetWorth(costBasis, holderId, period);
  },
);

export type NetWorthResult =
  { status: "ok"; data: NetWorth } | { status: "empty" } | { status: "unavailable" };

export interface PortfolioWithValue {
  portfolio: Portfolio;
  netWorth: string;
}

export interface Selection {
  status: "ok" | "unavailable";
  portfolios: Portfolio[];
  selectedId: string | null;
  selectedHolderId: string | null;
}

export async function resolveSelection(): Promise<Selection> {
  const api = await getServerApi();
  if (!api)
    return { status: "unavailable", portfolios: [], selectedId: null, selectedHolderId: null };
  try {
    const [portfolios, holders] = await Promise.all([
      listPortfoliosCached(),
      listAccountHoldersCached(),
    ]);
    const rawScope = await getRawScope();

    if (rawScope.kind === "portfolio") {
      const selectedId = portfolios.some((p) => p.id === rawScope.portfolioId)
        ? rawScope.portfolioId
        : null;
      return { status: "ok", portfolios, selectedId, selectedHolderId: null };
    }

    if (rawScope.kind === "holder") {
      const qualifying = qualifyingHolders(portfolios, holders);
      const selectedHolderId = qualifying.some((h) => h.id === rawScope.holderId)
        ? rawScope.holderId
        : null;
      return { status: "ok", portfolios, selectedId: null, selectedHolderId };
    }

    return { status: "ok", portfolios, selectedId: null, selectedHolderId: null };
  } catch {
    return { status: "unavailable", portfolios: [], selectedId: null, selectedHolderId: null };
  }
}

export async function resolveHolderScope(
  portfolios: { accountHolderId?: string | null }[],
): Promise<string | undefined> {
  const raw = await getRawScope();
  if (raw.kind !== "holder") return undefined;
  const { holderId } = raw;
  const count = portfolios.filter((p) => p.accountHolderId === holderId).length;
  return count >= 2 ? holderId : undefined;
}

export interface TransactionWithPortfolio extends Transaction {
  portfolioName: string;
}

export interface HoldingsView {
  status: "ok" | "empty" | "unavailable";
  holdings: HoldingValuation[];
  displayCurrency: string;
  cash: Record<string, string>;
  cashTracked: boolean;
}

export type PortfolioResult<T> =
  { status: "ok"; portfolio: Portfolio; data: T } | { status: "empty" } | { status: "unavailable" };

const ID_ALL_PORTFOLIOS_ID = "__id_all_portfolios__";

export interface TaxDisposalLot {
  acqDate: string;
  quantity: string;
  buyPrice: string;
  sellPrice: string;
  proceeds: string;
  gain: string;
  holdingDays: number;
  longTerm: boolean;
}

export interface TaxDisposalRow {
  symbol: string;
  when: string;
  instrumentId?: string | null;
  proceeds: string;
  gain: string;
  tfRate: string;
  gainAdjusted: string;
  quantity: string;
  avgBuyPrice: string;
  sellPrice: string;
  lots: TaxDisposalLot[];
}

export interface TaxDividendRow {
  symbol: string;
  currency: string;
  gross: string;
  tax: string;
  net: string;
}

export interface TaxCurrencyTotal {
  currency: string;
  gross: string;
  tax: string;
  net: string;
}

export interface TaxYearRow {
  year: number;
  realized: string;
  dividends: string;
  tax: string;
  fsaUsed: string;
}

export interface TaxYearDetail {
  currency: string;
  disposals: TaxDisposalRow[];
  totalProceeds: string;
  totalGain: string;
  dividendRows: TaxDividendRow[];
  dividendTotalsByCurrency: TaxCurrencyTotal[];
  byYear: TaxYearRow[];
  idByYear: IdYearInput[];
}

export interface InsightsView {
  status: "ok";
  data: InsightsResponse;
}

export interface InstrumentDetail {
  instrument: Instrument;
  history: Candle[];
  corporateActions: CorporateAction[];
}

export interface InstrumentScope {
  holding: HoldingValuation | null;
  aggregate: boolean;
  displayCurrency: string;
  totalMarketValueDisplay: number | null;
}

export async function loadHoldings(
  costBasis?: "purchase_price" | "total_paid",
  portfolioOverride?: string,
): Promise<HoldingsView> {
  const api = await getServerApi();
  if (!api)
    return {
      status: "unavailable",
      holdings: [],
      displayCurrency: "IDR",
      cash: {},
      cashTracked: false,
    };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) {
      return {
        status: "empty",
        holdings: [],
        displayCurrency: "IDR",
        cash: {},
        cashTracked: false,
      };
    }
    const overrideId =
      portfolioOverride && portfolios.some((p) => p.id === portfolioOverride)
        ? portfolioOverride
        : null;
    const wanted = overrideId ?? (await getSelectedPortfolioId());
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const resolvedCostBasis = normalizeCostBasis(costBasis);
    const data = selected
      ? await getSummaryCached(selected.id, resolvedCostBasis)
      : await getNetWorthCached(resolvedCostBasis, holderId, "max");
    return {
      status: "ok",
      holdings: data.holdings,
      displayCurrency: data.displayCurrency,
      cash: data.cash,
      cashTracked: data.cashTracked,
    };
  } catch {
    return {
      status: "unavailable",
      holdings: [],
      displayCurrency: "IDR",
      cash: {},
      cashTracked: false,
    };
  }
}

export {
  getServerApi,
  normalizeCostBasis,
  listPortfoliosCached,
  listAccountHoldersCached,
  meCached,
  getSummaryCached,
  getPerformanceCached,
  getNetWorthCached,
  getRawScope,
  ID_ALL_PORTFOLIOS_ID,
  toApiRange,
};
export type { InstrumentPriceRange };
