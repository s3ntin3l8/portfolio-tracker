/**
 * Time-weighted return (TWR) calculation for portfolio performance charts.
 *
 * TWR formula per day t:
 *   1 + r_t = (V_t − effectiveFlow_t) / V_{t-1}
 *   Index_t = Index_{t-1} · (1 + r_t)   base 100; pct = index/base − 1
 *
 * V = holdings MARKET VALUE only (not net worth — robust to unrecorded cash).
 * effectiveFlow_t = buysCost − sellsProceeds − income(realSeries only)
 *   = -Σ cashFlow(tx) for buy/savings_plan/sell + income(realSeries) on day t
 *
 * Split-adjustment: store RAW closes in prices; adjust at read time:
 *   adjustedClose(d) = rawClose(d) / splitAdjustmentFactor(cas, id, d)
 * where the factor is the product of ratios for CAs with exDate > d.
 */
import { Decimal } from "decimal.js";
import { computeHoldings, marketValue } from "./holdings.js";
import { cashFlow } from "./cash.js";
import { convert, type FxRateFn } from "./networth.js";
import type { CoreTransaction, CorporateAction } from "./types.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

/** Classification of an instrument's price series for income-netting decisions. */
export type PriceSeriesKind =
  /** Real exchange-listed series: price drops on ex-date → net income OUT. */
  | "realSeries"
  /** Flat proxy (bond par / NAV carried-back flat): income NOT netted — would manufacture fake gain. */
  | "flatProxy"
  /** No price (instrument-less interest): excluded from V and flows. */
  | "none";

/** Per-date holdings market value and effective capital flow, in `baseCurrency`. */
export interface DailyValueFlow {
  date: string; // YYYY-MM-DD
  /** Sum of priced holdings market value in baseCurrency. */
  marketValue: string;
  /**
   * Effective capital flow = buysCost − sellsProceeds − income(realSeries only).
   * Equals -Σ cashFlow(tx) for buy/savings_plan/sell/realSeries-income txns on this day.
   * FX-converted to baseCurrency at the day's rate.
   */
  effectiveFlow: string;
}

/** A single point on the chained TWR index series. */
export interface IndexPoint {
  date: string; // YYYY-MM-DD
  /** Chained total-return index, base 100. */
  index: string;
  /** (index/100 − 1) × 100: percentage return since inception. */
  pct: string;
}

/**
 * Split-adjustment factor for a price on a given date.
 *
 * adjustedClose(d) = rawClose(d) / splitAdjustmentFactor(cas, id, d)
 *
 * Product of ratios for CAs with exDate STRICTLY AFTER d.
 * ratioOf(split) = ratio; ratioOf(bonus) = 1 + ratio; rights = no-op.
 */
export function splitAdjustmentFactor(
  cas: CorporateAction[],
  instrumentId: string,
  date: string,
): Decimal {
  let factor = D(1);
  for (const ca of cas) {
    if (ca.instrumentId !== instrumentId) continue;
    const caDate =
      ca.exDate instanceof Date ? ca.exDate.toISOString().slice(0, 10) : String(ca.exDate);
    if (caDate > date) {
      if (ca.type === "split") {
        factor = factor.mul(D(ca.ratio));
      } else if (ca.type === "bonus") {
        factor = factor.mul(D(1).add(D(ca.ratio)));
      }
      // rights: no price adjustment
    }
  }
  return factor;
}

function toDateStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export interface BuildDailyValueFlowsInput {
  transactions: CoreTransaction[];
  corporateActions: CorporateAction[];
  /** YYYY-MM-DD strings, sorted ascending. */
  dates: string[];
  /**
   * Returns the split-adjusted close and its native currency for an instrument on a date.
   * Return null if the instrument has no price on that date (excluded from MV).
   */
  priceAt: (instrumentId: string, date: string) => { close: string; currency: string } | null;
  /** Returns an FxRateFn for converting any currency to baseCurrency on the given date. */
  fxAt: (date: string) => FxRateFn;
  baseCurrency: string;
  /** Returns the price-series classification for the instrument. */
  kindOf: (instrumentId: string) => PriceSeriesKind;
  /**
   * Maps a transaction to the date (YYYY-MM-DD) its flow should be attributed to.
   * Defaults to tx.executedAt (YYYY-MM-DD). Override to map dividend/coupon txns
   * to their ex-date for accurate income-netting.
   */
  flowDateOf?: (tx: CoreTransaction) => string;
}

/**
 * Build the per-day (marketValue, effectiveFlow) series for a portfolio.
 * Pure — no DB access. The caller injects split-adjusted prices and FX rates.
 */
