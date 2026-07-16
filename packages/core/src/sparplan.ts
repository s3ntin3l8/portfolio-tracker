import { Decimal } from "decimal.js";
import { isAcquisitionType } from "./categorization.js";
import { convert, type FxRateFn } from "./networth.js";
import { inferIntervalMonths } from "./growth.js";
import { toDateKey } from "./date-utils.js";
import type { CoreTransaction } from "./types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SparplanInput {
  txns: CoreTransaction[];
  displayCurrency: string;
  /** FX conversion function (from → to currency). Defaults to identity (no-op). */
  fx?: FxRateFn;
  /** Inject the current date for deterministic tests. Defaults to `new Date()`. */
  now?: Date;
}

/**
 * A single recurring-amount tier within a plan's history (native execution currency).
 * More than one level means the plan's configured rate increased (or decreased).
 */
export interface AmountLevel {
  /** Median per-execution amount in the plan's native currency. */
  amount: string;
  /** `amount` converted to the display currency for presentation. */
  amountDisplay: string;
  /** Native currency of the executions. */
  currency: string;
  /** YYYY-MM-DD: first execution at this level. */
  since: string;
  /** YYYY-MM-DD: last execution at this level; null when this is the current (latest) level. */
  until: string | null;
  /** Number of monthly executions at this level. */
  executionCount: number;
}

/** A detected recurring investment plan for one instrument. */
export interface DetectedPlan {
  instrumentId: string;
  /** Native execution currency (most executions are in the instrument's quote currency). */
  currency: string;
  /** Most likely cadence in months: 1 (monthly), 3 (quarterly), 6 (semiannual), 12 (annual). */
  cadenceMonths: number;
  /** Most recent level's representative amount, in native currency. */
  currentAmount: string;
  /** `currentAmount` converted to the display currency. */
  currentAmountDisplay: string;
  /** "active" when the last execution was within 1.5× the cadence window; "stopped" otherwise. */
  status: "active" | "stopped";
  /** YYYY-MM-DD: date of the first ever execution. */
  firstExecution: string;
  /** YYYY-MM-DD: date of the most recent execution. */
  lastExecution: string;
  /** Total number of day-collapsed executions. */
  executionCount: number;
  /**
   * "tagged" when the instrument has at least one explicit `savings_plan`-type or
   * `savingsPlanId`-carrying row. "heuristic" when it is inferred from evenly-spaced
   * plain-buy rows.
   */
  source: "tagged" | "heuristic";
  /**
   * Chronological list of amount levels. Length > 1 indicates a step-increase (or
   * decrease) in the configured monthly rate.
   */
  levels: AmountLevel[];
}

