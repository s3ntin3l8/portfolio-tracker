import { describe, it, expect } from "vitest";
import { allowanceUsageYTD, harvestSuggestions } from "../src/tax.js";
import type { TradeLog } from "../src/tax.js";

// ---------------------------------------------------------------------------
// Helpers to build minimal TradeLog fixtures
// ---------------------------------------------------------------------------

function makeTradeLog(overrides: Partial<TradeLog> = {}): TradeLog {
  return {
    displayCurrency: "EUR",
    method: "fifo",
    trades: [],
    totalRealized: "0",
    totalDividends: "0",
    totalReturn: "0",
    winRate: null,
    realizedByYear: [],
    dividendsByYear: [],
    bonusesByYear: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// allowanceUsageYTD
// ---------------------------------------------------------------------------

describe("allowanceUsageYTD", () => {
  it("returns zero usage when there are no trades and no income", () => {
    const log = makeTradeLog();
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });
    expect(result.year).toBe(2025);
    expect(result.allowanceAnnual).toBe("1000.00");
    expect(result.realizedGainsAdjusted).toBe("0.00");
    expect(result.incomeYtd).toBe("0.00");
    expect(result.usedYtd).toBe("0.00");
    expect(result.remaining).toBe("1000.00");
    expect(result.currency).toBe("EUR");
  });

  it("counts FIFO gain from a closed trade (no Teilfreistellung)", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "inst-1",
          currency: "EUR",
          status: "closed",
          entryDate: "2025-01-10",
          exitDate: "2025-06-01",
          holdingDays: 142,
          longTerm: false,
          quantity: "10",
          avgEntryPrice: "100",
          avgExitPrice: "150",
          invested: "1000",
          realizedPnL: "500",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "500",
          totalReturnPct: 50,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2025-01-10",
              sellDate: "2025-06-01",
              quantity: "10",
              cost: "1000",
              proceeds: "1500",
              gain: "500",
              holdingDays: 142,
              longTerm: false,
              taxYear: 2025,
            },
          ],
        },
      ],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    // No Teilfreistellung: gain counts in full.
    expect(result.realizedGainsAdjusted).toBe("500.00");
    expect(result.usedYtd).toBe("500.00");
    expect(result.remaining).toBe("500.00");
  });

  it("applies Teilfreistellung 30% for equity ETF", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "etf-world",
          currency: "EUR",
          status: "closed",
          entryDate: "2025-02-01",
          exitDate: "2025-09-01",
          holdingDays: 212,
          longTerm: false,
          quantity: "5",
          avgEntryPrice: "200",
          avgExitPrice: "400",
          invested: "1000",
          realizedPnL: "1000",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "1000",
          totalReturnPct: 100,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2025-02-01",
              sellDate: "2025-09-01",
              quantity: "5",
              cost: "1000",
              proceeds: "2000",
              gain: "1000",
              holdingDays: 212,
              longTerm: false,
              taxYear: 2025,
            },
          ],
        },
      ],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-world": "0.30" },
      allowanceAnnual: "1000",
      year: 2025,
    });

    // Tf-adjusted gain = 1000 × (1 − 0.30) = 700.
    expect(result.realizedGainsAdjusted).toBe("700.00");
    expect(result.usedYtd).toBe("700.00");
    expect(result.remaining).toBe("300.00");
  });

  it("counts dividend income against the allowance", () => {
    const log = makeTradeLog({
      dividendsByYear: [
        { year: 2025, amount: "200", tax: "0" },
      ],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result.incomeYtd).toBe("200.00");
    expect(result.usedYtd).toBe("200.00");
    expect(result.remaining).toBe("800.00");
  });

  it("uses GROSS dividend income (net + withholding) for Sparerpauschbetrag", () => {
    // net received = 150, withholding = 50 → gross = 200
    // The Sparerpauschbetrag is consumed by gross Kapitalerträge (§20 EStG),
    // so incomeYtd must be 200, not 150.
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "150", tax: "50" }],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result.incomeYtd).toBe("200.00"); // gross, not net
    expect(result.usedYtd).toBe("200.00");
    expect(result.remaining).toBe("800.00");
  });

  it("combines realized gains and income", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "inst-2",
          currency: "EUR",
          status: "closed",
          entryDate: "2025-01-01",
          exitDate: "2025-03-01",
          holdingDays: 59,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: "400",
          invested: "100",
          realizedPnL: "300",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "300",
          totalReturnPct: 300,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2025-01-01",
              sellDate: "2025-03-01",
              quantity: "1",
              cost: "100",
              proceeds: "400",
              gain: "300",
              holdingDays: 59,
              longTerm: false,
              taxYear: 2025,
            },
          ],
        },
      ],
      dividendsByYear: [{ year: 2025, amount: "100", tax: "0" }],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result.realizedGainsAdjusted).toBe("300.00");
    expect(result.incomeYtd).toBe("100.00");
    expect(result.usedYtd).toBe("400.00");
    expect(result.remaining).toBe("600.00");
  });

  it("clamps usedYtd to allowance when total exceeds it", () => {
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "5000", tax: "0" }],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    // Even though income is 5000, usedYtd is capped at allowance.
    expect(result.usedYtd).toBe("1000.00");
    expect(result.remaining).toBe("0.00");
  });

  it("does not let negative realized gains reduce remaining below allowance", () => {
    // A loss year: FIFO legs with negative gain.
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "inst-loss",
          currency: "EUR",
          status: "closed",
          entryDate: "2025-01-01",
          exitDate: "2025-04-01",
          holdingDays: 90,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "200",
          avgExitPrice: "100",
          invested: "200",
          realizedPnL: "-100",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "-100",
          totalReturnPct: -50,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2025-01-01",
              sellDate: "2025-04-01",
              quantity: "1",
              cost: "200",
              proceeds: "100",
              gain: "-100",
              holdingDays: 90,
              longTerm: false,
              taxYear: 2025,
            },
          ],
        },
      ],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    // Losses don't count as negative usage; remaining stays at full allowance.
    expect(result.realizedGainsAdjusted).toBe("0.00");
    expect(result.usedYtd).toBe("0.00");
    expect(result.remaining).toBe("1000.00");
  });

  it("ignores legs from a different tax year", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "inst-3",
          currency: "EUR",
          status: "closed",
          entryDate: "2024-01-01",
          exitDate: "2024-12-31",
          holdingDays: 365,
          longTerm: true,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: "200",
          invested: "100",
          realizedPnL: "100",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "100",
          totalReturnPct: 100,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2024-01-01",
              sellDate: "2024-12-31",
              quantity: "1",
              cost: "100",
              proceeds: "200",
              gain: "100",
              holdingDays: 365,
              longTerm: true,
              taxYear: 2024, // last year
            },
          ],
        },
      ],
    });

    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025, // asking about 2025
    });

    expect(result.realizedGainsAdjusted).toBe("0.00");
    expect(result.remaining).toBe("1000.00");
  });

  it("uses current UTC year when year is not supplied", () => {
    const log = makeTradeLog();
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
    });
    expect(result.year).toBe(new Date().getUTCFullYear());
  });

  it("uses custom tax rate for taxSavingAvailable", () => {
    const log = makeTradeLog();
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      taxRate: "0.26375", // KapSt 25% + Soli
      year: 2025,
    });
    // Remaining = 1000, taxSaving = 1000 × 0.26375 = 263.75
    expect(result.taxRate).toBe("0.26375");
    expect(result.taxSavingAvailable).toBe("263.75");
  });
});

