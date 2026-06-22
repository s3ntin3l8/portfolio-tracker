import { describe, it, expect } from "vitest";
import {
  aggregateIncome,
  projectDividends,
  projectNextYearDividends,
  type IncomeEntry,
} from "../src/index.js";

const d = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

// "now" is fixed so trailing-12m / this-year / last-year windows are deterministic.
const NOW = d("2026-06-15");

// EUR→IDR at 17000; everything else passes through unconverted.
const fx = (from: string, to: string) =>
  from === "EUR" && to === "IDR" ? "17000" : "1";

const events: IncomeEntry[] = [
  // 2024
  { instrumentId: "bbca", symbol: "BBCA", name: "BCA", assetClass: "equity", type: "dividend", price: "100", currency: "IDR", executedAt: d("2024-03-01") },
  // 2025
  { instrumentId: "bbca", symbol: "BBCA", name: "BCA", assetClass: "equity", type: "dividend", price: "200", currency: "IDR", executedAt: d("2025-03-01") },
  { instrumentId: "fr01", symbol: "FR01", name: "Bond", assetClass: "bond", type: "coupon", price: "50", currency: "IDR", executedAt: d("2025-09-01") },
  // 2026 (this year, all within TTM)
  { instrumentId: "bbca", symbol: "BBCA", name: "BCA", assetClass: "equity", type: "dividend", price: "300", currency: "IDR", executedAt: d("2026-03-01") },
  { instrumentId: "vwrl", symbol: "VWRL", name: "Vanguard", assetClass: "etf", type: "dividend", price: "1", currency: "EUR", executedAt: d("2026-05-01") },
];

