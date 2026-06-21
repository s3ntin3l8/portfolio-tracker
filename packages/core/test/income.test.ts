import { describe, it, expect } from "vitest";
import { aggregateIncome, projectDividends, type IncomeEntry } from "../src/index.js";

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
});
