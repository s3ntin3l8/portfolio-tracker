import { Decimal } from "decimal.js";
import { convert, type FxRateFn } from "./networth.js";
import type { CoreTransaction } from "./types.js";

const D = (v: string | number) => new Decimal(v);

/**
 * Acquisition `kind`s that are NOT the user's own external money and therefore
 * never count as a contribution, even though they buy shares (broker-credited
 * reinvestment). `roundup` is deliberately NOT here — round-ups are the user's
 * own spare change. `reinvestment` is a dividend reinvestment (TR "Reinvestition
 * der Dividende") booked as a `buy` funded by the dividend (return), not external
 * capital — so it's excluded here while still building the average-cost pool.
 * `merger` is the buy leg of a fund merger (Fondsverschmelzung): the new shares
 * replace old ones rather than being newly-funded, so they are not contributed
 * capital (its sell leg is likewise kept out of `outflow` — see {@link outsideMonths}).
 */
const EXCLUDED_ACQUISITION_KINDS = new Set(["saveback", "merger", "reinvestment"]);

export interface ContributionInput {
  txns: CoreTransaction[];
  displayCurrency: string;
  fx?: FxRateFn;
  now?: Date;
  /**
   * Where this portfolio's investment boundary sits (see CLAUDE.md "one boundary
   * per portfolio"). Each boundary counts exactly one side, never both — which is
   * what avoids double-counting the same money.
   * - "inside" (cash counts — Tagesgeld/Festgeld/savings depot): contribution is
   *   net external cash, `deposit − withdrawal` per month. Buys are internal
   *   reallocations of cash already inside the boundary and never count.
   * - "outside" (cash excluded — mixed/checking, invest-only): contribution is net
   *   invested capital — externally-funded acquisitions (`buy`/`savings_plan`, and
   *   `transfer_in` share transfers) at cost, minus sells at average cost. Income
   *   (dividend/coupon/interest) and broker-credited reinvestment (`saveback`,
   *   bonus shares) are return, never contribution.
   */
  boundary?: "inside" | "outside";
}

export interface ContributionStats {
  displayCurrency: string;
  totalContributed: string;
  totalWithdrawn: string;
  netContributed: string;
  /** Count of calendar months from the first contribution month through the current
   * month (inclusive). Used as the denominator for monthlyAverage so idle months
   * dilute the average correctly. */
  monthsElapsed: number;
  /** Count of distinct calendar months that had non-zero net contribution activity.
   * Kept for existing consumers; use monthsElapsed for the per-month average. */
  monthsActive: number;
  /** Net contribution divided by monthsElapsed (all months since first transaction). */
  monthlyAverage: string;
  /** Net contribution per calendar month, ascending by `month` (YYYY-MM). */
  series: { month: string; contributed: string }[];
}

interface MonthAgg {
  inflow: Decimal;
  outflow: Decimal;
}

/** UTC year-month bucket key, e.g. "2026-06". */
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/**
 * Count of inclusive calendar months from `firstKey` ("YYYY-MM") through the
 * month containing `now`. Returns at least 1 so the denominator is never zero.
 * Example: first="2025-08", now=2026-06 → (2026-2025)*12 + (6-8) + 1 = 11 months.
 */
function elapsedMonths(firstKey: string, now: Date): number {
  const [fy, fm] = firstKey.split("-").map(Number);
  const ny = now.getUTCFullYear();
  const nm = now.getUTCMonth() + 1; // 1-based
  return Math.max(1, (ny - fy) * 12 + (nm - fm) + 1);
}

/** Cash amount of a deposit landing inside the boundary (fees reduce what lands). */
function depositInflow(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const amount = D(tx.price).sub(D(tx.fees));
  return D(convert(amount.toString(), tx.currency, display, fx));
}

/** Outflow magnitude of a withdrawal (cash leaving, including fees). */
function withdrawalOutflow(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const amount = D(tx.price).add(D(tx.fees));
  return D(convert(amount.toString(), tx.currency, display, fx));
}

/** Money put into a security by an acquisition: gross notional + fees, in display ccy. */
function acquisitionCost(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const gross = D(tx.quantity).mul(D(tx.price)).abs().add(D(tx.fees));
  return D(convert(gross.toString(), tx.currency, display, fx));
}

