// Barrel re-exports
export * from "./server-api/account-holders.js";
export * from "./server-api/admin.js";
export * from "./server-api/connections.js";
export * from "./server-api/documents.js";
export * from "./server-api/insights.js";
export * from "./server-api/instruments.js";
export * from "./server-api/networth.js";
export * from "./server-api/portfolios.js";
export * from "./server-api/tax.js";
export * from "./server-api/transactions.js";
export * from "./server-api/user.js";

// Re-export shared types/helpers used directly by consumers
export {
  getSelectedPortfolioId,
  resolveSelection,
  type Scope,
  type Selection,
  type NetWorthResult,
  type PortfolioWithValue,
  type PortfolioResult,
  type HoldingsView,
  type TransactionWithPortfolio,
  type InstrumentDetail,
  type InstrumentScope,
  type InsightsView,
  type TaxDisposalLot,
  type TaxDisposalRow,
  type TaxDividendRow,
  type TaxCurrencyTotal,
  type TaxYearRow,
  type TaxYearDetail,
  loadHoldings,
} from "./server-api/_shared.js";

// Remaining functions not extracted into domain modules
import type {
  Anomaly,
  PerformancePoint,
  ContributionStats,
  SparplanStats,
  TradeLog,
  TradeMethod,
  IncomeStats,
} from "@portfolio/api-client";
import {
  getServerApi,
  listPortfoliosCached,
  getSelectedPortfolioId,
  resolveHolderScope,
} from "./server-api/_shared.js";

export async function loadAnomalies(portfolioOverride?: string): Promise<Anomaly[] | null> {
  const api = await getServerApi();
  if (!api) return null;
  const portfolioId = portfolioOverride ?? (await getSelectedPortfolioId());
  if (!portfolioId) return null;
  try {
    const { anomalies } = await api.getAnomalies(portfolioId);
    return anomalies;
  } catch {
    return null;
  }
}

export type ContributionsView =
  | { status: "ok"; data: ContributionStats; valueHistory: PerformancePoint[] }
  | { status: "empty" }
  | { status: "unavailable" };

export async function loadContributions(): Promise<ContributionsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioContributions(selected.id)
      : await api.getContributions(holderId);
    let valueHistory: PerformancePoint[] = [];
    try {
      valueHistory = (
        selected
          ? await api.getPortfolioHistory(selected.id, "all")
          : await api.getNetWorthHistory("all", holderId ? { holderId } : undefined)
      ) as PerformancePoint[];
    } catch {
      // History unavailable — chart degrades gracefully.
    }
    return { status: "ok", data, valueHistory };
  } catch {
    return { status: "unavailable" };
  }
}

export type SparplanView =
  | { status: "ok"; data: SparplanStats; portfolioId: string | null }
  | { status: "empty" }
  | { status: "unavailable" };

export async function loadSparplan(): Promise<SparplanView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioSparplan(selected.id)
      : await api.getSparplan(holderId);
    return { status: "ok", data, portfolioId: selected?.id ?? null };
  } catch {
    return { status: "unavailable" };
  }
}

export type TradeLogView =
  { status: "ok"; data: TradeLog } | { status: "empty" } | { status: "unavailable" };

export async function loadTrades(
  method: TradeMethod = "average",
  costBasis?: "purchase_price" | "total_paid",
): Promise<TradeLogView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getTrades(selected.id, method, costBasis)
      : await api.getNetWorthTrades(method, costBasis, holderId);
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

export type IncomeStatsView =
  { status: "ok"; data: IncomeStats } | { status: "empty" } | { status: "unavailable" };

export async function loadIncomeStats(): Promise<IncomeStatsView> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = selected
      ? await api.getPortfolioIncome(selected.id)
      : await api.getIncome(holderId);
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}
