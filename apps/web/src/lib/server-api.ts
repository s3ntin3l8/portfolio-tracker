import "server-only";
import { cookies } from "next/headers";
import {
  createApiClient,
  type ApiClient,
  type Portfolio,
  type User,
  type NetWorth,
  type PerformancePoint,
  type Instrument,
  type Candle,
  type CorporateAction,
  type Transaction,
  type HoldingValuation,
  type ImportRecord,
  type ImportDetail,
  type IncomeStats,
  type ContributionStats,
  type TrConnection,
  type AdminProvider,
} from "@portfolio/api-client";
import { auth } from "@/auth";
import { SELECTED_PORTFOLIO_COOKIE } from "@/lib/portfolio-selection";

/** The selected portfolio id, or null when the aggregate ("All portfolios") is active. */
export async function getSelectedPortfolioId(): Promise<string | null> {
  const value = (await cookies()).get(SELECTED_PORTFOLIO_COOKIE)?.value;
  return value && value !== "all" ? value : null;
}

/** API base URL — config-driven so the web app can move to Vercel without a rewrite. */
const apiBaseUrl = process.env.NEXT_PUBLIC_API_URL ?? "";

// Auth is only enforced once configured (mirrors the (app) layout). Without it
// there's no access token and the API can't be reached, so reads report
// "unavailable" rather than crashing the design-system preview.
const authConfigured = Boolean(
  process.env.AUTH_SECRET && process.env.AUTHENTIK_ISSUER,
);

/** A server-bound api-client carrying the current session's access token, or null. */
async function getServerApi(): Promise<ApiClient | null> {
  if (!authConfigured) return null;
  const session = await auth();
  const token = session?.accessToken;
  if (!token) return null;
  return createApiClient({ baseUrl: apiBaseUrl, getToken: () => token });
}

export type NetWorthResult =
  | { status: "ok"; data: NetWorth }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Net worth for the active scope: a single portfolio when one is selected, else the
 * cross-portfolio aggregate ("All portfolios"). Merges `getPerformance` into the
 * per-portfolio result so the returned shape always matches {@link NetWorth} (which
 * adds `xirr`, `portfolioCount`, and `asOf` to `PortfolioSummary`).
 */
export async function loadNetWorth(
  costBasis?: "purchase_price" | "total_paid",
): Promise<NetWorthResult> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) {
      const [summary, perf] = await Promise.all([
        api.getSummary(selected.id, costBasis),
        api.getPerformance(selected.id),
      ]);
      return {
        status: "ok",
        data: { ...summary, xirr: perf.xirr, portfolioCount: 1, asOf: perf.asOf },
      };
    }
    const data = await api.getNetWorth(costBasis);
    if (data.portfolioCount === 0) return { status: "empty" };
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/**
 * Net-worth-over-time for the active scope: a single portfolio's snapshot history
 * when one is selected, else the cross-portfolio aggregate series.
 */
export async function loadNetWorthHistory(
  range = "1y",
): Promise<PerformancePoint[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await api.listPortfolios();
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) return await api.getPortfolioHistory(selected.id, range);
    return await api.getNetWorthHistory(range);
  } catch {
    return [];
  }
}

export interface PortfolioWithValue {
  portfolio: Portfolio;
  netWorth: string;
}

/** Every portfolio with its valued net worth (for the management screen). */
export async function loadPortfolios(): Promise<{
  status: "ok" | "unavailable";
  portfolios: PortfolioWithValue[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [] };
  try {
    const list = await api.listPortfolios();
    const portfolios = await Promise.all(
      list.map(async (portfolio) => ({
        portfolio,
        netWorth: (await api.getSummary(portfolio.id)).netWorth,
      })),
    );
    return { status: "ok", portfolios };
  } catch {
    return { status: "unavailable", portfolios: [] };
  }
}

export interface Selection {
  status: "ok" | "unavailable";
  portfolios: Portfolio[];
  /** null = aggregate across all portfolios ("All portfolios"). */
  selectedId: string | null;
}

/**
 * The user's portfolio list plus the active selection from the `pf` cookie, validated
 * against the live list (an unknown/stale id collapses to the aggregate). Drives the
 * global switcher and every per-portfolio screen.
 */
export async function resolveSelection(): Promise<Selection> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", portfolios: [], selectedId: null };
  try {
    const portfolios = await api.listPortfolios();
    const wanted = await getSelectedPortfolioId();
    const selectedId =
      wanted && portfolios.some((p) => p.id === wanted) ? wanted : null;
    return { status: "ok", portfolios, selectedId };
  } catch {
    return { status: "unavailable", portfolios: [], selectedId: null };
  }
}

export interface TransactionWithPortfolio extends Transaction {
  portfolioName: string;
}

/**
 * Every transaction across all of the user's portfolios, each tagged with its
 * portfolio name (for the aggregate Transactions view). `empty` = no portfolio yet.
 */