export interface SparplanStats {
  displayCurrency: string;
  /** All detected plans, sorted descending by currentAmountDisplay. */
  plans: DetectedPlan[];
  /**
   * Sum of active plans' monthly-equivalent amounts in the display currency.
   * Quarterly plans are divided by 3 so the total is always a "monthly" figure.
   */
  activeMonthlyTotalDisplay: string;
  activePlanCount: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Whole-month count between two UTC dates (b − a, may be negative). */
function monthsBetween(a: Date, b: Date): number {
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** Median of a non-empty array of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Checks whether an array of Dates is roughly evenly spaced (heuristic plan
 * candidate gate). Accepts up to 50% more variance than the median spacing.
 */
function roughlyEven(dates: Date[]): boolean {
  if (dates.length < 3) return false;
  const sorted = [...dates].sort((a, b) => a.getTime() - b.getTime());
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const m = monthsBetween(sorted[i - 1], sorted[i]);
    if (m >= 1 && m <= 14) gaps.push(m);
  }
  if (gaps.length === 0) return false;
  const med = median(gaps);
  const tol = med * 1.5;
  return gaps.every((g) => g <= tol);
}

/** Kinds that are broker-credited (not user money) and must be excluded from detection. */
const EXCLUDED_KINDS = new Set(["saveback", "roundup"]);

/**
 * One collapsed execution: `(instrumentId, UTC calendar day)` sum of `|qty × price|`.
 */
interface Execution {
  date: Date; // start of UTC day
  dateStr: string; // YYYY-MM-DD
  amount: Decimal; // summed native amount
  currency: string;
}

/**
 * Collapse candidate rows for one instrument by UTC calendar day: one execution
 * per day, summing fills (recovers TR's split-fill pattern where a single €50 plan
 * arrives as a −50.00 main fill plus several tiny odd-cent fills).
 */
function collapseByDay(rows: CoreTransaction[]): Execution[] {
  const byDay = new Map<string, Execution>();
  for (const r of rows) {
    const dateStr = toDateKey(r.executedAt);
    const gross = new Decimal(r.quantity).mul(new Decimal(r.price)).abs();
    const existing = byDay.get(dateStr);
    if (existing) {
      existing.amount = existing.amount.add(gross);
    } else {
      const day = new Date(dateStr + "T00:00:00.000Z");
      byDay.set(dateStr, { date: day, dateStr, amount: gross, currency: r.currency });
    }
  }
  return [...byDay.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
}

/**
 * Detect step-increases / decreases in the per-execution amount.
 *
 * Walks executions chronologically. A new level starts when an amount deviates
 * more than `max(ABS_FLOOR, 10 % × median_of_current_level)` from the running
 * median. A lone-execution level sandwiched between two equal-amount levels is
 * folded back in (one-off top-up / rounding artefact).
 *
 * All calculations in the execution's native currency — FX-converting first would
 * manufacture phantom steps from exchange-rate drift.
 */
function bucketLevels(
  executions: Execution[],
  currency: string,
  displayCurrency: string,
  fx: FxRateFn,
): AmountLevel[] {
  // Minimum absolute deviation to open a new level (1 unit of the native currency;
  // avoids hair-trigger splits for e.g. € 74.50 vs € 75.00 rounding artefacts).
  const ABS_FLOOR = 1;
  const REL = 0.1;

  interface LevelBuf {
    members: number[];
    since: string;
    until: string;
  }

  const levels: LevelBuf[] = [];
  let cur: LevelBuf = {
    members: [executions[0].amount.toNumber()],
    since: executions[0].dateStr,
    until: executions[0].dateStr,
  };

  for (let i = 1; i < executions.length; i++) {
    const a = executions[i].amount.toNumber();
    const med = median(cur.members);
    const threshold = Math.max(ABS_FLOOR, REL * med);
    if (Math.abs(a - med) > threshold) {
      levels.push(cur);
      cur = { members: [a], since: executions[i].dateStr, until: executions[i].dateStr };
    } else {
      cur.members.push(a);
      cur.until = executions[i].dateStr;
    }
  }
  levels.push(cur);

  // Fold a lone-execution level sandwiched between two levels with equal amounts
  // (one-off top-up or rounding artefact — not a genuine step change).
  // We merge all three (prev + lone + next) into the previous level.
  for (let i = 1; i < levels.length - 1; i++) {
    if (levels[i].members.length !== 1) continue;
    const prev = median(levels[i - 1].members);
    const next = median(levels[i + 1].members);
    if (Math.abs(prev - next) <= Math.max(ABS_FLOOR, REL * prev)) {
      // Absorb the lone-execution and the trailing equal-level into the previous level.
      levels[i - 1].members.push(...levels[i].members, ...levels[i + 1].members);
      levels[i - 1].until = levels[i + 1].until;
      levels.splice(i, 2); // remove both the lone level and the absorbed next level
      i--; // re-check same index
    }
  }

  return levels.map((l, idx) => {
    const amt = median(l.members).toString();
    return {
      amount: amt,
      amountDisplay: convert(amt, currency, displayCurrency, fx),
      currency,
      since: l.since,
      until: idx < levels.length - 1 ? l.until : null,
      executionCount: l.members.length,
    };
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect recurring savings plans from a portfolio's transactions.
 *
 * Detection works in two tiers:
 *   1. **Tagged** — any instrument with at least one `savings_plan`-type row or a row
 *      carrying a `savingsPlanId`. All tagged rows for that instrument are used.
 *   2. **Heuristic** — instruments with ≥ 3 plain `buy` rows that are roughly evenly
 *      spaced. Instruments with tagged rows are skipped here.
 *
 * Same-day fills for the same instrument are summed before cadence/amount analysis
 * (recovers TR's split-fill pattern).
 *
 * Amounts are detected in the execution's **native currency**; only the representative
 * level amount is converted to `displayCurrency` for display. This prevents phantom
 * step-increases from FX drift.
 */
export function detectSparplans(input: SparplanInput): SparplanStats {
  const { txns, displayCurrency } = input;
  const fx: FxRateFn = input.fx ?? (() => "1");
  const now = input.now ?? new Date();

  // Candidate rows: instrument-buying rows, excluding broker-credited kinds.
  const candidates = txns.filter(
    (t) =>
      t.instrumentId !== null && isAcquisitionType(t.type) && !EXCLUDED_KINDS.has(t.kind ?? ""),
  );

  // Group by instrumentId.
  const byInstrument = new Map<string, CoreTransaction[]>();
  for (const t of candidates) {
    const id = t.instrumentId as string;
    const existing = byInstrument.get(id);
    if (existing) {
      existing.push(t);
    } else {
      byInstrument.set(id, [t]);
    }
  }

  const plans: DetectedPlan[] = [];

  for (const [instrumentId, rows] of byInstrument) {
    const taggedRows = rows.filter(
      (r) => r.type === "savings_plan" || (r.savingsPlanId != null && r.savingsPlanId !== ""),
    );
    const isTagged = taggedRows.length >= 1;
    const execRows = isTagged ? taggedRows : rows.filter((r) => r.type === "buy");

    if (!isTagged) {
      // Heuristic: require ≥ 3 executions and roughly-even spacing.
      if (execRows.length < 3) continue;
      const dates = execRows.map((r) => r.executedAt);
      if (!roughlyEven(dates)) continue;
    }

    // Collapse same-day fills.
    const executions = collapseByDay(execRows);
    if (executions.length === 0) continue;

    // Pick the dominant currency (first execution's currency).
    const currency = executions[0].currency;

    // Cadence: single tagged execution defaults to monthly (1).
    const cadenceMonths =
      executions.length >= 2
        ? inferIntervalMonths(executions.map((e) => e.date))
        : isTagged
          ? 1
          : 12;

    // Level detection (native currency).
    const levels = bucketLevels(executions, currency, displayCurrency, fx);

    const lastLevel = levels[levels.length - 1];
    const lastExecution = executions[executions.length - 1];
    const firstExecution = executions[0];

    // Status: stopped when last execution is more than 1.5× cadence in the past.
    const monthsSinceLast = monthsBetween(lastExecution.date, now);
    const status: "active" | "stopped" =
      monthsSinceLast > cadenceMonths * 1.5 ? "stopped" : "active";

    plans.push({
      instrumentId,
      currency,
      cadenceMonths,
      currentAmount: lastLevel.amount,
      currentAmountDisplay: lastLevel.amountDisplay,
      status,
      firstExecution: firstExecution.dateStr,
      lastExecution: lastExecution.dateStr,
      executionCount: executions.length,
      source: isTagged ? "tagged" : "heuristic",
      levels,
    });
  }

  // Sort descending by display amount.
  plans.sort((a, b) => Number(b.currentAmountDisplay) - Number(a.currentAmountDisplay));

  // Active monthly total: normalize each plan to monthly (÷ cadenceMonths).
  let activeTotalDisplay = new Decimal(0);
  let activePlanCount = 0;
  for (const p of plans) {
    if (p.status === "active") {
      activeTotalDisplay = activeTotalDisplay.add(
        new Decimal(p.currentAmountDisplay).div(p.cadenceMonths),
      );
      activePlanCount++;
    }
  }

  return {
    displayCurrency,
    plans,
    activeMonthlyTotalDisplay: activeTotalDisplay.toDecimalPlaces(2).toString(),
    activePlanCount,
  };
}

/**
 * Merge per-portfolio `SparplanStats` results for the aggregate view.
 *
 * The caller must run `detectSparplans` **per portfolio** and pass the results here.
 * Do NOT concatenate raw transactions into one pass — two portfolios each running
 * €150 on the same instrument would collapse into one €150 plan and under-count.
 *
 * Per-instrument levels are NOT merged across portfolios: each portfolio's level
 * history stays distinct. The list shows each (portfolio, instrument) plan
 * separately; the headline total is always Σ of per-portfolio active totals.
 */
export function mergeSparplanStats(stats: SparplanStats[], displayCurrency: string): SparplanStats {
  const allPlans: DetectedPlan[] = stats.flatMap((s) => s.plans);

  // Headline total = Σ of per-portfolio active monthly totals (always correct regardless
  // of how we reconcile the per-instrument plan list).
  let totalDisplay = new Decimal(0);
  let totalActive = 0;
  for (const s of stats) {
    totalDisplay = totalDisplay.add(new Decimal(s.activeMonthlyTotalDisplay));
    totalActive += s.activePlanCount;
  }

  // Sort descending by current display amount.
  allPlans.sort((a, b) => Number(b.currentAmountDisplay) - Number(a.currentAmountDisplay));

  return {
    displayCurrency,
    plans: allPlans,
    activeMonthlyTotalDisplay: totalDisplay.toDecimalPlaces(2).toString(),
    activePlanCount: totalActive,
  };
}