export function buildDailyValueFlows(input: BuildDailyValueFlowsInput): DailyValueFlow[] {
  const {
    transactions,
    corporateActions,
    dates,
    priceAt,
    fxAt,
    baseCurrency,
    kindOf,
    flowDateOf = (tx) => toDateStr(tx.executedAt),
  } = input;

  // Pre-build a date → transactions map using the (possibly remapped) flow date.
  const flowsByDate = new Map<string, CoreTransaction[]>();
  for (const tx of transactions) {
    const d = flowDateOf(tx);
    const list = flowsByDate.get(d) ?? [];
    list.push(tx);
    flowsByDate.set(d, list);
  }

  const result: DailyValueFlow[] = [];

  for (const date of dates) {
    const fx = fxAt(date);
    // Holdings at end of this date. CAs always applied; txns filtered to ≤ date.
    const asOf = new Date(`${date}T23:59:59.999Z`);
    const holdings = computeHoldings(transactions, corporateActions, asOf);

    // Market value: Σ qty × adjustedClose × FX, skipping unpriced instruments.
    let mv = ZERO;
    for (const h of holdings) {
      if (D(h.quantity).isZero()) continue;
      const p = priceAt(h.instrumentId, date);
      if (p === null) continue;
      const holdingMv = marketValue(h.quantity, p.close);
      mv = mv.add(D(convert(holdingMv, p.currency, baseCurrency, fx)));
    }

    // Effective flow: -Σ cashFlow(tx) for qualifying txns whose flow lands on this date.
    let flow = ZERO;
    const dayTxns = flowsByDate.get(date) ?? [];
    for (const tx of dayTxns) {
      const { type } = tx;
      if (type === "buy" || type === "savings_plan" || type === "sell") {
        // effectiveFlow -= cashFlow(tx)
        // buy: cashFlow < 0 → -cashFlow > 0 (cost added to flow)
        // sell: cashFlow > 0 → -cashFlow < 0 (proceeds subtracted from flow)
        const cf = cashFlow(tx);
        flow = flow.sub(D(convert(cf.toString(), tx.currency, baseCurrency, fx)));
      } else if ((type === "dividend" || type === "coupon") && tx.instrumentId) {
        // Only net income for realSeries — flatProxy price doesn't drop on ex-date.
        if (kindOf(tx.instrumentId) === "realSeries") {
          const cf = cashFlow(tx);
          flow = flow.sub(D(convert(cf.toString(), tx.currency, baseCurrency, fx)));
        }
      }
      // deposit/withdrawal/fee/interest/loan_*/split/bonus/rights:
      // don't affect holdings MV → no effectiveFlow contribution.
    }

    result.push({
      date,
      marketValue: mv.toString(),
      effectiveFlow: flow.toString(),
    });
  }

  return result;
}

const BASE = 100;

/**
 * Chain the TWR index from a (marketValue, effectiveFlow) series.
 * V_{t-1} = 0: r_t = 0, index carries forward (no reset).
 *
 * Guard: r_t ≤ −1 (a ≥100% single-day loss) is carried forward instead of applied.
 * A held, long-only position cannot legitimately lose 100%+ of its value in one day —
 * this only happens when a snapshot's marketValue was recorded as ~0 with no offsetting
 * flow (a stale/missing price for a still-held instrument, a data artifact upstream in
 * snapshot generation, not a real return). Applying it would multiply the index by ≤0,
 * permanently zeroing (or flipping the sign of) every subsequent point — one bad day
 * would otherwise read as a portfolio-wide -100% drawdown forever after.
 */
export function chainIndex(series: DailyValueFlow[], base = BASE): IndexPoint[] {
  const result: IndexPoint[] = [];
  let index = D(base);
  let prevMv: Decimal | null = null;

  for (const point of series) {
    const mv = D(point.marketValue);
    const flow = D(point.effectiveFlow);

    if (prevMv !== null && !prevMv.isZero()) {
      // r_t = (V_t − flow_t) / V_{t-1} − 1
      const rt = mv.sub(flow).div(prevMv).sub(1);
      const growth = D(1).add(rt);
      if (growth.gt(0)) {
        index = index.mul(growth);
      }
      // growth ≤ 0: impossible single-day return — data artifact, carry index forward.
    }
    // prevMv === null: first point, index stays at base.
    // prevMv.isZero(): reset-proof carry-forward (index unchanged).

    const pct = index.div(base).sub(1).mul(100);
    result.push({ date: point.date, index: index.toString(), pct: pct.toString() });
    prevMv = mv;
  }
  return result;
}

/**
 * Sum per-portfolio (marketValue, effectiveFlow) series across portfolios per date,
 * then sort by date. Use this before `chainIndex` for the aggregate view — you cannot
 * average per-portfolio indices.
 */
export function aggregateValueFlows(perPortfolio: DailyValueFlow[][]): DailyValueFlow[] {
  const byDate = new Map<string, { mv: Decimal; flow: Decimal }>();
  for (const series of perPortfolio) {
    for (const point of series) {
      const ex = byDate.get(point.date) ?? { mv: ZERO, flow: ZERO };
      byDate.set(point.date, {
        mv: ex.mv.add(D(point.marketValue)),
        flow: ex.flow.add(D(point.effectiveFlow)),
      });
    }
  }
  return [...byDate.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([date, { mv, flow }]) => ({
      date,
      marketValue: mv.toString(),
      effectiveFlow: flow.toString(),
    }));
}

/** Alias: chain-index the summed aggregate flows. Same as chainIndex. */
export const chainAggregateIndex = chainIndex;