/** Whether an acquisition is the user's own external capital (outside boundary). */
function isExternalAcquisition(tx: CoreTransaction): boolean {
  if (tx.kind && EXCLUDED_ACQUISITION_KINDS.has(tx.kind)) return false;
  if (tx.type === "buy" || tx.type === "savings_plan") return true;
  // First-class transfer_in: shares owned elsewhere arrive at carried cost.
  // They represent capital the user already deployed — count as contributed.
  if (tx.type === "transfer_in") return true;
  // `bonus` rows are zero-cash share receipts (corporate actions, reinvested
  // dividends) — only a legacy transfer_in-tagged row is contributed capital.
  if (tx.type === "bonus") return tx.kind === "transfer_in";
  return false;
}

/**
 * Cash amount of a securities transfer landing inside the boundary (at carried cost).
 * Fees reduce the net value (mirror of acquisitionCost but named for clarity here).
 */
function transferInflow(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const gross = D(tx.quantity).abs().mul(D(tx.price)).add(D(tx.fees));
  return D(convert(gross.toString(), tx.currency, display, fx));
}

/** Per-month {inflow, outflow} when cash is INSIDE the boundary: net external cash. */
function insideMonths(
  txns: CoreTransaction[],
  fx: FxRateFn,
  display: string,
): Map<string, MonthAgg> {
  const months = new Map<string, MonthAgg>();
  for (const tx of txns) {
    const key = monthKey(tx.executedAt);
    const m = months.get(key) ?? { inflow: D(0), outflow: D(0) };
    if (tx.type === "deposit") {
      m.inflow = m.inflow.add(depositInflow(tx, fx, display));
    } else if (tx.type === "withdrawal") {
      m.outflow = m.outflow.add(withdrawalOutflow(tx, fx, display));
    } else if (tx.type === "transfer_in") {
      // Inbound transfer: shares arrive at carried cost — that value crosses the boundary
      // as contributed capital (same logic as a deposit for an inside-boundary portfolio).
      m.inflow = m.inflow.add(transferInflow(tx, fx, display));
    } else if (tx.type === "transfer_out") {
      // Outbound transfer: capital leaves the boundary at carried cost basis.
      m.outflow = m.outflow.add(transferInflow(tx, fx, display));
    } else {
      continue;
    }
    months.set(key, m);
  }
  return months;
}

/**
 * Per-month {inflow, outflow} when cash is OUTSIDE the boundary: net invested
 * capital. Inflow = externally-funded acquisitions at cost; outflow = sells at
 * running average cost (so the cumulative net equals the cost basis still
 * deployed, pairing correctly with the securities-only value used downstream).
 * All real acquisitions (incl. broker-credited ones) build the average-cost pool;
 * only externally-funded ones count toward `inflow`.
 */
function outsideMonths(
  txns: CoreTransaction[],
  fx: FxRateFn,
  display: string,
): Map<string, MonthAgg> {
  const sorted = [...txns].sort(
    (a, b) => a.executedAt.getTime() - b.executedAt.getTime(),
  );
  const pool = new Map<string, { qty: Decimal; cost: Decimal }>();
  const months = new Map<string, MonthAgg>();

  for (const tx of sorted) {
    if (!tx.instrumentId) continue;
    const key = monthKey(tx.executedAt);
    const m = months.get(key) ?? { inflow: D(0), outflow: D(0) };

    if (tx.type === "buy" || tx.type === "savings_plan" || tx.type === "bonus" ||
        tx.type === "transfer_in") {
      const cost = acquisitionCost(tx, fx, display);
      const p = pool.get(tx.instrumentId) ?? { qty: D(0), cost: D(0) };
      p.qty = p.qty.add(D(tx.quantity).abs());
      p.cost = p.cost.add(cost);
      pool.set(tx.instrumentId, p);
      if (isExternalAcquisition(tx)) m.inflow = m.inflow.add(cost);
    } else if (tx.type === "transfer_out") {
      // Outbound transfer removes from the avg-cost pool and counts as outflow
      // (capital leaving the boundary), analogous to a sell but with no P&L.
      if (!tx.instrumentId) continue;
      const p = pool.get(tx.instrumentId) ?? { qty: D(0), cost: D(0) };
      const transferQty = Decimal.min(D(tx.quantity).abs(), p.qty);
      const avg = p.qty.gt(0) ? p.cost.div(p.qty) : D(0);
      const costOfTransferred = avg.mul(transferQty);
      p.qty = p.qty.sub(transferQty);
      p.cost = p.cost.sub(costOfTransferred);
      pool.set(tx.instrumentId, p);
      m.outflow = m.outflow.add(D(convert(costOfTransferred.toString(), tx.currency, display, fx)));
    } else if (tx.type === "sell") {
      const p = pool.get(tx.instrumentId) ?? { qty: D(0), cost: D(0) };
      const sellQty = Decimal.min(D(tx.quantity).abs(), p.qty);
      const avg = p.qty.gt(0) ? p.cost.div(p.qty) : D(0);
      const costOfSold = avg.mul(sellQty);
      p.qty = p.qty.sub(sellQty);
      p.cost = p.cost.sub(costOfSold);
      pool.set(tx.instrumentId, p);
      // A merger's sell leg removes the old position but returns no capital — the
      // basis moves into the new instrument's buy leg. Draw the pool, skip outflow.
      if (tx.kind !== "merger") m.outflow = m.outflow.add(costOfSold);
    }
    months.set(key, m);
  }
  return months;
}

