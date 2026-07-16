import {
  getServerApi,
  listPortfoliosCached,
  getSelectedPortfolioId,
  resolveHolderScope,
  type InsightsView,
} from "./_shared.js";

export async function loadInsights(
  range = "all",
): Promise<InsightsView | { status: "empty" | "unavailable" }> {
  try {
    const api = await getServerApi();
    if (!api) return { status: "unavailable" };
    const portfolios = await listPortfoliosCached();
    const wanted = await getSelectedPortfolioId();
    const selected = portfolios.find((p) => p.id === wanted);
    const holderId = selected ? undefined : await resolveHolderScope(portfolios);
    const data = await api.getInsights(range, { holderId, portfolioId: selected?.id });
    return { status: "ok", data };
  } catch {
    return { status: "unavailable" };
  }
}
