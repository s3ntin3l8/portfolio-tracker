import { describe, it, expect } from "vitest";
import { allowanceUsageYTD, harvestSuggestions, harvestSummary } from "../src/tax.js";
import type { TradeLog, HarvestSuggestion } from "../src/tax.js";

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

  it("nets a lone loss to zero pot usage (nothing to offset), but reports it symmetrically in realizedGainsAdjusted", () => {
    // A loss year: FIFO legs with negative gain. Pre-two-pot-redesign this asset class
    // had no realizedGainsAdjusted symmetry (losses were silently dropped); now the loss
    // IS counted, it just has no gain in its own pot to offset, so usage floors at 0 —
    // the general pot's own floor, not a special-case loss exclusion.
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

    // The loss IS counted (symmetric), but with nothing to offset, usage floors at 0 —
    // remaining stays at the full allowance.
    expect(result.realizedGainsAdjusted).toBe("-100.00");
    expect(result.generalPot.netGainLoss).toBe("-100.00");
    expect(result.generalPot.used).toBe("0.00");
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
// allowanceUsageYTD — Vorabpauschale netting
// ---------------------------------------------------------------------------

/** A minimal closed trade with no gain/dividend activity, just Vorabpauschale fields —
 *  isolates the accrual/credit netting from the realized-gain path already covered above. */
function vorabTrade(overrides: {
  instrumentId: string;
  vorabByYear?: { year: number; amount: string }[];
  vorabCredit?: string;
  taxYear?: number;
}) {
  return {
    instrumentId: overrides.instrumentId,
    currency: "EUR",
    status: "closed" as const,
    entryDate: "2025-01-01",
    exitDate: "2026-06-01",
    holdingDays: 500,
    longTerm: true,
    quantity: "10",
    avgEntryPrice: "100",
    avgExitPrice: "100",
    invested: "1000",
    realizedPnL: "0",
    unrealizedPnL: "0",
    dividends: "0",
    totalReturn: "0",
    totalReturnPct: 0,
    annualizedPct: null,
    vorabByYear: overrides.vorabByYear,
    legs:
      overrides.vorabCredit !== undefined
        ? [
            {
              acqDate: "2025-01-01",
              sellDate: "2026-06-01",
              quantity: "10",
              cost: "1000",
              proceeds: "1000",
              gain: "0",
              holdingDays: 500,
              longTerm: true,
              taxYear: overrides.taxYear ?? 2026,
              vorabCredit: overrides.vorabCredit,
            },
          ]
        : [],
  };
}

describe("allowanceUsageYTD — Vorabpauschale netting", () => {
  it("adds the tf-adjusted accrual for the requested year to usedYtd", () => {
    const log = makeTradeLog({
      trades: [
        vorabTrade({ instrumentId: "etf-1", vorabByYear: [{ year: 2026, amount: "4.18" }] }),
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-1": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
    });
    // 4.18 × (1 − 0.30) = 2.926 → 2.93
    expect(result.vorabpauschaleAccrued).toBe("2.93");
    expect(result.vorabpauschaleCredited).toBe("0.00");
    expect(result.usedYtd).toBe("2.93");
  });

  it("ignores accrual from a year other than the requested one", () => {
    const log = makeTradeLog({
      trades: [
        vorabTrade({ instrumentId: "etf-1", vorabByYear: [{ year: 2025, amount: "4.18" }] }),
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-1": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
    });
    expect(result.vorabpauschaleAccrued).toBe("0.00");
    expect(result.usedYtd).toBe("0.00");
  });

  it("subtracts the tf-adjusted disposal credit from usedYtd", () => {
    const log = makeTradeLog({
      trades: [
        vorabTrade({ instrumentId: "etf-1", vorabCredit: "4.12", taxYear: 2026 }),
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-1": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
    });
    // 4.12 × (1 − 0.30) = 2.884 → 2.88, subtracted.
    expect(result.vorabpauschaleCredited).toBe("2.88");
    expect(result.usedYtd).toBe("0.00"); // clamped — can't go negative
  });

  it("nets a same-year accrual against a same-year credit close to zero (near-cancellation, not exact)", () => {
    // Mirrors the real 2025-accrual/2026-disposal-credit scenario investigated live —
    // the plan explicitly flags this as coincidental, not a mechanism guarantee, so this
    // test asserts the mechanics (both sides applied, net near zero) rather than exactly 0.
    const log = makeTradeLog({
      trades: [
        {
          ...vorabTrade({
            instrumentId: "etf-1",
            vorabByYear: [{ year: 2026, amount: "4.18" }],
            vorabCredit: "4.12",
            taxYear: 2026,
          }),
        },
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-1": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
    });
    expect(result.vorabpauschaleAccrued).toBe("2.93"); // 4.18 × 0.70
    expect(result.vorabpauschaleCredited).toBe("2.88"); // 4.12 × 0.70
    // usedYtd is derived from the unrounded raw values (4.18×0.7 − 4.12×0.7 = 0.042),
    // not the display-rounded accrued/credited strings above — small but non-zero.
    expect(result.usedYtd).toBe("0.04");
  });

  it("a credit larger than this year's accrual reduces usedYtd below what gains/income alone would give", () => {
    // Disposing a position whose Vorabpauschale accrued in a PRIOR year: this year has a
    // credit but no matching accrual, and it should still reduce usedYtd (not clamp at 0
    // before combining with other income).
    const log = makeTradeLog({
      dividendsByYear: [{ year: 2026, amount: "100", tax: "0" }],
      trades: [
        vorabTrade({ instrumentId: "etf-1", vorabCredit: "50", taxYear: 2026 }),
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-1": "0.30" }, // credit tf-adjusted: 50 × 0.70 = 35
      allowanceAnnual: "1000",
      year: 2026,
    });
    // income 100 − credit 35 = 65.
    expect(result.usedYtd).toBe("65.00");
  });

  it("applies each instrument's own Teilfreistellung rate — no single blended rate", () => {
    const log = makeTradeLog({
      trades: [
        vorabTrade({ instrumentId: "etf-30", vorabByYear: [{ year: 2026, amount: "10" }] }),
        vorabTrade({ instrumentId: "bond-fund-0", vorabByYear: [{ year: 2026, amount: "10" }] }),
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "etf-30": "0.30", "bond-fund-0": "0" },
      allowanceAnnual: "1000",
      year: 2026,
    });
    // etf-30: 10 × 0.70 = 7.00; bond-fund-0: 10 × 1.00 = 10.00 → 17.00 total.
    expect(result.vorabpauschaleAccrued).toBe("17.00");
  });

  it("defaults vorabpauschaleAccrued/Credited to zero when the trade log carries no Vorabpauschale data", () => {
    const log = makeTradeLog();
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
    });
    expect(result.vorabpauschaleAccrued).toBe("0.00");
    expect(result.vorabpauschaleCredited).toBe("0.00");
  });
});

// ---------------------------------------------------------------------------
// allowanceUsageYTD — two-pot Verlustverrechnung (Workstream 3)
// ---------------------------------------------------------------------------

/** A single-leg closed trade with a given gain/loss, for one instrument/year. */
function gainTrade(instrumentId: string, gain: string, taxYear = 2026) {
  return {
    instrumentId,
    currency: "EUR",
    status: "closed" as const,
    entryDate: "2025-01-01",
    exitDate: `${taxYear}-06-01`,
    holdingDays: 500,
    longTerm: true,
    quantity: "10",
    avgEntryPrice: "100",
    avgExitPrice: "100",
    invested: "1000",
    realizedPnL: gain,
    unrealizedPnL: "0",
    dividends: "0",
    totalReturn: gain,
    totalReturnPct: 0,
    annualizedPct: null,
    legs: [
      {
        acqDate: "2025-01-01",
        sellDate: `${taxYear}-06-01`,
        quantity: "10",
        cost: "1000",
        proceeds: String(1000 + Number(gain)),
        gain,
        holdingDays: 500,
        longTerm: true,
        taxYear,
      },
    ],
  };
}

describe("allowanceUsageYTD — two-pot Verlustverrechnung", () => {
  it("a stock loss does NOT offset a general-pot (fund) gain — no cross-pot spill", () => {
    const log = makeTradeLog({
      trades: [gainTrade("stock-a", "-500"), gainTrade("fund-a", "300")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity", "fund-a": "etf" },
    });
    expect(result.stockPot.netGainLoss).toBe("-500.00");
    expect(result.stockPot.used).toBe("0.00");
    expect(result.generalPot.netGainLoss).toBe("300.00");
    expect(result.generalPot.used).toBe("300.00");
    // Pre-two-pot this would have netted to 200 (loss offsetting the gain) — now it can't.
    expect(result.usedYtd).toBe("300.00");
  });

  it("a general-pot (fund) loss does NOT offset a stock gain — no cross-pot spill", () => {
    const log = makeTradeLog({
      trades: [gainTrade("stock-a", "300"), gainTrade("fund-a", "-500")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity", "fund-a": "etf" },
    });
    expect(result.stockPot.used).toBe("300.00");
    expect(result.generalPot.used).toBe("0.00");
    expect(result.usedYtd).toBe("300.00");
  });

  it("a stock loss DOES offset another stock gain — same-pot netting still works", () => {
    const log = makeTradeLog({
      trades: [gainTrade("stock-a", "300"), gainTrade("stock-b", "-100")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity", "stock-b": "equity" },
    });
    expect(result.stockPot.netGainLoss).toBe("200.00");
    expect(result.stockPot.used).toBe("200.00");
    expect(result.usedYtd).toBe("200.00");
  });

  it("excludes gold and crypto trades from both pots entirely (§23 EStG regime)", () => {
    const log = makeTradeLog({
      trades: [gainTrade("gold-a", "5000"), gainTrade("crypto-a", "5000"), gainTrade("stock-a", "100")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "gold-a": "gold", "crypto-a": "crypto", "stock-a": "equity" },
    });
    // Only the stock gain counts — gold/crypto's 10,000 combined gain is invisible here.
    expect(result.stockPot.netGainLoss).toBe("100.00");
    expect(result.usedYtd).toBe("100.00");
  });

  it("applies Teilfreistellung symmetrically to a general-pot loss, same as a gain", () => {
    const log = makeTradeLog({
      trades: [gainTrade("fund-a", "-1000")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "fund-a": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "fund-a": "etf" },
    });
    // -1000 × (1 − 0.30) = -700, not -1000 (TF reduces the loss's magnitude too).
    expect(result.generalPot.netGainLoss).toBe("-700.00");
  });

  it("an instrument absent from assetClasses defaults to the general pot", () => {
    const log = makeTradeLog({ trades: [gainTrade("unknown-a", "150")] });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      // assetClasses omitted entirely — matches today's pre-two-pot behavior.
    });
    expect(result.generalPot.used).toBe("150.00");
    expect(result.stockPot.used).toBe("0.00");
  });

  it("subtracts loss carry-forward RAW, without re-applying Teilfreistellung", () => {
    const log = makeTradeLog({
      trades: [gainTrade("fund-a", "1000")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: { "fund-a": "0.30" },
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "fund-a": "etf" },
      lossCarryForward: { general: "400" },
    });
    // Gain tf-adjusted: 1000 × 0.70 = 700. Carry-forward subtracted RAW (not × 0.70 again):
    // 700 − 400 = 300.
    expect(result.generalPot.netGainLoss).toBe("700.00");
    expect(result.generalPot.carryForwardApplied).toBe("400.00");
    expect(result.generalPot.used).toBe("300.00");
    expect(result.usedYtd).toBe("300.00");
  });

  it("carry-forward is applied per-pot independently — a stock carry-forward doesn't touch the general pot", () => {
    const log = makeTradeLog({
      trades: [gainTrade("stock-a", "500"), gainTrade("fund-a", "500")],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity", "fund-a": "etf" },
      lossCarryForward: { stock: "500" },
    });
    expect(result.stockPot.used).toBe("0.00"); // 500 − 500 = 0
    expect(result.generalPot.used).toBe("500.00"); // untouched
    expect(result.usedYtd).toBe("500.00");
  });

  it("a carry-forward larger than the pot's gain floors at 0, never goes negative", () => {
    const log = makeTradeLog({ trades: [gainTrade("stock-a", "100")] });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity" },
      lossCarryForward: { stock: "5000" },
    });
    expect(result.stockPot.used).toBe("0.00");
  });

  it("folds forecast into the general pot's subtotal before ITS floor, not after the total clamp", () => {
    // A general pot that's net-negative before forecast (a Vorabpauschale credit exceeding
    // this year's accrual) would floor to 0 on its own — but forecast income should be
    // netted in BEFORE that floor, so a big enough forecast can still produce projected
    // usage, not just "0 + forecast" (which would double-count relative to the floor).
    const log = makeTradeLog({
      trades: [
        {
          ...vorabTrade({ instrumentId: "fund-a", vorabCredit: "50", taxYear: 2026 }),
        },
      ],
    });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "fund-a": "etf" },
      forecastIncomeRestOfYear: "30",
    });
    // generalSubtotalNoForecast = -50 (credit only, no accrual) → floors to 0 → usedYtd 0.
    expect(result.usedYtd).toBe("0.00");
    // generalSubtotalWithForecast = -50 + 30 = -20 → STILL floors to 0 (not -20 + 0).
    expect(result.projectedUsedFullYear).toBe("0.00");
  });

  it("reports taxableExcess as the amount by which pot usage exceeds the allowance", () => {
    const log = makeTradeLog({ trades: [gainTrade("stock-a", "1500")] });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity" },
    });
    expect(result.usedYtd).toBe("1000.00"); // clamped
    expect(result.taxableExcess).toBe("500.00"); // 1500 − 1000
  });

  it("taxableExcess is zero when total usage is within the allowance", () => {
    const log = makeTradeLog({ trades: [gainTrade("stock-a", "100")] });
    const result = allowanceUsageYTD({
      tradeLog: log,
      tfRates: {},
      allowanceAnnual: "1000",
      year: 2026,
      assetClasses: { "stock-a": "equity" },
    });
    expect(result.taxableExcess).toBe("0.00");
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

// ---------------------------------------------------------------------------
// harvestSummary
// ---------------------------------------------------------------------------

describe("harvestSummary", () => {
  /** A pure-equity suggestion (tfRate=0) with a given unrealized gross gain — each
   *  independently "harvestable" up to the full remaining allowance, per
   *  harvestSuggestions' per-row semantics. */
  function equitySuggestion(instrumentId: string, unrealizedGross: string): HarvestSuggestion {
    return {
      instrumentId,
      unrealizedGross,
      tfRate: "0",
      unrealizedAdjusted: unrealizedGross,
      harvestableGross: unrealizedGross, // as harvestSuggestions would compute it standalone
      taxSaving: "0", // not used by harvestSummary — recomputed from scratch
    };
  }

  it("caps the combined saving at remaining × taxRate — reproduces the reported bug", () => {
    // 10 positions, each individually harvestable up to the full €322 remaining
    // (per-row semantics). The OLD (buggy) web code summed each row's independently-
    // capped harvestableGross/taxSaving, so it would report ~10× the true ceiling.
    const suggestions = Array.from({ length: 10 }, (_, i) =>
      equitySuggestion(`stock-${i}`, "500"),
    );
    const remaining = "322";
    const taxRate = "0.25";

    const naiveSum = suggestions.length * Math.min(500, 322) * 0.25; // what the old bug computed
    expect(naiveSum).toBeCloseTo(805, 0); // ~2.5× over the true ceiling — illustrates the bug

    const result = harvestSummary(suggestions, remaining, taxRate);

    // True ceiling: you can never save more than remaining × taxRate, no matter how
    // many positions you spread it across.
    expect(parseFloat(result.combinedTaxSaving)).toBeLessThanOrEqual(322 * 0.25 + 0.01);
    expect(result.combinedTaxSaving).toBe("80.50"); // 322 × 0.25
    expect(result.combinedHarvestableGross).toBe("322.00");
    // Only the first position is needed to exhaust the allowance (500 > 322).
    expect(result.positionsUsed).toBe(1);
    expect(parseFloat(result.combinedTaxSaving)).toBeLessThan(naiveSum);
    // The concrete plan directly proves "only the positions actually needed" — despite
    // 10 suggestions being passed in, the plan names exactly ONE (the first, best-sorted
    // one), not all 10.
    expect(result.plan).toEqual([
      { instrumentId: "stock-0", grossTake: "322.00", adjustedTake: "322.00" },
    ]);
  });

  it("spreads allocation sequentially across multiple smaller positions", () => {
    const suggestions = [
      equitySuggestion("a", "100"),
      equitySuggestion("b", "150"),
      equitySuggestion("c", "1000"),
    ];
    const result = harvestSummary(suggestions, "200", "0.25");

    // a takes 100 (100 left → 100), b takes the remaining 100 of its 150, c gets 0.
    expect(result.combinedHarvestableGross).toBe("200.00");
    expect(result.combinedTaxSaving).toBe("50.00"); // 200 × 0.25
    expect(result.positionsUsed).toBe(2);
    expect(result.plan).toEqual([
      { instrumentId: "a", grossTake: "100.00", adjustedTake: "100.00" },
      { instrumentId: "b", grossTake: "100.00", adjustedTake: "100.00" },
    ]);
  });

  it("Tf-adjusts before allocating, so an ETF consumes less allowance per € of gross gain", () => {
    const suggestions: HarvestSuggestion[] = [
      {
        instrumentId: "etf-1",
        unrealizedGross: "1000",
        tfRate: "0.30",
        unrealizedAdjusted: "700",
        harvestableGross: "1000",
        taxSaving: "0",
      },
    ];
    // Full 1000 gross gain only consumes 700 of allowance (30% Teilfreistellung).
    const result = harvestSummary(suggestions, "700", "0.25");
    expect(result.combinedHarvestableGross).toBe("1000.00");
    expect(result.combinedTaxSaving).toBe("175.00"); // 700 × 0.25
    expect(result.plan).toEqual([
      { instrumentId: "etf-1", grossTake: "1000.00", adjustedTake: "700.00" },
    ]);
  });

  it("fully tax-exempt positions (tfRate=1) are harvestable even with zero remaining allowance", () => {
    const suggestions: HarvestSuggestion[] = [
      {
        instrumentId: "exempt-1",
        unrealizedGross: "500",
        tfRate: "1",
        unrealizedAdjusted: "0",
        harvestableGross: "500",
        taxSaving: "0",
      },
    ];
    const result = harvestSummary(suggestions, "0", "0.25");
    expect(result.combinedHarvestableGross).toBe("500.00");
    expect(result.combinedTaxSaving).toBe("0.00");
    expect(result.positionsUsed).toBe(1);
    expect(result.plan).toEqual([
      { instrumentId: "exempt-1", grossTake: "500.00", adjustedTake: "0.00" },
    ]);
  });

  it("returns zero when there are no suggestions or no remaining allowance", () => {
    expect(harvestSummary([], "1000", "0.25")).toEqual({
      positionsUsed: 0,
      combinedHarvestableGross: "0.00",
      combinedTaxSaving: "0.00",
      plan: [],
    });
    expect(harvestSummary([equitySuggestion("a", "500")], "0", "0.25")).toEqual({
      positionsUsed: 0,
      combinedHarvestableGross: "0.00",
      combinedTaxSaving: "0.00",
      plan: [],
    });
  });
});