describe("aggregateIncome", () => {
  const stats = aggregateIncome({
    events,
    displayCurrency: "IDR",
    fx,
    now: NOW,
    forecastCoupons: [{ amount: "50", currency: "IDR" }],
  });

  it("totals income per calendar year (FX-normalized) with payment counts", () => {
    expect(stats.byYear).toEqual([
      { year: "2024", total: "100", paymentCount: 1 },
      { year: "2025", total: "250", paymentCount: 2 },
      // 300 IDR + 1 EUR×17000 = 17300
      { year: "2026", total: "17300", paymentCount: 2 },
    ]);
  });

  it("builds an ascending monthly series across history", () => {
    expect(stats.monthly.map((m) => m.month)).toEqual([
      "2024-03",
      "2025-03",
      "2025-09",
      "2026-03",
      "2026-05",
    ]);
  });

  it("computes TTM, this-year and last-year totals", () => {
    // TTM = last 12 months from 2026-06-15: 2025-09 (50) + 2026-03 (300) + 2026-05 (17000)
    expect(stats.ttm).toBe("17350");
    expect(stats.thisYear).toBe("17300");
    expect(stats.lastYear).toBe("250");
  });

  it("computes the year-over-year delta", () => {
    expect(stats.deltaAbs).toBe("17050"); // 17300 − 250
    expect(stats.deltaPct).toBeCloseTo((17300 - 250) / 250);
  });

  it("returns a null delta percentage when last year had no income", () => {
    const only2026 = aggregateIncome({
      events: events.filter((e) => e.executedAt.getUTCFullYear() === 2026),
      displayCurrency: "IDR",
      fx,
      now: NOW,
    });
    expect(only2026.lastYear).toBe("0");
    expect(only2026.deltaPct).toBeNull();
  });

  it("forecasts next year as projected coupons + the TTM dividend run-rate", () => {
    // TTM dividends only = 300 + 17000 = 17300; coupons = 50 → 17350
    expect(stats.forecastNextYear).toBe("17350");
  });

  it("sums lifetime income and the average per payment", () => {
    expect(stats.lifetimeTotal).toBe("17650"); // 100+250+17300
    expect(stats.paymentCount).toBe(5);
    expect(stats.averagePerPayment).toBe("3530"); // 17650 / 5
  });

  it("ranks top contributors with their share of lifetime income", () => {
    expect(stats.byInstrument[0]).toMatchObject({ symbol: "VWRL", total: "17000" });
    const bbca = stats.byInstrument.find((i) => i.symbol === "BBCA");
    expect(bbca?.total).toBe("600"); // 100+200+300
    expect(bbca?.pct).toBeCloseTo(600 / 17650);
  });

  it("breaks income down by asset class and by currency (native + normalized)", () => {
    const etf = stats.byAssetClass.find((c) => c.assetClass === "etf");
    expect(etf?.total).toBe("17000");
    const eur = stats.byCurrency.find((c) => c.currency === "EUR");
    expect(eur).toMatchObject({ totalNative: "1", totalNormalized: "17000" });
    const idr = stats.byCurrency.find((c) => c.currency === "IDR");
    expect(idr?.totalNative).toBe("650"); // 100+200+50+300
  });

  it("handles an empty event list without dividing by zero", () => {
    const empty = aggregateIncome({ events: [], displayCurrency: "IDR", now: NOW });
    expect(empty.lifetimeTotal).toBe("0");
    expect(empty.averagePerPayment).toBe("0");
    expect(empty.byInstrument).toEqual([]);
    expect(empty.forecastNextYear).toBe("0");
    expect(empty.forecastRestOfYear).toBe("0");
    expect(empty.forecastFullYear).toBe("0");
  });

  it("scales the TTM dividend run-rate by the current/historical quantity ratio for forecastNextYear", () => {
    const statsScaled = aggregateIncome({
      events,
      displayCurrency: "IDR",
      fx,
      now: NOW,
      forecastCoupons: [{ amount: "50", currency: "IDR" }],
      heldQty: new Map([
        ["bbca", "200"],
        ["vwrl", "5"],
      ]),
      qtyAt: (instId, _at) => {
        if (instId === "bbca") {
          return "100";
        }
        if (instId === "vwrl") {
          return "1";
        }
        return "0";
      },
    });

    // BBCA: TTM actual 300 IDR * (200 / 100) = 600 IDR
    // VWRL: TTM actual 17000 IDR * (5 / 1) = 85000 IDR
    // Total: 85600 IDR + 50 IDR coupons = 85650 IDR
    expect(statsScaled.forecastNextYear).toBe("85650");
  });

  it("scales TTM dividends to 0 for positions that are no longer held", () => {
    const statsScaled = aggregateIncome({
      events,
      displayCurrency: "IDR",
      fx,
      now: NOW,
      forecastCoupons: [],
      heldQty: new Map([
        ["bbca", "100"],
      ]),
      qtyAt: (_instId, _at) => "100",
    });

    // BBCA: TTM actual 300 IDR * (100 / 100) = 300 IDR
    // VWRL: not in heldQty -> 0 IDR
    // Total: 300 IDR
    expect(statsScaled.forecastNextYear).toBe("300");
  });
});

describe("aggregateIncome — forecastRestOfYear / forecastFullYear", () => {
  // now = 2026-06-15; this-year actuals = 300 IDR (2026-03-01) + 17000 IDR (2026-05-01 EUR×17000)
  const thisYearActual = "17300";

  it("sums projected dividends + rest-of-year coupons (no FX)", () => {
    const result = aggregateIncome({
      events,
      displayCurrency: "IDR",
      fx,
      now: NOW,
      projectedDividends: [{ amount: "200000", currency: "IDR" }],
      restOfYearCoupons:  [{ amount: "50000",  currency: "IDR" }],
    });
    expect(result.forecastRestOfYear).toBe("250000");
    expect(result.forecastFullYear).toBe(
      String(Number(thisYearActual) + 250000), // 17300 + 250000
    );
  });

  it("FX-converts projected dividends to display currency", () => {
    const result = aggregateIncome({
      events,
      displayCurrency: "IDR",
      fx, // EUR→IDR = 17000
      now: NOW,
      projectedDividends: [{ amount: "2", currency: "EUR" }], // 2 × 17000 = 34000
      restOfYearCoupons:  [],
    });
    expect(result.forecastRestOfYear).toBe("34000");
    expect(result.forecastFullYear).toBe(String(Number(thisYearActual) + 34000));
  });

  it("is zero when no projected dividends or rest-of-year coupons are provided", () => {
    const result = aggregateIncome({ events, displayCurrency: "IDR", fx, now: NOW });
    expect(result.forecastRestOfYear).toBe("0");
    expect(result.forecastFullYear).toBe(thisYearActual);
  });

  it("does not double-count this-year actuals (forecastFullYear = thisYear + forecastRestOfYear)", () => {
    const result = aggregateIncome({
      events,
      displayCurrency: "IDR",
      fx,
      now: NOW,
      projectedDividends: [{ amount: "5000", currency: "IDR" }],
    });
    expect(Number(result.forecastFullYear)).toBe(
      Number(result.thisYear) + Number(result.forecastRestOfYear),
    );
  });
});

