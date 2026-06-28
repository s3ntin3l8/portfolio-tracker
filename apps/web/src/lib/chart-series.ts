import type { PerformancePoint } from "@portfolio/api-client";

/**
 * A single point in the merged contributions-vs-value overlay series.
 * `contributed` is the cumulative cash crossing the portfolio boundary up to
 * this date; `value` is the mark-to-market portfolio value on this date.
 */
export interface ContributionValuePoint {
  date: string;
  contributed: number;
  value: number;
}

/**
 * Merge a daily net-contribution series with a daily portfolio-value history
 * into a single daily series suitable for the overlay chart.
 *
 * Algorithm:
 * - Prefix-sum the per-day net deltas (keyed by "YYYY-MM-DD") into cumulative
 *   entries, ascending.
 * - For each day in `valueHistory`, forward-fill the cumulative contribution as
 *   of that exact date — so the contributed step lands on the actual transaction
 *   day rather than the first day of its month.
 *
 * Returns an empty array when `valueHistory` has fewer than 2 points so callers
 * can fall back to the degraded single-series path.
 */
export function mergeContributionValue(
  series: { date: string; contributed: string }[],
  valueHistory: PerformancePoint[],
): ContributionValuePoint[] {
  if (valueHistory.length < 2) return [];

  // Prefix-sum into [date, cumulative] entries, ascending. Same-date entries (already
  // aggregated upstream) still resolve to the final running total via the ≤ scan below.
  const entries: [string, number][] = [];
  let running = 0;
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  for (const s of sorted) {
    running += Number(s.contributed);
    entries.push([s.date, running]);
  }

  /**
   * Return the cumulative contribution as of a given date by forward-filling the
   * last entry with date ≤ the target, or 0 before the first entry.
   */
  function cumulativeAt(date: string): number {
    let last = 0;
    for (const [d, v] of entries) {
      if (d <= date) last = v;
      else break;
    }
    return last;
  }

  return valueHistory.map((p) => ({
    date: p.date,
    contributed: cumulativeAt(p.date),
    value: Number(p.netWorth),
  }));
}