// ---------------------------------------------------------------------------
// harvestSuggestions
// ---------------------------------------------------------------------------

describe("harvestSuggestions", () => {
  it("returns empty when no remaining allowance", () => {
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "5000", tax: "0" }],
      trades: [
        {
          instrumentId: "etf-1",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 100,
          longTerm: false,
          quantity: "10",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "1000",
          realizedPnL: "0",
          unrealizedPnL: "500",
          dividends: "0",
          totalReturn: "500",
          totalReturnPct: 50,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result).toHaveLength(0);
  });

  it("suggests harvesting a plain stock (tfRate = 0)", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "stock-1",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 200,
          longTerm: false,
          quantity: "5",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "500",
          realizedPnL: "0",
          unrealizedPnL: "300",
          dividends: "0",
          totalReturn: "300",
          totalReturnPct: 60,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result).toHaveLength(1);
    const s = result[0];
    expect(s.instrumentId).toBe("stock-1");
    expect(s.tfRate).toBe("0");
    // No Tf: adjusted = gross.
    expect(s.unrealizedAdjusted).toBe("300.00");
    // Whole position fits in remaining allowance (300 < 1000).
    expect(s.harvestableGross).toBe("300.00");
    // Tax saving = 300 × 0.25 = 75.
    expect(s.taxSaving).toBe("75.00");
  });

  it("reduces harvestableGross when gain exceeds remaining allowance (equity ETF)", () => {
    // 500 remaining, ETF with 1000 unrealized gross.
    // Tf 30%: adjusted = 1000 × 0.70 = 700; adjusted > 500.
    // harvestableGross = 500 / 0.70 ≈ 714.28...
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "500", tax: "0" }],
      trades: [
        {
          instrumentId: "etf-world",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 150,
          longTerm: false,
          quantity: "10",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "1000",
          realizedPnL: "0",
          unrealizedPnL: "1000",
          dividends: "0",
          totalReturn: "1000",
          totalReturnPct: 100,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: { "etf-world": "0.30" },
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result).toHaveLength(1);
    const s = result[0];
    expect(parseFloat(s.tfRate)).toBeCloseTo(0.30);
    expect(s.unrealizedGross).toBe("1000.00");
    expect(s.unrealizedAdjusted).toBe("700.00");
    // harvestableGross = 500 / 0.70 ≈ 714.2857...
    const hg = parseFloat(s.harvestableGross);
    expect(hg).toBeCloseTo(714.29, 1);
    // Tax saving = min(700, 500) × 0.25 = 500 × 0.25 = 125.
    expect(s.taxSaving).toBe("125.00");
  });

  it("excludes open positions that are at a loss", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "stock-loss",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 100,
          longTerm: false,
          quantity: "10",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "1000",
          realizedPnL: "0",
          unrealizedPnL: "-200", // loss
          dividends: "0",
          totalReturn: "-200",
          totalReturnPct: -20,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result).toHaveLength(0);
  });

  it("excludes closed positions from harvest suggestions", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "stock-closed",
          currency: "EUR",
          status: "closed",
          entryDate: "2025-01-01",
          exitDate: "2025-06-01",
          holdingDays: 151,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: "200",
          invested: "100",
          realizedPnL: "100",
          unrealizedPnL: "0",
          dividends: "0",
          totalReturn: "100",
          totalReturnPct: 100,
          annualizedPct: null,
          legs: [
            {
              acqDate: "2025-01-01",
              sellDate: "2025-06-01",
              quantity: "1",
              cost: "100",
              proceeds: "200",
              gain: "100",
              holdingDays: 151,
              longTerm: false,
              taxYear: 2025,
            },
          ],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });

    // Closed positions shouldn't appear in harvest suggestions.
    expect(result).toHaveLength(0);
  });

  it("sorts suggestions by descending tf-adjusted unrealized gain", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "etf-small",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 100,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "100",
          realizedPnL: "0",
          unrealizedPnL: "200",
          dividends: "0",
          totalReturn: "200",
          totalReturnPct: 200,
          annualizedPct: null,
          legs: [],
        },
        {
          instrumentId: "stock-big",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 100,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "100",
          realizedPnL: "0",
          unrealizedPnL: "500",
          dividends: "0",
          totalReturn: "500",
          totalReturnPct: 500,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const result = harvestSuggestions({
      tradeLog: log,
      // ETF with 30% tf: adjusted = 200 × 0.70 = 140
      // Stock with 0% tf: adjusted = 500 × 1.00 = 500
      tfRates: { "etf-small": "0.30" },
      allowanceAnnual: "1000",
      year: 2025,
    });

    expect(result).toHaveLength(2);
    // stock-big should come first (adjusted 500 > adjusted 140)
    expect(result[0].instrumentId).toBe("stock-big");
    expect(result[1].instrumentId).toBe("etf-small");
  });

  it("accepts pre-computed usage to avoid double computation", () => {
    const log = makeTradeLog({
      trades: [
        {
          instrumentId: "stock-a",
          currency: "EUR",
          status: "open",
          entryDate: "2025-01-01",
          exitDate: null,
          holdingDays: 100,
          longTerm: false,
          quantity: "1",
          avgEntryPrice: "100",
          avgExitPrice: null,
          invested: "100",
          realizedPnL: "0",
          unrealizedPnL: "100",
          dividends: "0",
          totalReturn: "100",
          totalReturnPct: 100,
          annualizedPct: null,
          legs: [],
        },
      ],
    });

    const usage = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "500",
      year: 2025,
    });

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "500",
      year: 2025,
      usage,
    });

    expect(result).toHaveLength(1);
    expect(result[0].harvestableGross).toBe("100.00"); // 100 fits in 500
  });
});