describe("projectDividends", () => {
  // Fixed "now" → source window = (2025-06-15, 2025-12-31]; horizon end = 2026-12-31.
  const NOW = d("2026-06-15");

  /** Minimal IncomeEntry for a dividend transaction. */
  const hist = (id: string, iso: string, amount: string, currency = "USD"): IncomeEntry => ({
    instrumentId: id,
    type: "dividend",
    price: amount,
    currency,
    executedAt: d(iso),
  });

  it("returns empty when the instrument has no recorded position (root cause of the MSFT production bug)", () => {
    // MSFT had dividend transactions imported from the DKB Girokonto CSV but no buy
    // rows — the purchase predated the exported window so no position was ever recorded.
    // projectDividends skips any instrument where heldQty ≤ 0 (income.ts:146-147),
    // so MSFT produced historical income but zero dividend forecast.
    const past = [hist("msft", "2025-09-12", "8.00")]; // inside source window
    const heldQty = new Map<string, string>(); // no position recorded → not in map
    expect(projectDividends(past, heldQty, () => "0", NOW)).toHaveLength(0);
  });

  it("projects dividends for a held instrument with history in the source window", () => {
    // Once the opening buy is added, both Sep and Dec entries project one year forward.
    const past = [hist("msft", "2025-09-12", "8.00"), hist("msft", "2025-12-12", "8.00")];
    const heldQty = new Map([["msft", "10"]]);
    const result = projectDividends(past, heldQty, () => "10", NOW);
    expect(result).toHaveLength(2);
    expect(result[0].date).toBe("2026-09-12");
    expect(result[1].date).toBe("2026-12-12");
    expect(result.every((r) => r.currency === "USD")).toBe(true);
  });

  it("skips dividends outside the source window (before now-1yr)", () => {
    // Mar 2025 is before pastStart (2025-06-15) → not replayed.
    const past = [hist("msft", "2025-03-12", "7.50")];
    const heldQty = new Map([["msft", "10"]]);
    expect(projectDividends(past, heldQty, () => "10", NOW)).toHaveLength(0);
  });

  it("scales the projected amount by the current/historical quantity ratio", () => {
    // Historical qty = 5 shares; current qty = 10 → amount doubles.
    const past = [hist("msft", "2025-09-12", "4.00")];
    const heldQty = new Map([["msft", "10"]]);
    const result = projectDividends(past, heldQty, () => "5", NOW);
    expect(result).toHaveLength(1);
    expect(Number(result[0].amount)).toBeCloseTo(8.0); // 4.00 × (10 / 5)
  });

  it("emits source: flat on every entry", () => {
    const past = [hist("msft", "2025-09-12", "8.00")];
    const heldQty = new Map([["msft", "10"]]);
    const result = projectDividends(past, heldQty, () => "10", NOW);
    expect(result[0].source).toBe("flat");
  });
});

// ---------------------------------------------------------------------------
// projectNextYearDividends — cadence/growth/accumulation engine
// ---------------------------------------------------------------------------

