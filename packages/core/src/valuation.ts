import { Decimal } from "decimal.js";
import { computeHoldings, marketValue } from "./holdings.js";
import { cashBalances, cashFlow } from "./cash.js";
import { netWorth, convert, type FxRateFn } from "./networth.js";
import { financingByInstrument, totalLiabilities } from "./loans.js";
import type { CoreTransaction, CorporateAction, Holding } from "./types.js";

/**
 * How a financed holding's cost basis is reported. "purchase_price" keeps the
 * gold at its G24 price and treats financing as a separate expense;
 * "total_paid" capitalizes the financing (admin + margin − discount) incurred
 * to date into the cost basis. Net worth is invariant to this choice — only
 * cost-basis/P&L attribution moves.
 */
export type CostBasisMode = "purchase_price" | "total_paid";

export interface HoldingValuation extends Holding {
  price: string | null;
  currency: string | null;
  marketValue: string | null;
  unrealizedPnL: string | null;
  /** Market value FX-converted to the display currency (null when unpriced). */
  marketValueDisplay: string | null;
  /** Cost basis FX-converted to the display currency. */
  costBasisDisplay: string;
  /** Unrealized P&L in the display currency (null when unpriced). */
  unrealizedPnLDisplay: string | null;
  /** Prior session's close (instrument currency), when known. */
  previousClose: string | null;
  /** Today's value change for the position (instrument currency), when known. */
  dayChange: string | null;
  /** Today's price move as a percentage, when known. */
  dayChangePct: string | null;
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
  /** Outstanding loan liabilities in the display currency (subtracted from net worth). */
  totalLiabilities: string;
  /** Cash income received — dividends + bond coupons — in the display currency. */
  totalIncome: string;
  /** Sum of per-holding day change, in the display currency. */
  totalDayChange: string;
  /**
   * Wealth denominated in each currency — keyed by the asset's own currency
   * (instrument currency for holdings, balance currency for cash), with each
   * value converted to the display currency for comparable magnitudes.
   */
  exposureByCurrency: Record<string, string>;
}

export interface SummarizeInput {
  transactions: CoreTransaction[];
  corporateActions?: CorporateAction[];
  /** Latest price + currency (+ prior close) keyed by instrument id. */
  prices: Record<
    string,
    { price: string; currency: string; previousClose?: string | null }
  >;
  displayCurrency: string;
  fx?: FxRateFn;
  /** Cost-basis presentation for financed holdings. Defaults to "purchase_price". */
  costBasisMode?: CostBasisMode;
}

/**
 * Full portfolio valuation: per-holding market value + unrealized P&L, cash
 * balances, net worth and totals — all expressed in the display currency.
 * Holdings without a price are returned but excluded from market-value totals.
 */
