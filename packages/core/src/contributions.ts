import { Decimal } from "decimal.js";
import { convert, type FxRateFn } from "./networth.js";
import type { CoreTransaction, TransactionType } from "./types.js";

const D = (v: string | number) => new Decimal(v);

export interface ContributionInput {
  txns: CoreTransaction[];
  displayCurrency: string;
  fx?: FxRateFn;
  now?: Date;
  /**
   * How to interpret which transactions are external contributions:
   * - "auto" (default): per-month dedup — when a month has any `deposit`, that
   *   month's contribution is the net of its deposits/withdrawals (the buys that
   *   month are internal reallocations of that cash); otherwise the month's
   *   contribution is the `savings_plan` notional, net of withdrawals. This
   *   avoids double-counting the same money when both styles are recorded.
   * - "purchases": every `buy` and `savings_plan` notional counts as a contribution
   *   and deposits are ignored. For invest-only accounts whose funding cash leg isn't
   *   imported (e.g. a DKB depot-snapshot, all synthetic `buy` rows) — there, "auto"
   *   would count nothing. Don't use it when deposits ARE imported: the purchases they
   *   fund would then be double-counted.
   */
  mode?: "auto" | "purchases";
}

export interface ContributionStats {
  displayCurrency: string;
  totalContributed: string;
  totalWithdrawn: string;
  netContributed: string;
  monthsActive: number;
  monthlyAverage: string;
  /** Net contribution per calendar month, ascending by `month` (YYYY-MM). */
  series: { month: string; contributed: string }[];
}

/** UTC year-month bucket key, e.g. "2026-06". */
function monthKey(d: Date): string {
  return d.toISOString().slice(0, 7);
}

/** Gross external inflow magnitude of a single contributing transaction. */
function inflowMagnitude(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const fees = D(tx.fees);
  let amount: Decimal;
  if (tx.type === "deposit") {
    // A deposit records the cash amount in `price`; fees reduce what lands.
    amount = D(tx.price).sub(fees);
  } else {
    // savings_plan / buy: the money put in is the gross notional plus fees.
    amount = D(tx.quantity).mul(D(tx.price)).abs().add(fees);
  }
  return D(convert(amount.toString(), tx.currency, display, fx));
}

/** Outflow magnitude of a withdrawal (cash leaving, including fees). */
function outflowMagnitude(tx: CoreTransaction, fx: FxRateFn, display: string): Decimal {
  const amount = D(tx.price).add(D(tx.fees));
  return D(convert(amount.toString(), tx.currency, display, fx));
}

const DEPOSIT_TYPES: TransactionType[] = ["deposit"];
const PLAN_TYPES: TransactionType[] = ["savings_plan"];
const WITHDRAWAL_TYPES: TransactionType[] = ["withdrawal"];

/**
 * Derives contribution analytics (total/average money saved, per-month series)
 * from the raw transactions of one or more portfolios. No state is stored;
 * everything is computed from the source-of-truth transactions.
 *
 * Contributions are the *external* money the user put in — for a child's ETF
 * Sparplan this is the recurring `savings_plan` buy, or a cash `deposit` when
 * the account is funded separately. See `mode` for the dedup rule.
 */
export function contributionStats(input: ContributionInput): ContributionStats {
  const fx: FxRateFn = input.fx ?? (() => "1");
  const display = input.displayCurrency;
  const mode = input.mode ?? "auto";
  // "purchases" mode treats every securities purchase as a contribution and ignores
  // deposits (no dedup); "auto" prefers deposits per month, falling back to plan buys.
  const planTypes: TransactionType[] = mode === "purchases" ? ["savings_plan", "buy"] : PLAN_TYPES;

  // Group by month, tracking deposits/plan-inflows/withdrawals separately so we
  // can prefer deposits over plan buys within any month that has both.
  const buckets = new Map<
    string,
    { deposit: Decimal; plan: Decimal; withdrawal: Decimal; hasDeposit: boolean }
  >();

  for (const tx of input.txns) {
    const key = monthKey(tx.executedAt);
    const b =
      buckets.get(key) ??
      { deposit: D(0), plan: D(0), withdrawal: D(0), hasDeposit: false };

    if (mode === "auto" && DEPOSIT_TYPES.includes(tx.type)) {
      b.deposit = b.deposit.add(inflowMagnitude(tx, fx, display));
      b.hasDeposit = true;
    } else if (planTypes.includes(tx.type)) {
      b.plan = b.plan.add(inflowMagnitude(tx, fx, display));
    } else if (WITHDRAWAL_TYPES.includes(tx.type)) {
      b.withdrawal = b.withdrawal.add(outflowMagnitude(tx, fx, display));
    }
    buckets.set(key, b);
  }

  let totalContributed = D(0);
  let totalWithdrawn = D(0);
  const series: { month: string; contributed: string }[] = [];

  for (const key of [...buckets.keys()].sort()) {
    const b = buckets.get(key)!;
    const inflow = b.hasDeposit ? b.deposit : b.plan;
    const net = inflow.sub(b.withdrawal);
    totalContributed = totalContributed.add(inflow);
    totalWithdrawn = totalWithdrawn.add(b.withdrawal);
    if (!net.isZero()) series.push({ month: key, contributed: net.toString() });
  }

  const netContributed = totalContributed.sub(totalWithdrawn);
  const monthsActive = series.length;
  const monthlyAverage = monthsActive
    ? netContributed.div(monthsActive).toString()
    : "0";

  return {
    displayCurrency: display,
    totalContributed: totalContributed.toString(),
    totalWithdrawn: totalWithdrawn.toString(),
    netContributed: netContributed.toString(),
    monthsActive,
    monthlyAverage,
    series,
  };
}

/**
 * Merge several portfolios' {@link ContributionStats} (each already computed in the same
 * display currency, possibly under different modes) into one aggregate. Per-month net
 * series are summed by month and the totals re-derived — so each portfolio keeps its own
 * deposit-vs-plan dedup instead of being collapsed into one cross-portfolio bucket.
 */
export function mergeContributionStats(
  stats: ContributionStats[],
  displayCurrency: string,
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
  const monthlyAverage = monthsActive ? netContributed.div(monthsActive).toString() : "0";
  return {
    displayCurrency,
    totalContributed: totalContributed.toString(),
    totalWithdrawn: totalWithdrawn.toString(),
    netContributed: netContributed.toString(),
    monthsActive,
    monthlyAverage,
    series,
  };
}