/**
 * Derives contribution analytics (total/average money invested, per-month series)
 * from the raw transactions of one portfolio. No state is stored; everything is
 * computed from the source-of-truth transactions. See {@link ContributionInput.boundary}
 * for what counts as a contribution.
 */
export function contributionStats(input: ContributionInput): ContributionStats {
  const fx: FxRateFn = input.fx ?? (() => "1");
  const display = input.displayCurrency;
  const boundary = input.boundary ?? "inside";

  const months =
    boundary === "outside"
      ? outsideMonths(input.txns, fx, display)
      : insideMonths(input.txns, fx, display);

  let totalContributed = D(0);
  let totalWithdrawn = D(0);
  const series: { month: string; contributed: string }[] = [];

  for (const key of [...months.keys()].sort()) {
    const { inflow, outflow } = months.get(key)!;
    const net = inflow.sub(outflow);
    totalContributed = totalContributed.add(inflow);
    totalWithdrawn = totalWithdrawn.add(outflow);
    if (!net.isZero()) series.push({ month: key, contributed: net.toString() });
  }

  const netContributed = totalContributed.sub(totalWithdrawn);
  const monthsActive = series.length;
  // Use elapsed calendar months (first bucket → now) as the denominator so that
  // idle months dilute the average correctly rather than being silently dropped.
  const now = input.now ?? new Date();
  const firstKey = [...months.keys()].sort()[0];
  const monthsElapsed = firstKey ? elapsedMonths(firstKey, now) : 1;
  const monthlyAverage = firstKey
    ? netContributed.div(monthsElapsed).toString()
    : "0";

  return {
    displayCurrency: display,
    totalContributed: totalContributed.toString(),
    totalWithdrawn: totalWithdrawn.toString(),
    netContributed: netContributed.toString(),
    monthsElapsed,
    monthsActive,
    monthlyAverage,
    series,
  };
}

/**
 * Merge several portfolios' {@link ContributionStats} (each already computed in the same
 * display currency, possibly under different boundaries) into one aggregate. Per-month net
 * series are summed by month and the totals re-derived — so each portfolio keeps its own
 * boundary instead of being collapsed into one cross-portfolio bucket.
 */
export function mergeContributionStats(
  stats: ContributionStats[],
  displayCurrency: string,
  now?: Date,
): ContributionStats {
  const byMonth = new Map<string, Decimal>();
  let totalContributed = D(0);
  let totalWithdrawn = D(0);
  for (const s of stats) {
    totalContributed = totalContributed.add(s.totalContributed);
    totalWithdrawn = totalWithdrawn.add(s.totalWithdrawn);
    for (const pt of s.series) {
      byMonth.set(pt.month, (byMonth.get(pt.month) ?? D(0)).add(pt.contributed));
    }
  }
  const series = [...byMonth.keys()]
    .sort()
    .map((month) => ({ month, contributed: byMonth.get(month)!.toString() }))
    .filter((pt) => !D(pt.contributed).isZero());
  const netContributed = totalContributed.sub(totalWithdrawn);
  const monthsActive = series.length;
  // Anchor on the earliest month visible in the merged series (note: each portfolio's
  // series is already filtered to non-zero-net months, so the anchor is approximate —
  // an idle first month can shift it forward slightly, which is acceptable).
  const effectiveNow = now ?? new Date();
  const firstKey = [...byMonth.keys()].sort()[0];
  const monthsElapsed = firstKey ? elapsedMonths(firstKey, effectiveNow) : 1;
  const monthlyAverage = firstKey ? netContributed.div(monthsElapsed).toString() : "0";
  return {
    displayCurrency,
    totalContributed: totalContributed.toString(),
    totalWithdrawn: totalWithdrawn.toString(),
    netContributed: netContributed.toString(),
    monthsElapsed,
    monthsActive,
    monthlyAverage,
    series,
  };
}