describe("projectNextYearDividends", () => {
  // Fixed NOW = 2026-06-15; next-year window = (Dec 31 2026, Dec 31 2027].
  const NOW = d("2026-06-15");
  const nextYearStart = "2026-12-31";
  const nextYearEnd = "2027-12-31";

  const hist = (
    id: string,
    iso: string,
    amount: string,
    currency = "USD",
  ): IncomeEntry => ({
    instrumentId: id,
    type: "dividend",
    price: amount,
    currency,
    executedAt: d(iso),
  });

  it("projects one annual payment in the next calendar year for an annual payer", () => {
    // BBCA paid annually in March; project to March 2027.
    const past = [hist("bbca", "2025-03-01", "300")];
    const heldQty = new Map([["bbca", "100"]]);
    const result = projectNextYearDividends(past, heldQty, () => "100", NOW);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2027-03-01");
    expect(result[0].source).toBe("flat"); // only 1 year of data → no growth
    expect(result[0].growthApplied).toBeUndefined();
  });

  it("projects four quarterly payments for a quarterly payer", () => {
    // Quarterly payer with last payment Dec 2025; cadence = 3 months.
    const past = [
      hist("msft", "2025-03-12", "0.75"),
      hist("msft", "2025-06-12", "0.75"),
      hist("msft", "2025-09-12", "0.80"),
      hist("msft", "2025-12-12", "0.80"),
    ];
    const heldQty = new Map([["msft", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW);
    // 2027: 03, 06, 09, 12 from last payment 2025-12 + 3m steps.
    expect(result).toHaveLength(4);
    expect(result.every((r) => r.date > nextYearStart && r.date <= nextYearEnd)).toBe(true);
    // All dates should be in 2027.
    expect(result.every((r) => r.date.startsWith("2027"))).toBe(true);
  });

  it("projects two semiannual payments for a semiannual payer", () => {
    const past = [
      hist("bond1", "2025-03-01", "500"),
      hist("bond1", "2025-09-01", "500"),
    ];
    const heldQty = new Map([["bond1", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW);
    expect(result).toHaveLength(2);
    expect(result.every((r) => r.date.startsWith("2027"))).toBe(true);
  });

  it("applies YoY per-share growth and tags source: grown", () => {
    // yearBefore (2024): perShare = 100/10 = 10; lastYear (2025): perShare = 110/10 = 11
    // growthFactor = 11 / 10 = 1.1
    const past = [
      hist("aapl", "2024-03-01", "100"), // histQty=10
      hist("aapl", "2025-03-01", "110"), // histQty=10
    ];
    const heldQty = new Map([["aapl", "10"]]);
    // qtyAt: always 10 shares (constant position)
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("grown");
    expect(result[0].growthApplied).toBeCloseTo(1.1, 5);
    // amount = perSharePerPayment(11) × growthFactor(1.1) × qty(10) = 11 × 1.1 × 10 = 121
    expect(Number(result[0].amount)).toBeCloseTo(121, 2);
  });

  it("clamps growth factor to 0.5 when dividend was cut by more than half", () => {
    // lastYear perShare = 5/10 = 0.5; yearBefore = 50/10 = 5 → raw factor 0.1 < 0.5
    const past = [
      hist("cutco", "2024-03-01", "50"), // perShare=5
      hist("cutco", "2025-03-01", "5"),  // perShare=0.5
    ];
    const heldQty = new Map([["cutco", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].growthApplied).toBeCloseTo(0.5, 5); // clamped
  });

  it("clamps growth factor to 2.0 when dividend doubled or more", () => {
    // lastYear perShare = 100/10 = 10; yearBefore = 10/10 = 1 → raw 10 > 2
    const past = [
      hist("raiseco", "2024-03-01", "10"),  // perShare=1
      hist("raiseco", "2025-03-01", "100"), // perShare=10
    ];
    const heldQty = new Map([["raiseco", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: true,
    });
    expect(result).toHaveLength(1);
    expect(result[0].growthApplied).toBeCloseTo(2.0, 5); // clamped
  });

  it("excludes one-off dividends from the growth ratio", () => {
    // A special dividend in 2024 that dwarfs the regular ones should be filtered.
    // Regular perShare: 10/10=1 in 2024 (3 payments), special: 200/10=20
    // Without one-off guard: (2024 perShare sum = 3+20=23) vs (2025=12); factor=12/23≈0.52
    // With one-off guard: median of [1,1,1,20]=1; filter >2*1=2 → exclude 20; 2024 sum=3
    // factor=12/3=4 → clamped to 2.0
    const past = [
      hist("spec", "2024-03-01", "10"), // perShare=1 regular
      hist("spec", "2024-06-01", "10"), // perShare=1 regular
      hist("spec", "2024-09-01", "10"), // perShare=1 regular
      hist("spec", "2024-12-01", "200"), // perShare=20 SPECIAL — should be excluded
      hist("spec", "2025-03-01", "40"), // perShare=4 regular
      hist("spec", "2025-06-01", "40"), // perShare=4 regular
      hist("spec", "2025-09-01", "40"), // perShare=4 regular
    ];
    const heldQty = new Map([["spec", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: true,
    });
    expect(result).toHaveLength(4); // quarterly → 4 payments in 2027
    // growthFactor clamped to 2.0 (raw=4/1=4 after filtering the special)
    expect(result[0].growthApplied).toBeCloseTo(2.0, 5);
  });

  it("does not apply growth when applyGrowth is false", () => {
    const past = [
      hist("flat", "2024-03-01", "10"),
      hist("flat", "2025-03-01", "20"), // 2× growth
    ];
    const heldQty = new Map([["flat", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: false,
    });
    expect(result[0].source).toBe("flat");
    expect(result[0].growthApplied).toBeUndefined();
    // amount = 20/10 perShare × 1.0 factor × 10 qty = 20
    expect(Number(result[0].amount)).toBeCloseTo(20, 2);
  });

  it("skips instruments not in heldQty (fully sold)", () => {
    const past = [hist("gone", "2025-09-12", "8.00")];
    const heldQty = new Map<string, string>(); // not held
    expect(projectNextYearDividends(past, heldQty, () => "10", NOW)).toHaveLength(0);
  });

  it("skips instruments with no payment in the trailing 24 months", () => {
    // Only payment was in 2023, more than 24 months ago.
    const past = [hist("old", "2023-03-01", "100")];
    const heldQty = new Map([["old", "10"]]);
    expect(projectNextYearDividends(past, heldQty, () => "10", NOW)).toHaveLength(0);
  });

  it("scales projected quantity by accumulation rate (assumesContributions flag)", () => {
    // Annual payer; current qty = 10, accumulation rate = 1 share/month.
    // Next annual payment ≈ 6 months ahead (Dec 2025 + 12 = Dec 2026; next = Dec 2027).
    // monthsAhead ≈ 18; projectedQty = 10 + 1×18 = 28.
    const past = [hist("grower", "2025-12-01", "100")]; // perShare = 100/10 = 10
    const heldQty = new Map([["grower", "10"]]);
    const accumulation = new Map([["grower", "1"]]); // 1 share/month
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      accumulation,
      applyGrowth: false,
    });
    expect(result).toHaveLength(1);
    expect(result[0].assumesContributions).toBe(true);
    // projectedQty > currentQty (10), so amount > base (10 perShare × 10 qty = 100).
    expect(Number(result[0].amount)).toBeGreaterThan(100);
  });

  it("feeds forecastNextYear via projectedDividendsNextYear in aggregateIncome", () => {
    // With the event-based input, forecastNextYear = sum of those amounts + coupons.
    const result = aggregateIncome({
      events: [],
      displayCurrency: "IDR",
      now: NOW,
      projectedDividendsNextYear: [
        { amount: "50000", currency: "IDR" },
        { amount: "30000", currency: "IDR" },
      ],
      forecastCoupons: [{ amount: "10000", currency: "IDR" }],
    });
    // 50000 + 30000 + 10000 = 90000
    expect(result.forecastNextYear).toBe("90000");
  });

  it("forecastNextYear falls back to TTM scalar when projectedDividendsNextYear is absent", () => {
    // Backward compat: existing call sites that don't pass projectedDividendsNextYear
    // still get the TTM-based estimate.
    const result = aggregateIncome({
      events: [
        {
          instrumentId: "bbca",
          type: "dividend",
          price: "300",
          currency: "IDR",
          executedAt: d("2026-03-01"),
        },
      ],
      displayCurrency: "IDR",
      now: NOW,
      // no projectedDividendsNextYear → TTM path
    });
    // TTM = 300 IDR; forecastNextYear = 300.
    expect(result.forecastNextYear).toBe("300");
  });

  it("emits perShare and quantity on every projected entry", () => {
    // Quarterly payer; currentQty = 20; four payments should appear.
    const qtrPast = [
      hist("div", "2025-03-01", "40.00"),
      hist("div", "2025-06-01", "40.00"),
      hist("div", "2025-09-01", "40.00"),
      hist("div", "2025-12-01", "40.00"),
    ];
    const heldQty = new Map([["div", "20"]]);
    const result = projectNextYearDividends(qtrPast, heldQty, () => "20", NOW, {
      applyGrowth: false,
    });
    expect(result.length).toBeGreaterThan(0);
    for (const r of result) {
      expect(r.perShare).toBeDefined();
      expect(r.quantity).toBeDefined();
      // perShare × quantity ≈ amount (within floating-point rounding)
      const reconstructed = Number(r.perShare) * Number(r.quantity);
      expect(reconstructed).toBeCloseTo(Number(r.amount), 6);
    }
  });

  it("reflects growth factor in perShare but not in quantity (flat accumulation)", () => {
    // Two payments: 2024-07 and 2025-07. NOW = 2026-06-15; cutoff24mo = 2024-06-15.
    // Both dates are within the 24-month window so both enter the base average.
    // growthFactor = 2.2/2.0 = 1.1; base avg perShare = (2.0+2.2)/2 = 2.1; qty = 10.
    const past = [
      hist("grw", "2024-07-01", "20.00"), // 20/10 = 2.0 perShare — within 24mo window
      hist("grw", "2025-07-01", "22.00"), // 22/10 = 2.2 perShare
    ];
    const heldQty = new Map([["grw", "10"]]);
    const result = projectNextYearDividends(past, heldQty, () => "10", NOW, {
      applyGrowth: true,
    });
    expect(result).toHaveLength(1);
    // perShare = avg(2.0, 2.2) × growthFactor(1.1) = 2.1 × 1.1 ≈ 2.31; qty = 10
    expect(Number(result[0].perShare)).toBeCloseTo(2.31, 1);
    expect(Number(result[0].quantity)).toBeCloseTo(10, 4);
    const reconstructed = Number(result[0].perShare) * Number(result[0].quantity);
    expect(reconstructed).toBeCloseTo(Number(result[0].amount), 6);
  });
});

// ---------------------------------------------------------------------------
// projectDividends — perShare/quantity fields
// ---------------------------------------------------------------------------

describe("projectDividends — perShare and quantity fields", () => {
  const NOW = d("2026-06-15");

  const hist = (id: string, date: string, price: string): IncomeEntry => ({
    instrumentId: id,
    symbol: id.toUpperCase(),
    type: "dividend",
    price,
    currency: "USD",
    executedAt: d(date),
  });

  it("emits perShare and quantity on rest-of-year projected entries", () => {
    const past = [hist("aapl", "2025-09-01", "10.00")]; // in last-year same-window
    const heldQty = new Map([["aapl", "5"]]);
    const result = projectDividends(past, heldQty, () => "5", NOW);
    expect(result).toHaveLength(1);
    expect(result[0].perShare).toBeDefined();
    expect(result[0].quantity).toBeDefined();
    // currentQty = 5; amount = 10 × (5/5) = 10; perShare = 10/5 = 2; quantity = 5
    expect(Number(result[0].perShare)).toBeCloseTo(2.0, 6);
    expect(Number(result[0].quantity)).toBeCloseTo(5, 6);
    const reconstructed = Number(result[0].perShare) * Number(result[0].quantity);
    expect(reconstructed).toBeCloseTo(Number(result[0].amount), 6);
  });

  it("scales perShare correctly when qty increases", () => {
    // histQty = 5, currentQty = 10: amount doubles but perShare stays same
    const past = [hist("msft", "2025-09-01", "4.00")];
    const heldQty = new Map([["msft", "10"]]);
    const result = projectDividends(past, heldQty, () => "5", NOW);
    expect(result).toHaveLength(1);
    // amount = 4 × (10/5) = 8; perShare = 8/10 = 0.8; qty = 10
    expect(Number(result[0].amount)).toBeCloseTo(8.0, 6);
    expect(Number(result[0].perShare)).toBeCloseTo(0.8, 6);
    expect(Number(result[0].quantity)).toBeCloseTo(10, 6);
  });
});