export async function loadTransactionsAcrossPortfolios(): Promise<{
  status: "ok" | "empty" | "unavailable";
  transactions: TransactionWithPortfolio[];
}> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", transactions: [] };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty", transactions: [] };
    const nameById = new Map(portfolios.map((p) => [p.id, p.name]));
    const lists = await Promise.all(
      portfolios.map((p) => api.listTransactions(p.id)),
    );
    const transactions = lists.flat().map((t) => ({
      ...t,
      portfolioName: nameById.get(t.portfolioId) ?? "",
    }));
    return { status: "ok", transactions };
  } catch {
    return { status: "unavailable", transactions: [] };
  }
}

export interface HoldingsView {
  status: "ok" | "empty" | "unavailable";
  holdings: HoldingValuation[];
  displayCurrency: string;
}

/**
 * Holdings for the active scope: a single portfolio's `summary` when one is selected,
 * else the cross-portfolio `networth` aggregate ("All portfolios"). Both responses
 * expose the same `holdings` + `displayCurrency`, so the screen renders one way.
 */
export async function loadHoldings(
  costBasis?: "purchase_price" | "total_paid",
): Promise<HoldingsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable", holdings: [], displayCurrency: "IDR" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) {
      return { status: "empty", holdings: [], displayCurrency: "IDR" };
    }
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const data = selected
      ? await api.getSummary(selected.id, costBasis)
      : await api.getNetWorth(costBasis);
    return {
      status: "ok",
      holdings: data.holdings,
      displayCurrency: data.displayCurrency,
    };
  } catch {
    return { status: "unavailable", holdings: [], displayCurrency: "IDR" };
  }
}

export type ContributionsView =
  | { status: "ok"; data: ContributionStats }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Contribution analytics for the active scope: a single portfolio when one is
 * selected, else the cross-portfolio aggregate. Mirrors {@link loadHoldings}.
 */
export async function loadContributions(): Promise<ContributionsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const data = selected
      ? await api.getPortfolioContributions(selected.id)
      : await api.getContributions();
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/** The user's Trade Republic connection state (or null when API unreachable). */
export async function loadTrConnection(): Promise<TrConnection | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getTrConnection();
  } catch {
    return null;
  }
}

export interface InstrumentDetail {
  instrument: Instrument;
  history: Candle[];
  corporateActions: CorporateAction[];
}

/** An instrument with its price history and corporate actions (or null). */
export async function loadInstrument(
  id: string,
): Promise<InstrumentDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    const [instrument, history, corporateActions] = await Promise.all([
      api.getInstrument(id),
      api.getInstrumentHistory(id),
      api.listCorporateActions(id),
    ]);
    return { instrument, history, corporateActions };
  } catch {
    return null;
  }
}

export type IncomeStatsView =
  | { status: "ok"; data: IncomeStats }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Income analytics for the active scope: a single portfolio when one is selected,
 * else the cross-portfolio aggregate. Mirrors {@link loadContributions}.
 */
export async function loadIncomeStats(): Promise<IncomeStatsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const data = selected
      ? await api.getPortfolioIncome(selected.id)
      : await api.getIncome();
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

/** The user's import history (newest first; empty when signed out / unreachable). */
export async function loadImports(): Promise<ImportRecord[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    return await api.listImports();
  } catch {
    return [];
  }
}

/** A single import with its parsed drafts (or null when missing / signed out / down). */
export async function loadImport(importId: string): Promise<ImportDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.getImport(importId);
  } catch {
    return null;
  }
}

/** The authenticated user (or null when signed out / API unreachable). */
export async function loadMe(): Promise<User | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    return await api.me();
  } catch {
    return null;
  }
}

/** Admin: the market-data provider config, or "unavailable" (signed out / non-admin / down). */
export async function loadAdminProviders(): Promise<
  | { status: "ok"; providers: AdminProvider[]; encryptionEnabled: boolean }
  | { status: "unavailable" }
> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const { providers, encryptionEnabled } = await api.getAdminProviders();
    return { status: "ok", providers, encryptionEnabled };
  } catch {
    return { status: "unavailable" };
  }
}

export type PortfolioResult<T> =
  | { status: "ok"; portfolio: Portfolio; data: T }
  | { status: "empty" }
  | { status: "unavailable" };

/**
 * Resolve the user's active portfolio (the one chosen in the global switcher, or the
 * first as a fallback) and run `fn` against it, folding the three states every screen
 * must handle into one result: `unavailable` (not signed in / API down), `empty` (no
 * portfolio yet), or `ok`.
 */
export async function loadPortfolio<T>(
  fn: (api: ApiClient, portfolio: Portfolio) => Promise<T>,
): Promise<PortfolioResult<T>> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await api.listPortfolios();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const portfolio = portfolios.find((p) => p.id === wanted) ?? portfolios[0];
    const data = await fn(api, portfolio);
    return { status: "ok", portfolio, data };
  } catch {
    return { status: "unavailable" };
  }
}