export function summarizePortfolio(input: SummarizeInput): PortfolioSummary {
  const fx: FxRateFn = input.fx ?? (() => "1");
  const holdings = computeHoldings(input.transactions, input.corporateActions);

  // Total-paid cost basis adds financing incurred to date onto the purchase
  // price; purchase-price mode leaves cost basis untouched.
  const financing =
    input.costBasisMode === "total_paid"
      ? financingByInstrument(input.transactions)
      : {};
  const effectiveCost = (h: Holding): Decimal => {
    const fin = financing[h.instrumentId];
    return fin ? new Decimal(h.costBasis).add(fin) : new Decimal(h.costBasis);
  };

  let totalCost = new Decimal(0);
  let totalMarketValue = new Decimal(0);
  let totalRealized = new Decimal(0);
  let totalDayChange = new Decimal(0);
  const exposure: Record<string, Decimal> = {};
  const addExposure = (ccy: string, amountDisplay: string) => {
    exposure[ccy] = (exposure[ccy] ?? new Decimal(0)).add(amountDisplay);
  };

  const valuations: HoldingValuation[] = holdings.map((h) => {
    const quote = input.prices[h.instrumentId];
    const currency = quote?.currency ?? input.displayCurrency;

    // Effective (mode-dependent) cost basis and the derived average cost.
    const cb = effectiveCost(h);
    const cbStr = cb.toString();
    const qty = new Decimal(h.quantity);
    const avgCost = qty.isZero() ? h.avgCost : cb.div(qty).toString();

    totalRealized = totalRealized.add(
      new Decimal(convert(h.realizedPnL, currency, input.displayCurrency, fx)),
    );

    if (!quote) {
      return {
        ...h,
        costBasis: cbStr,
        avgCost,
        price: null,
        currency: null,
        marketValue: null,
        unrealizedPnL: null,
        // Currency unknown without a quote — keep cost basis as-is (it isn't summed
        // into totalCost either), and leave value/P&L unknown.
        marketValueDisplay: null,
        costBasisDisplay: cbStr,
        unrealizedPnLDisplay: null,
        previousClose: null,
        dayChange: null,
        dayChangePct: null,
      };
    }

    const mv = marketValue(h.quantity, quote.price);
    const unrealized = new Decimal(mv).sub(cb).toString();
    const marketValueDisplay = convert(mv, currency, input.displayCurrency, fx);
    const costBasisDisplay = convert(cbStr, currency, input.displayCurrency, fx);
    const unrealizedPnLDisplay = new Decimal(marketValueDisplay)
      .sub(new Decimal(costBasisDisplay))
      .toString();
    totalCost = totalCost.add(
      new Decimal(convert(cbStr, currency, input.displayCurrency, fx)),
    );
    totalMarketValue = totalMarketValue.add(
      new Decimal(convert(mv, currency, input.displayCurrency, fx)),
    );
    addExposure(currency, convert(mv, currency, input.displayCurrency, fx));

    // Day change needs a non-zero prior close; otherwise it's simply unknown.
    const prev =
      quote.previousClose != null && !new Decimal(quote.previousClose).isZero()
        ? new Decimal(quote.previousClose)
        : null;
    let dayChange: string | null = null;
    let dayChangePct: string | null = null;
    if (prev) {
      const priceDelta = new Decimal(quote.price).sub(prev);
      dayChange = priceDelta.mul(h.quantity).toString();
      dayChangePct = priceDelta.div(prev).mul(100).toString();
      totalDayChange = totalDayChange.add(
        new Decimal(convert(dayChange, currency, input.displayCurrency, fx)),
      );
    }

    return {
      ...h,
      costBasis: cbStr,
      avgCost,
      price: quote.price,
      currency: quote.currency,
      marketValue: mv,
      unrealizedPnL: unrealized,
      marketValueDisplay,
      costBasisDisplay,
      unrealizedPnLDisplay,
      previousClose: quote.previousClose ?? null,
      dayChange,
      dayChangePct,
    };
  });

  const cash = cashBalances(input.transactions);
  for (const [ccy, amount] of Object.entries(cash)) {
    addExposure(ccy, convert(amount, ccy, input.displayCurrency, fx));
  }
  const liabilities = totalLiabilities(
    input.transactions,
    input.displayCurrency,
    fx,
  );
  const nw = netWorth({
    holdings,
    prices: input.prices,
    cash,
    displayCurrency: input.displayCurrency,
    fx,
    liabilities,
  });

  let totalIncome = new Decimal(0);
  for (const tx of input.transactions) {
    if (tx.type === "dividend" || tx.type === "coupon" || tx.type === "interest") {
      totalIncome = totalIncome.add(
        convert(
          cashFlow(tx).toString(),
          tx.currency,
          input.displayCurrency,
          fx,
        ),
      );
    }
  }

  return {
    displayCurrency: input.displayCurrency,
    holdings: valuations,
    cash,
    netWorth: nw,
    totalCost: totalCost.toString(),
    totalMarketValue: totalMarketValue.toString(),
    totalUnrealizedPnL: totalMarketValue.sub(totalCost).toString(),
    totalRealizedPnL: totalRealized.toString(),
    totalLiabilities: liabilities,
    totalIncome: totalIncome.toString(),
    totalDayChange: totalDayChange.toString(),
    exposureByCurrency: Object.fromEntries(
      Object.entries(exposure).map(([k, v]) => [k, v.toString()]),
    ),
  };
}

