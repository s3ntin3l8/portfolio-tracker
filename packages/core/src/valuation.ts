import { Decimal } from "decimal.js";
import { computeHoldings, marketValue } from "./holdings.js";
import { cashBalances, cashFlow } from "./cash.js";
import { netWorth, convert, type FxRateFn } from "./networth.js";
import type { CoreTransaction, CorporateAction, Holding } from "./types.js";

export interface HoldingValuation extends Holding {
  price: string | null;
  currency: string | null;
  marketValue: string | null;
  unrealizedPnL: string | null;
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
  /** Cash income received — dividends + bond coupons — in the display currency. */
  totalIncome: string;
  /** Sum of per-holding day change, in the display currency. */
  totalDayChange: string;
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
}

/**
 * Full portfolio valuation: per-holding market value + unrealized P&L, cash
 * balances, net worth and totals — all expressed in the display currency.
 * Holdings without a price are returned but excluded from market-value totals.
 */
export function summarizePortfolio(input: SummarizeInput): PortfolioSummary {
  const fx: FxRateFn = input.fx ?? (() => "1");
  const holdings = computeHoldings(input.transactions, input.corporateActions);

  let totalCost = new Decimal(0);
  let totalMarketValue = new Decimal(0);
  let totalRealized = new Decimal(0);
  let totalDayChange = new Decimal(0);

  const valuations: HoldingValuation[] = holdings.map((h) => {
    const quote = input.prices[h.instrumentId];
    const currency = quote?.currency ?? input.displayCurrency;

    totalRealized = totalRealized.add(
      new Decimal(convert(h.realizedPnL, currency, input.displayCurrency, fx)),
    );

    if (!quote) {
      return {
        ...h,
        price: null,
        currency: null,
        marketValue: null,
        unrealizedPnL: null,
        previousClose: null,
        dayChange: null,
        dayChangePct: null,
      };
    }

    const mv = marketValue(h.quantity, quote.price);
    const unrealized = new Decimal(mv).sub(new Decimal(h.costBasis)).toString();
    totalCost = totalCost.add(
      new Decimal(convert(h.costBasis, currency, input.displayCurrency, fx)),
    );
    totalMarketValue = totalMarketValue.add(
      new Decimal(convert(mv, currency, input.displayCurrency, fx)),
    );

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
      price: quote.price,
      currency: quote.currency,
      marketValue: mv,
      unrealizedPnL: unrealized,
      previousClose: quote.previousClose ?? null,
      dayChange,
      dayChangePct,
    };
  });

  const cash = cashBalances(input.transactions);
  const nw = netWorth({
    holdings,
    prices: input.prices,
    cash,
    displayCurrency: input.displayCurrency,
    fx,
  });

  let totalIncome = new Decimal(0);
  for (const tx of input.transactions) {
    if (tx.type === "dividend" || tx.type === "coupon") {
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
    totalIncome: totalIncome.toString(),
    totalDayChange: totalDayChange.toString(),
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
  let totalCost = new Decimal(0);
  let totalMarketValue = new Decimal(0);
  let totalRealized = new Decimal(0);
  let totalIncome = new Decimal(0);
  let totalDayChange = new Decimal(0);
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

    for (const [currency, amount] of Object.entries(s.cash)) {
      cash[currency] = new Decimal(cash[currency] ?? "0").add(amount).toString();
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
    totalIncome: totalIncome.toString(),
    totalDayChange: totalDayChange.toString(),
  };
}