// ---------------------------------------------------------------------------
// forecastIncomeRestOfYear — projected fields
// ---------------------------------------------------------------------------

describe("allowanceUsageYTD with forecastIncomeRestOfYear", () => {
  it("echoes '0.00' and leaves realized fields unchanged when forecast is zero/omitted", () => {
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "200", tax: "0" }],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
    });
    expect(result.forecastIncomeRestOfYear).toBe("0.00");
    expect(result.projectedUsedFullYear).toBe("200.00"); // same as usedYtd
    expect(result.projectedRemaining).toBe("800.00"); // same as remaining
    expect(result.projectedTaxSavingAvailable).toBe("200.00"); // 800 × 0.25
  });

  it("reduces projectedRemaining by the forecast amount", () => {
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "200", tax: "0" }],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      forecastIncomeRestOfYear: "310",
    });
    // realized: 200 used, remaining: 800.
    // forecast: 310 → projectedUsed = min(200 + 310, 1000) = 510.
    expect(result.incomeYtd).toBe("200.00"); // realized stays
    expect(result.remaining).toBe("800.00");   // realized stays
    expect(result.forecastIncomeRestOfYear).toBe("310.00");
    expect(result.projectedUsedFullYear).toBe("510.00");
    expect(result.projectedRemaining).toBe("490.00");
    expect(result.projectedTaxSavingAvailable).toBe("122.50"); // 490 × 0.25
  });

  it("clamps projectedUsedFullYear to the annual allowance", () => {
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "600", tax: "0" }],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      forecastIncomeRestOfYear: "600",
    });
    // 600 (realized) + 600 (forecast) = 1200 → clamped to 1000.
    expect(result.projectedUsedFullYear).toBe("1000.00");
    expect(result.projectedRemaining).toBe("0.00");
    expect(result.projectedTaxSavingAvailable).toBe("0.00");
  });

  it("ignores negative forecast values (treated as zero)", () => {
    const log = makeTradeLog();
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      forecastIncomeRestOfYear: "-50",
    });
    expect(result.forecastIncomeRestOfYear).toBe("0.00");
    expect(result.projectedRemaining).toBe("1000.00");
  });
});