/**
 * Combine several already-valued portfolio summaries (all expressed in the same
 * display currency) into one: holdings merged by instrument, cash by currency,
 * and totals summed. Net worth across portfolios.
 */
export function aggregatePortfolios(
  summaries: PortfolioSummary[],
  displayCurrency: string,
): PortfolioSummary {
  const holdings = new Map<string, HoldingValuation>();
  const cash: Record<string, string> = {};
  const exposure: Record<string, string> = {};
  let totalCost = new Decimal(0);
  let totalMarketValue = new Decimal(0);
  let totalRealized = new Decimal(0);
  let totalIncome = new Decimal(0);
  let totalDayChange = new Decimal(0);
  let totalLiabilities = new Decimal(0);
  let netWorth = new Decimal(0);

  const addNullable = (a: string | null, b: string | null): string | null => {
    if (a === null) return b;
    if (b === null) return a;
    return new Decimal(a).add(b).toString();
  };

  for (const s of summaries) {
    netWorth = netWorth.add(s.netWorth);
    totalCost = totalCost.add(s.totalCost);
    totalMarketValue = totalMarketValue.add(s.totalMarketValue);
    totalRealized = totalRealized.add(s.totalRealizedPnL);
    totalIncome = totalIncome.add(s.totalIncome);
    totalDayChange = totalDayChange.add(s.totalDayChange);
    totalLiabilities = totalLiabilities.add(s.totalLiabilities);

    for (const [currency, amount] of Object.entries(s.cash)) {
      cash[currency] = new Decimal(cash[currency] ?? "0").add(amount).toString();
    }

    for (const [currency, amount] of Object.entries(s.exposureByCurrency)) {
      exposure[currency] = new Decimal(exposure[currency] ?? "0")
        .add(amount)
        .toString();
    }

    for (const h of s.holdings) {
      const ex = holdings.get(h.instrumentId);
      if (!ex) {
        holdings.set(h.instrumentId, { ...h });
        continue;
      }
      const qty = new Decimal(ex.quantity).add(h.quantity);
      const costBasis = new Decimal(ex.costBasis).add(h.costBasis);
      holdings.set(h.instrumentId, {
        instrumentId: h.instrumentId,
        quantity: qty.toString(),
        avgCost: qty.isZero() ? "0" : costBasis.div(qty).toString(),
        costBasis: costBasis.toString(),
        realizedPnL: new Decimal(ex.realizedPnL).add(h.realizedPnL).toString(),
        price: h.price ?? ex.price,
        currency: h.currency ?? ex.currency,
        marketValue: addNullable(ex.marketValue, h.marketValue),
        unrealizedPnL: addNullable(ex.unrealizedPnL, h.unrealizedPnL),
        // Display fields are all in `displayCurrency`, so summing is valid here
        // (unlike the native marketValue/costBasis above).
        marketValueDisplay: addNullable(ex.marketValueDisplay, h.marketValueDisplay),
        costBasisDisplay: new Decimal(ex.costBasisDisplay)
          .add(h.costBasisDisplay)
          .toString(),
        unrealizedPnLDisplay: addNullable(
          ex.unrealizedPnLDisplay,
          h.unrealizedPnLDisplay,
        ),
        // Same instrument → same per-share price/prev-close, so the percentage is
        // shared; quantities sum, so the absolute day change adds.
        previousClose: h.previousClose ?? ex.previousClose,
        dayChange: addNullable(ex.dayChange, h.dayChange),
        dayChangePct: h.dayChangePct ?? ex.dayChangePct,
      });
    }
  }

  return {
    displayCurrency,
    holdings: [...holdings.values()],
    cash,
    netWorth: netWorth.toString(),
    totalCost: totalCost.toString(),
    totalMarketValue: totalMarketValue.toString(),
    totalUnrealizedPnL: totalMarketValue.sub(totalCost).toString(),
    totalRealizedPnL: totalRealized.toString(),
    totalLiabilities: totalLiabilities.toString(),
    totalIncome: totalIncome.toString(),
    totalDayChange: totalDayChange.toString(),
    exposureByCurrency: exposure,
  };
}
