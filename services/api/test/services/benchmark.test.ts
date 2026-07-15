import { describe, it, expect } from "vitest";
import { computeActiveReturn } from "../../src/services/benchmark.js";

// `pct` values are chained-index percentages — i.e. already ×100 (chainIndex's `pct`
// is `index/base - 1, ×100`, so +12.5% total return shows up as pct "12.5", not
// "0.125"). computeActiveReturn must divide its own outputs back down to fractions,
// since every other rate the API returns (and the web card's formatPercent, an Intl
// percent formatter that itself multiplies by 100) is expressed as a fraction.
describe("computeActiveReturn", () => {
  it("returns activeReturn and trackingError as fractions, not percentage points", () => {
    const portfolioIndex = [
      { date: "2026-01-01", pct: "0" },
      { date: "2026-01-02", pct: "5" }, // +5%
      { date: "2026-01-03", pct: "10" }, // +10%
    ];
    const benchmarkIndex = [
      { date: "2026-01-01", pct: "0" },
      { date: "2026-01-02", pct: "20" }, // +20%
      { date: "2026-01-03", pct: "30" }, // +30%
    ];

    const result = computeActiveReturn(portfolioIndex, benchmarkIndex);
    expect(result).not.toBeNull();
    // Portfolio +10% vs benchmark +30% at the end of the series → -20 percentage
    // points of active return, expressed as the fraction -0.2 (not -20, and
    // certainly not the pre-fix -2000% once run through a ×100 percent formatter).
    expect(Number(result!.activeReturn)).toBeCloseTo(-0.2, 6);
    // Daily active-return diffs are [-15, -5] (percentage points): stddev √50,
    // annualized ×√252, then divided by 100 to land as a fraction like every other
    // rate the API returns — not the ×100-too-large percentage-point figure the
    // pre-fix card would have re-scaled a second time.
    const expectedTrackingError = (Math.sqrt(50) * Math.sqrt(252)) / 100;
    expect(Number(result!.trackingError)).toBeCloseTo(expectedTrackingError, 6);
  });

  it("leaves correlation unscaled (dimensionless, scale-invariant)", () => {
    // Portfolio moves in perfect lockstep with the benchmark → correlation should be
    // (numerically) 1, unaffected by the pct units on either series.
    const portfolioIndex = [
      { date: "2026-01-01", pct: "0" },
      { date: "2026-01-02", pct: "2" },
      { date: "2026-01-03", pct: "5" },
      { date: "2026-01-04", pct: "4" },
    ];
    const benchmarkIndex = portfolioIndex.map((p) => ({ date: p.date, pct: String(Number(p.pct) * 2) }));

    const result = computeActiveReturn(portfolioIndex, benchmarkIndex);
    expect(result).not.toBeNull();
    expect(Number(result!.correlation)).toBeCloseTo(1, 6);
  });

  it("rebases to the first common date when the two series' own bases differ", () => {
    // The portfolio's first snapshot (2026-01-03, a Saturday) predates the earliest
    // benchmark trading day (2026-01-05) — a realistic gap: daily portfolio snapshots
    // cover every calendar day, but equity benchmarks only trade on weekdays. Each
    // series is still chained from its OWN first element (portfolioIndex bases at
    // 01-03, benchmarkIndex bases at 01-05, its own earliest point) — exactly what the
    // route hands in. Without rebasing to the first COMMON date (01-05), comparing
    // pfFinal (relative to 01-03) against bmFinal (relative to 01-05) would be
    // apples-to-oranges.
    const portfolioIndex = [
      { date: "2026-01-03", pct: "0" }, // portfolio's own base
      { date: "2026-01-04", pct: "1" },
      { date: "2026-01-05", pct: "5" }, // first date benchmark data also exists for
      { date: "2026-01-06", pct: "6" },
      { date: "2026-01-07", pct: "8" },
    ];
    const benchmarkIndex = [
      { date: "2026-01-05", pct: "0" }, // benchmark's own base (first trading day)
      { date: "2026-01-06", pct: "1" },
      { date: "2026-01-07", pct: "3" },
    ];

    const result = computeActiveReturn(portfolioIndex, benchmarkIndex);
    expect(result).not.toBeNull();

    // Rebased to 2026-01-05: portfolio index there is 105 (pct 5 relative to its own
    // base), rising to 108 by 01-06 → true return over the common window is
    // 108/105 - 1 ≈ 2.857%. Benchmark's own return over the same window is already a
    // correct 3% (its base already sits at 01-05). Active return is the small,
    // correct difference — not "8 - 3 = 5" (0.05 as a fraction), which is what the
    // pre-fix, unrebased subtraction of each series' raw final pct would have given.
    const expectedActiveReturn = (108 / 105 - 1) - 0.03;
    expect(Number(result!.activeReturn)).toBeCloseTo(expectedActiveReturn, 6);
    expect(Number(result!.activeReturn)).not.toBeCloseTo(0.05, 3);
  });

  it("returns null when fewer than 2 overlapping dates exist", () => {
    const portfolioIndex = [{ date: "2026-01-01", pct: "0" }];
    const benchmarkIndex = [{ date: "2026-01-01", pct: "0" }];
    expect(computeActiveReturn(portfolioIndex, benchmarkIndex)).toBeNull();
    expect(computeActiveReturn([], [])).toBeNull();
  });
});
