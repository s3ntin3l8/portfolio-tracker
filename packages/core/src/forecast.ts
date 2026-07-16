import { Decimal } from "decimal.js";

export interface ForecastInput {
  /** Current account value (decimal string). */
  presentValue: string;
  /** Fixed amount added each month (decimal string). */
  monthlyContribution: string;
  /** Expected annual return as a decimal, e.g. "0.07" for 7%. */
  annualReturnRate: string;
  /** Number of months to project. */
  horizonMonths: number;
}

export interface ForecastPoint {
  /** Months from today; index 0 is the present. */
  monthIndex: number;
  /** Cumulative contributions added so far (excludes the present value). */
  contributed: string;
  /** Projected total balance at this month. */
  value: string;
}

/**
 * Projects an account's value forward, compounding the balance monthly at
 * `annualReturnRate / 12` and adding a fixed contribution at the end of each
 * month. Returns one point per month including the present (index 0), so the
 * series length is `horizonMonths + 1`.
 *
 * Pure (Decimal.js) so it runs identically server-side and in the browser for
 * instant what-if recomputation.
 */
export function forecastSeries(input: ForecastInput): ForecastPoint[] {
  const monthlyRate = new Decimal(input.annualReturnRate).div(12);
  const growth = monthlyRate.add(1);
  const contribution = new Decimal(input.monthlyContribution);
  const horizon = Math.max(0, Math.floor(input.horizonMonths));

  let value = new Decimal(input.presentValue);
  let contributed = new Decimal(0);
  const points: ForecastPoint[] = [{ monthIndex: 0, contributed: "0", value: value.toString() }];

  for (let i = 1; i <= horizon; i++) {
    value = value.mul(growth).add(contribution);
    contributed = contributed.add(contribution);
    points.push({
      monthIndex: i,
      contributed: contributed.toString(),
      value: value.toString(),
    });
  }

  return points;
}

/** Terminal projected value after `horizonMonths` (the last forecast point). */
export function forecastValue(input: ForecastInput): string {
  const series = forecastSeries(input);
  return series[series.length - 1].value;
}
