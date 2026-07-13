/**
 * Indonesian final-tax helpers — flat, withheld-at-source tax on listed-share sale
 * proceeds and on dividend/coupon gross income.
 *
 * Scope:
 *   - Sales tax: 0.1% of gross sale PROCEEDS (not gain) for every disposal.
 *   - Dividend/coupon tax: 10% of GROSS income (net received + any withholding already
 *     recorded on the transaction — see the design-fidelity note below).
 *   - Both are "final" taxes withheld at source: no annual allowance, no tax-loss
 *     harvesting, no realized-gain-based computation (unlike the German path in
 *     `tax.ts`). Kept as a separate module rather than merged into `tax.ts` since ID
 *     has no allowance/harvest surface at all.
 *
 * Design-fidelity note (intentional, not a bug): dividend/coupon tax here is always
 * `gross × 10%`, ignoring whatever `tax` a broker may have already withheld on the
 * underlying transaction. This matches the flat-estimate model in the design (and the
 * German path's own "estimate only, not tax advice" framing) — it is not meant to be
 * netted against real withholding, so don't "fix" it into a double-count later.
 *
 * All money amounts are Decimal strings (never floats) in, and out.
 */

import { Decimal } from "decimal.js";

const D = (v: string | number) => new Decimal(v);

export const ID_SALES_TAX_RATE = "0.001";
export const ID_DIVIDEND_TAX_RATE = "0.10";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** One FIFO buy-lot consumed by a disposal — carried through for an expandable
 *  per-lot detail view on the disposals table (see `IdDisposalInput.lots`). */
export interface IdDisposalLot {
  acqDate: string; // YYYY-MM-DD
  quantity: string;
  buyPrice: string; // this lot's cost per share
  sellPrice: string; // this lot's proceeds per share
  proceeds: string;
  gain: string; // informational only under ID's proceeds-based final tax
  holdingDays: number;
  longTerm: boolean;
}

export interface IdDisposalInput {
  symbol: string;
  when: string; // YYYY-MM-DD
  proceeds: string;
  /** The underlying instrument's stable id. Optional for backward compatibility (older
   *  callers that don't pass it fall back to `symbol` for row identity in the UI). The
   *  web tier uses it to disambiguate rows that share a displayed `symbol` but are
   *  different instruments — e.g. dual-listed tickers or the `instrumentId.slice(0, 8)`
   *  fallback for unnamed instruments colliding with a real symbol. */
  instrumentId?: string | null;
  /** Aggregate quantity/price fields + the individual consumed lots — all optional,
   *  pure pass-through (not used in the 0.1% tax computation below, which only needs
   *  `proceeds`). Populated by the web tier when a disposal spans multiple FIFO lots
   *  (e.g. an ETF bought in several tranches, sold in one order) so the UI can show an
   *  aggregate "avg buy → sell" row with a collapsible per-lot breakdown. */
  quantity?: string;
  avgBuyPrice?: string;
  sellPrice?: string;
  lots?: IdDisposalLot[];
}

export interface IdDisposalTax extends IdDisposalInput {
  /** proceeds × 0.1%, decimal string. */
  tax: string;
}

export interface IdDividendInput {
  symbol: string;
  currency: string;
  /** Gross amount (net received + any withholding already recorded). */
  gross: string;
}

export interface IdDividendTax extends IdDividendInput {
  /** gross × 10%, decimal string. */
  tax: string;
  /** gross − tax, decimal string. */
  net: string;
}

/**
 * One tax year's totals for the "By year" table. `realized` (gain) is informational
 * only — Indonesian final tax is never levied on gains, only on proceeds/gross — so
 * it's carried through for display but doesn't feed `tax`.
 */
export interface IdYearInput {
  year: number;
  /** Sum of sale proceeds closed in this tax year (all disposals, not just the
   *  currently-selected year — needed so prior years get a real Est. tax figure too). */
  proceeds: string;
  /** Sum of dividend/coupon GROSS income for this tax year. */
  dividendGross: string;
  /** Realized gain for this tax year — informational only, not taxed under ID. */
  realized: string;
}

export interface IdYearTax {
  year: number;
  realized: string;
  dividends: string;
  tax: string;
}

export interface IndonesianFinalTaxInput {
  /** Disposals for the currently-selected tax year. */
  disposals: IdDisposalInput[];
  /** Dividend/coupon rows for the currently-selected tax year. */
  dividends: IdDividendInput[];
  /** Per-year totals across every year the trade log covers (for "By year"). */
  byYear: IdYearInput[];
}

export interface IndonesianFinalTax {
  disposals: IdDisposalTax[];
  totalProceeds: string;
  totalSalesTax: string;
  dividends: IdDividendTax[];
  totalDividendGross: string;
  totalDividendTax: string;
  totalDividendNet: string;
  /** totalSalesTax + totalDividendTax — the hero-card headline figure. */
  estimatedTax: string;
  /** Sorted newest year first. */
  byYear: IdYearTax[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Compute Indonesian final tax for the selected year's disposals/dividends, plus a
 * per-year rollup across every year the trade log covers.
 */
export function indonesianFinalTax(input: IndonesianFinalTaxInput): IndonesianFinalTax {
  const salesRate = D(ID_SALES_TAX_RATE);
  const dividendRate = D(ID_DIVIDEND_TAX_RATE);

  let totalProceeds = new Decimal(0);
  let totalSalesTax = new Decimal(0);
  const disposals: IdDisposalTax[] = input.disposals.map((r) => {
    const proceeds = D(r.proceeds);
    const tax = proceeds.times(salesRate);
    totalProceeds = totalProceeds.plus(proceeds);
    totalSalesTax = totalSalesTax.plus(tax);
    return { ...r, tax: tax.toFixed(2) };
  });

  let totalDividendGross = new Decimal(0);
  let totalDividendTax = new Decimal(0);
  let totalDividendNet = new Decimal(0);
  const dividends: IdDividendTax[] = input.dividends.map((r) => {
    const gross = D(r.gross);
    const tax = gross.times(dividendRate);
    const net = gross.minus(tax);
    totalDividendGross = totalDividendGross.plus(gross);
    totalDividendTax = totalDividendTax.plus(tax);
    totalDividendNet = totalDividendNet.plus(net);
    return { ...r, tax: tax.toFixed(2), net: net.toFixed(2) };
  });

  const estimatedTax = totalSalesTax.plus(totalDividendTax);

  const byYear: IdYearTax[] = [...input.byYear]
    .sort((a, b) => b.year - a.year)
    .map((y) => {
      const proceeds = D(y.proceeds);
      const dividendGross = D(y.dividendGross);
      const tax = proceeds.times(salesRate).plus(dividendGross.times(dividendRate));
      return {
        year: y.year,
        realized: D(y.realized).toFixed(2),
        dividends: dividendGross.toFixed(2),
        tax: tax.toFixed(2),
      };
    });

  return {
    disposals,
    totalProceeds: totalProceeds.toFixed(2),
    totalSalesTax: totalSalesTax.toFixed(2),
    dividends,
    totalDividendGross: totalDividendGross.toFixed(2),
    totalDividendTax: totalDividendTax.toFixed(2),
    totalDividendNet: totalDividendNet.toFixed(2),
    estimatedTax: estimatedTax.toFixed(2),
    byYear,
  };
}
