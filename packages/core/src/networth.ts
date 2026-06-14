import { Decimal } from "decimal.js";
import type { Holding } from "./types.js";

/** Returns the rate to multiply an amount in `from` to express it in `to`. */
export type FxRateFn = (from: string, to: string) => string;

export interface PriceQuote {
  price: string;
  currency: string;
}

export function convert(
  amount: string,
  from: string,
  to: string,
  fx: FxRateFn,
): string {
  if (from === to) return amount;
  return new Decimal(amount).mul(new Decimal(fx(from, to))).toString();
}

export interface NetWorthInput {
  holdings: Holding[];
  prices: Record<string, PriceQuote>;
  cash: Record<string, string>;
  displayCurrency: string;
  fx?: FxRateFn;
}

/**
 * Net worth in the display currency: market value of all holdings (priced and
 * FX-converted) plus uninvested cash. Holdings without a price are skipped.
 */
export function netWorth(input: NetWorthInput): string {
  const fx: FxRateFn = input.fx ?? (() => "1");
  let total = new Decimal(0);

  for (const h of input.holdings) {
    const quote = input.prices[h.instrumentId];
    if (!quote) continue;
    const mv = new Decimal(h.quantity).mul(new Decimal(quote.price)).toString();
    total = total.add(
      new Decimal(convert(mv, quote.currency, input.displayCurrency, fx)),
    );
  }

  for (const [currency, amount] of Object.entries(input.cash)) {
    total = total.add(
      new Decimal(convert(amount, currency, input.displayCurrency, fx)),
    );
  }

  return total.toString();
}