describe("harvestSuggestions with forecast-aware projectedRemaining", () => {
  function makeOpenTrade(instrumentId: string, unrealizedPnL: string) {
    return {
      instrumentId,
      currency: "EUR",
      status: "open" as const,
      entryDate: "2025-01-01",
      exitDate: null,
      holdingDays: 150,
      longTerm: false,
      quantity: "10",
      avgEntryPrice: "100",
      avgExitPrice: null,
      invested: "1000",
      realizedPnL: "0",
      unrealizedPnL,
      dividends: "0",
      totalReturn: unrealizedPnL,
      totalReturnPct: Number(unrealizedPnL) / 10,
      annualizedPct: null,
      legs: [],
    };
  }

  it("sizes suggestions against projectedRemaining when forecast is present", () => {
    // allowance = 1000, no realized income → remaining = 1000.
    // forecast = 700 → projectedRemaining = 300.
    // Stock with unrealized gain = 500 → should be capped to 300.
    const log = makeTradeLog({ trades: [makeOpenTrade("stock-x", "500")] });
    const usage = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      forecastIncomeRestOfYear: "700",
    });
    expect(usage.projectedRemaining).toBe("300.00");

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      usage,
    });

    expect(result).toHaveLength(1);
    // harvestableGross capped at 300 (projectedRemaining), not 500.
    expect(parseFloat(result[0].harvestableGross)).toBeCloseTo(300, 1);
    expect(result[0].taxSaving).toBe("75.00"); // 300 × 0.25
  });

  it("returns empty harvest list when forecast eats all remaining allowance", () => {
    // allowance = 1000, realized income = 400 → remaining = 600.
    // forecast = 600 → projectedRemaining = 0.
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2025, amount: "400", tax: "0" }],
      trades: [makeOpenTrade("etf-1", "500")],
    });
    const usage = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      forecastIncomeRestOfYear: "600",
    });
    expect(usage.projectedRemaining).toBe("0.00");

    const result = harvestSuggestions({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2025,
      usage,
    });
    expect(result).toHaveLength(0);
  });
});
