import {
  getServerApi,
  getSelectedPortfolioId,
  loadHoldings,
  toApiRange,
  type InstrumentPriceRange,
  type InstrumentDetail,
  type InstrumentScope,
} from "./_shared";

export async function loadInstrument(
  id: string,
  range: InstrumentPriceRange = "1y",
): Promise<InstrumentDetail | null> {
  const api = await getServerApi();
  if (!api) return null;
  try {
    const [instrument, history, corporateActions] = await Promise.all([
      api.getInstrument(id),
      api.getInstrumentHistory(id, toApiRange(range)),
      api.listCorporateActions(id),
    ]);
    return { instrument, history, corporateActions };
  } catch {
    return null;
  }
}

export async function loadInstrumentScope(
  instrumentId: string,
  costBasis?: "purchase_price" | "total_paid",
): Promise<InstrumentScope> {
  const holdingsView = await loadHoldings(costBasis);
  const holding =
    holdingsView.status === "ok"
      ? (holdingsView.holdings.find((h) => h.instrumentId === instrumentId) ?? null)
      : null;

  const aggregate = (await getSelectedPortfolioId()) === null;

  const totalMarketValueDisplay =
    holdingsView.status === "ok"
      ? holdingsView.holdings.reduce(
          (sum, h) => sum + (h.marketValueDisplay ? Number(h.marketValueDisplay) : 0),
          0,
        )
      : null;

  return {
    holding,
    aggregate,
    displayCurrency: holdingsView.displayCurrency,
    totalMarketValueDisplay,
  };
}
