import type { HistoryPoint } from "@portfolio/api-client";
import {
  getServerApi,
  normalizeCostBasis,
  listPortfoliosCached,
  getSelectedPortfolioId,
  getSummaryCached,
  getPerformanceCached,
  getNetWorthCached,
  resolveHolderScope,
  type NetWorthResult,
} from "./_shared.js";

export async function loadNetWorth(
  costBasis?: "purchase_price" | "total_paid",
  period = "max",
): Promise<NetWorthResult> {
  const api = await getServerApi();
  if (!api) return { status: "unavailable" };
  const resolvedCostBasis = normalizeCostBasis(costBasis);
  try {
    const portfolios = await listPortfoliosCached();
    if (portfolios.length === 0) return { status: "empty" };
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) {
      const [summary, perf] = await Promise.all([
        getSummaryCached(selected.id, resolvedCostBasis),
        getPerformanceCached(selected.id),
      ]);
      return {
        status: "ok",
        data: { ...summary, xirr: perf.xirr, portfolioCount: 1, asOf: perf.asOf, period: "max" },
      };
    }
    const holderId = await resolveHolderScope(portfolios);
    const data = await getNetWorthCached(resolvedCostBasis, holderId, period);
    if (data.portfolioCount === 0) return { status: "empty" };
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}

export async function loadNetWorthHistory(range = "1y"): Promise<HistoryPoint[]> {
  const api = await getServerApi();
  if (!api) return [];
  try {
    const portfolios = await listPortfoliosCached();
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    if (selected) return await api.getPortfolioHistory(selected.id, range);
    const holderId = await resolveHolderScope(portfolios);
    return await api.getNetWorthHistory(range, holderId ? { holderId } : undefined);
  } catch {
    return [];
  }
}
