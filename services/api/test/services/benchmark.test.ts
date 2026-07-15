import { describe, it, expect } from "vitest";
import { computeActiveReturn, getUserBenchmarkConfig } from "../../src/services/benchmark.js";
import { buildApp } from "../../src/app.js";
import { users, userPreferences, benchmarkPrices } from "@portfolio/db";

const TEST_KEY = new TextEncoder().encode("test-key");

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
    // Tracking error uses the TRUE daily return between consecutive index levels
    // (1+cum_i/100)/(1+cum_{i-1}/100) - 1, not a naive difference of the cumulative
    // pcts (that would inflate as the index grows — see the "cumulative-vs-daily"
    // regression test below). Day 2 (base→day2): pf 5%, bm 20% → diff = -15pp (base
    // is 0, so this coincides with the naive difference). Day 3 (day2→day3): pf
    // (1.10/1.05-1)=1/21, bm (1.30/1.20-1)=1/12 → diff = (1/21 - 1/12)×100 = -25/7 pp
    // ≈ -3.5714pp — NOT -5pp, which the old (buggy) diff-of-cumulative math produced.
    const diffs = [-15, -25 / 7];
    const mean = diffs.reduce((a, b) => a + b, 0) / diffs.length;
    const variance = diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (diffs.length - 1);
    const expectedTrackingError = (Math.sqrt(variance) * Math.sqrt(252)) / 100;
    expect(Number(result!.trackingError)).toBeCloseTo(expectedTrackingError, 6);
  });

  it("leaves correlation unscaled (dimensionless, scale-invariant)", () => {
    // Portfolio moves in perfect lockstep with the benchmark — the benchmark's
    // period-over-period RETURN is exactly 2× the portfolio's every period (not just
    // its cumulative pct doubled, which under compounding would NOT correspond to
    // exactly double the daily return). Build both cumulative pct series by
    // compounding r1=2%, r2=3%, r3=-1% for the portfolio and 2×r for the benchmark,
    // so computeActiveReturn's true daily-return recovery is exact and correlation
    // comes out to (numerically) 1.
    const compound = (rets: number[]) => {
      let index = 100;
      const pts: number[] = [0];
      for (const r of rets) {
        index *= 1 + r;
        pts.push((index / 100 - 1) * 100);
      }
      return pts;
    };
    const pfRets = [0.02, 0.03, -0.01];
    const bmRets = pfRets.map((r) => r * 2);
    const dates = ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"];
    const portfolioIndex = compound(pfRets).map((pct, i) => ({ date: dates[i], pct: String(pct) }));
    const benchmarkIndex = compound(bmRets).map((pct, i) => ({ date: dates[i], pct: String(pct) }));

    const result = computeActiveReturn(portfolioIndex, benchmarkIndex);
    expect(result).not.toBeNull();
    expect(Number(result!.correlation)).toBeCloseTo(1, 6);
  });

  it("computes tracking error from true daily returns, not a diff of cumulative pcts", () => {
    // Regression for the "cumulative-vs-daily" bug: naively subtracting consecutive
    // cumulative pct values (rather than deriving the true compounded daily return)
    // makes an identical day-to-day active spread look LARGER once the index has
    // already grown — inflating the annualized tracking error purely as a function of
    // how far into the series it occurs. Two series with the SAME constant ~1pp/day
    // active-return spread should report the SAME tracking error whether that spread
    // compounds from a base of 0% or from an already-large base — the pre-fix
    // diff-of-cumulative approach would report a materially larger figure for the
    // "already-large-base" case; the fixed one should not.
    const buildConstantSpread = (startPct: number, days: number) => {
      // Portfolio compounds at a flat 1%/day from `startPct`; benchmark stays flat
      // (0%/day) from the same start — a constant ~1pp/day active spread throughout.
      let pfIndex = 100 * (1 + startPct / 100);
      const bmIndex = 100 * (1 + startPct / 100);
      const pf = [{ date: "d0", pct: (pfIndex / 100 - 1) * 100 }];
      const bm = [{ date: "d0", pct: (bmIndex / 100 - 1) * 100 }];
      for (let d = 1; d <= days; d++) {
        pfIndex *= 1.01;
        pf.push({ date: `d${d}`, pct: (pfIndex / 100 - 1) * 100 });
        bm.push({ date: `d${d}`, pct: (bmIndex / 100 - 1) * 100 });
      }
      return { pf, bm };
    };

    const early = buildConstantSpread(0, 5); // compounds from cumulative 0%
    const late = buildConstantSpread(200, 5); // compounds from cumulative 200% (already 3×)

    const earlyResult = computeActiveReturn(
      early.pf.map((p) => ({ date: p.date, pct: String(p.pct) })),
      early.bm.map((p) => ({ date: p.date, pct: String(p.pct) })),
    );
    const lateResult = computeActiveReturn(
      late.pf.map((p) => ({ date: p.date, pct: String(p.pct) })),
      late.bm.map((p) => ({ date: p.date, pct: String(p.pct) })),
    );

    expect(earlyResult).not.toBeNull();
    expect(lateResult).not.toBeNull();
    // Same constant 1%/day spread → same tracking error, regardless of the base level
    // it compounds from. (Pre-fix, "late" would report a materially larger figure.)
    expect(Number(lateResult!.trackingError)).toBeCloseTo(Number(earlyResult!.trackingError), 6);
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

describe("getUserBenchmarkConfig", () => {
  async function seedUser(app: Awaited<ReturnType<typeof buildApp>>, symbol?: string) {
    const [u] = await app.db.insert(users).values({
      authSub: crypto.randomUUID(), email: "bm@example.com",
    }).returning();
    if (symbol) {
      await app.db.insert(userPreferences).values({ userId: u.id, benchmarkSymbol: symbol });
    }
    return u;
  }

  it("returns default symbol and USD for a user with no preferences row", async () => {
    const app = await buildApp({ authKey: TEST_KEY });
    try {
      const config = await getUserBenchmarkConfig(app.db, crypto.randomUUID(), "USD");
      expect(config.symbol).toBe("^GSPC");
      expect(config.currency).toBe("USD");
    } finally {
      await app.close();
    }
  });

  it("returns USD when user has a benchmarkSymbol but no benchmark prices yet", async () => {
    const app = await buildApp({ authKey: TEST_KEY });
    try {
      const u = await seedUser(app, "^GDAXI");
      const config = await getUserBenchmarkConfig(app.db, u.id, "EUR");
      expect(config.symbol).toBe("^GDAXI");
      expect(config.currency).toBe("USD");
    } finally {
      await app.close();
    }
  });

  it("infers currency from the most recent benchmark price row", async () => {
    const app = await buildApp({ authKey: TEST_KEY });
    try {
      const u = await seedUser(app, "^N225");
      await app.db.insert(benchmarkPrices).values({
        userId: u.id, symbol: "^N225", date: "2026-01-14", close: "38500", currency: "JPY", source: "yahoo",
      });
      await app.db.insert(benchmarkPrices).values({
        userId: u.id, symbol: "^N225", date: "2026-01-15", close: "39000", currency: "JPY", source: "yahoo",
      });
      const config = await getUserBenchmarkConfig(app.db, u.id, "JPY");
      expect(config.symbol).toBe("^N225");
      expect(config.currency).toBe("JPY");
    } finally {
      await app.close();
    }
  });

  it("infers currency per-symbol, not per-user (two users, same symbol)", async () => {
    const app = await buildApp({ authKey: TEST_KEY });
    try {
      const uA = await seedUser(app, "^GDAXI");
      const uB = await seedUser(app, "^GDAXI");
      await app.db.insert(benchmarkPrices).values({
        userId: uA.id, symbol: "^GDAXI", date: "2026-01-15", close: "20000", currency: "EUR", source: "yahoo",
      });
      await app.db.insert(benchmarkPrices).values({
        userId: uB.id, symbol: "^GDAXI", date: "2026-01-15", close: "20000", currency: "EUR", source: "yahoo",
      });
      const [configA, configB] = await Promise.all([
        getUserBenchmarkConfig(app.db, uA.id, "JPY"),
        getUserBenchmarkConfig(app.db, uB.id, "JPY"),
      ]);
      expect(configA.currency).toBe("EUR");
      expect(configB.currency).toBe("EUR");
    } finally {
      await app.close();
    }
  });
});
