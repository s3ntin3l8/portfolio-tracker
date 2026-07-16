import {
  getServerApi,
  getSelectedPortfolioId,
  loadHoldings,
  toApiRange,
  type InstrumentPriceRange,
  type InstrumentDetail,
  type InstrumentScope,
  type TransactionWithPortfolio,
} from "./_shared.js";
import { loadTransactionsAcrossPortfolios } from "./transactions.js";
import { loadPortfolio } from "./portfolios.js";

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
  let transactions: TransactionWithPortfolio[] = [];
  if (aggregate) {
    const result = await loadTransactionsAcrossPortfolios();
    if (result.status === "ok") {
      transactions = result.transactions.filter((t) => t.instrumentId === instrumentId);
    }
  } else {
    const result = await loadPortfolio((api, portfolio) =>
      api.listTransactions(portfolio.id, holdingsView.displayCurrency),
    );
    if (result.status === "ok") {
      transactions = result.data
        .filter((t) => t.instrumentId === instrumentId)
        .map((t) => ({ ...t, portfolioName: result.portfolio.name }));
    }
  }

  const totalMarketValueDisplay =
    holdingsView.status === "ok"
      ? holdingsView.holdings.reduce(
          (sum, h) => sum + (h.marketValueDisplay ? Number(h.marketValueDisplay) : 0),
          0,
        )
      : null;

  return {
    holding,
    transactions,
    aggregate,
    displayCurrency: holdingsView.displayCurrency,
    totalMarketValueDisplay,
  };
}
