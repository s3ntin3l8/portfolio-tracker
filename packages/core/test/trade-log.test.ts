import { describe, it, expect } from "vitest";
import {
  computeTrades,
  summarizePortfolio,
  type CoreTransaction,
  type CorporateAction,
  type ComputeTradesInput,
} from "../src/index.js";

const INST = "inst-1";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: INST,
    type: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2021-01-01"),
    ...p,
  };
}

function run(
  txns: CoreTransaction[],
  opts: Partial<ComputeTradesInput> = {},
) {
  return computeTrades({
    transactions: txns,
    prices: { [INST]: { price: "100", currency: "EUR" } },
    instruments: { [INST]: { assetClass: "gold" } },
    displayCurrency: "EUR",
    now: new Date("2024-01-01"),
    ...opts,
  });
}

describe("computeTrades — episode segmentation", () => {
  it("forms one closed episode for a simple buy→sell round-trip", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "10", price: "130", executedAt: new Date("2021-06-01") }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.status).toBe("closed");
    expect(t.entryDate).toBe("2021-01-01");
    expect(t.exitDate).toBe("2021-06-01");
    expect(t.realizedPnL).toBe("300"); // 1300 − 1000
    expect(t.avgEntryPrice).toBe("100");
    expect(t.avgExitPrice).toBe("130");
    expect(t.quantity).toBe("10");
  });

  it("re-buying after a full close starts a new episode (FIFO never crosses the boundary)", () => {
    const txns = [
      tx({ type: "buy", quantity: "5", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "5", price: "110", executedAt: new Date("2021-06-01") }),
      tx({ type: "buy", quantity: "5", price: "200", executedAt: new Date("2022-01-01") }),
    ];
    const { trades } = run(txns, { method: "fifo" });
    expect(trades).toHaveLength(2);
    const open = trades.find((t) => t.status === "open")!;
    const closed = trades.find((t) => t.status === "closed")!;
    expect(closed.realizedPnL).toBe("50"); // 550 − 500
    expect(open.invested).toBe("1000"); // only the 2022 lot
    expect(open.entryDate).toBe("2022-01-01");
  });

  it("leaves a partially-sold position open with the remaining quantity", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "4", price: "150", executedAt: new Date("2021-06-01") }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe("open");
    expect(trades[0].quantity).toBe("6");
  });
});

describe("computeTrades — average vs FIFO", () => {
  // Two lots, one full exit: total realized is method-INDEPENDENT.
  const closedTxns = [
    tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
    tx({ type: "buy", quantity: "10", price: "120", executedAt: new Date("2022-01-01") }),
    tx({ type: "sell", quantity: "20", price: "130", executedAt: new Date("2023-01-01") }),
  ];

  it("agrees on total realized over a fully-closed episode (the invariant)", () => {
    const avg = run(closedTxns, { method: "average" }).trades[0];
    const fifo = run(closedTxns, { method: "fifo" }).trades[0];
    expect(avg.realizedPnL).toBe("400"); // 2600 − 2200
    expect(fifo.realizedPnL).toBe("400");
  });

  it("diverges on tax-year attribution of partial interim sells", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-06-01") }),
      tx({ type: "buy", quantity: "10", price: "120", executedAt: new Date("2022-06-01") }),
      tx({ type: "sell", quantity: "10", price: "130", executedAt: new Date("2022-12-01") }),
      tx({ type: "sell", quantity: "10", price: "140", executedAt: new Date("2023-12-01") }),
    ];
    const avg = run(txns, { method: "average" });
    const fifo = run(txns, { method: "fifo" });

    // Average: 2022 = 1300 − 1100 = 200; 2023 = 1400 − 1100 = 300.
    expect(avg.realizedByYear).toEqual([
      { year: 2022, amount: "200" },
      { year: 2023, amount: "300" },
    ]);
    // FIFO: 2022 sells lot1 (1000) → 300; 2023 sells lot2 (1200) → 200.
    expect(fifo.realizedByYear).toEqual([
      { year: 2022, amount: "300" },
      { year: 2023, amount: "200" },
    ]);
    // Same lifetime total either way.
    expect(avg.totalRealized).toBe("500");
    expect(fifo.totalRealized).toBe("500");
  });

  it("exposes per-lot legs in FIFO mode with each lot's acquisition date", () => {
    const { trades } = run(closedTxns, { method: "fifo" });
    const legs = trades[0].legs;
    expect(legs).toHaveLength(2);
    expect(legs[0]).toMatchObject({ acqDate: "2021-01-01", quantity: "10", gain: "300" });
    expect(legs[1]).toMatchObject({ acqDate: "2022-01-01", quantity: "10", gain: "100" });
  });

  it("does not emit zero-quantity legs after multi-tranche sells (regression: lotIdx fork)", () => {
    // Three buys accumulating 20 shares, then two sells — the second sell must not
    // re-scan zeroed lots and emit {quantity:0} slices.
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "buy", quantity: "5", price: "110", executedAt: new Date("2021-06-01") }),
      tx({ type: "buy", quantity: "5", price: "120", executedAt: new Date("2021-12-01") }),
      tx({ type: "sell", quantity: "12", price: "130", executedAt: new Date("2022-06-01") }),
      tx({ type: "sell", quantity: "8", price: "140", executedAt: new Date("2022-12-01") }),
    ];
    const { trades } = run(txns, { method: "fifo" });
    expect(trades).toHaveLength(1); // single episode, closed
    const legs = trades[0].legs;
    // All legs must have positive quantity — zero-qty ghosts are the regression.
    for (const leg of legs) {
      expect(Number(leg.quantity)).toBeGreaterThan(0);
    }
    // Total disposed quantity equals sum of all sell quantities (12 + 8 = 20).
    const totalLegQty = legs.reduce((s, l) => s + Number(l.quantity), 0);
    expect(totalLegQty).toBe(20);
  });
});

describe("computeTrades — dividends folded into the holding window", () => {
  it("adds in-window dividends to total return, excludes them from invested", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "dividend", quantity: "0", price: "50", executedAt: new Date("2021-06-01") }),
    ];
    const { trades } = run(txns, { prices: { [INST]: { price: "110", currency: "EUR" } } });
    const t = trades[0];
    expect(t.status).toBe("open");
    expect(t.dividends).toBe("50");
    expect(t.unrealizedPnL).toBe("100"); // 1100 − 1000
    expect(t.totalReturn).toBe("150"); // 0 realized + 100 unrealized + 50 dividend
    expect(t.invested).toBe("1000"); // dividend not counted as capital
  });

  it("does not fold a dividend received after the episode closed, but still taxes it by year", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "10", price: "120", executedAt: new Date("2021-03-01") }),
      // Paid after the position was fully closed → outside every episode window.
      tx({ type: "dividend", quantity: "0", price: "30", executedAt: new Date("2021-09-01") }),
    ];
    const log = run(txns);
    expect(log.trades[0].dividends).toBe("0");
    expect(log.dividendsByYear).toEqual([{ year: 2021, amount: "30", tax: "0" }]);
  });

  it("sums withholding tax into dividendsByYear", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "dividend", quantity: "0", price: "40", tax: "10", executedAt: new Date("2021-06-01") }),
      tx({ type: "interest", instrumentId: null, quantity: "0", price: "5", executedAt: new Date("2021-07-01") }),
    ];
    const { dividendsByYear } = run(txns);
    expect(dividendsByYear).toEqual([{ year: 2021, amount: "45", tax: "10" }]);
  });
});

describe("computeTrades — Vorabpauschale accrual + disposal credit", () => {
  it("accrues a Vorabpauschale row into the open episode's vorabByYear, bucketed by its own year", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "4.18",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
    ];
    const { trades } = run(txns);
    expect(trades[0].vorabByYear).toEqual([{ year: 2026, amount: "4.18" }]);
  });

  it("credits the full accrued amount to a full-close sell (ratio = 1)", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "4.18",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      tx({ type: "sell", quantity: "10", price: "120", executedAt: new Date("2026-06-01") }),
    ];
    const { trades } = run(txns);
    const t = trades[0];
    expect(t.status).toBe("closed");
    expect(t.legs).toHaveLength(1);
    expect(t.legs[0].vorabCredit).toBe("4.18");
  });

  it("credits a partial sell proportionally, distributed across FIFO slices from multiple lots", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-02-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "10",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      // Sells 5 of 20 held (25%) — spans only the first lot (FIFO).
      tx({ type: "sell", quantity: "5", price: "120", executedAt: new Date("2026-06-01") }),
    ];
    const { trades } = run(txns, { method: "fifo" });
    const t = trades[0];
    expect(t.status).toBe("open");
    expect(t.legs).toHaveLength(1);
    // 5/20 of the 10 pool = 2.5
    expect(t.legs[0].vorabCredit).toBe("2.5");
  });

  it("distributes a partial sell's credit across multiple FIFO slices proportional to each slice's quantity", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-02-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "10",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      // Sells 15 of 20 held (75%) — consumes all of lot 1 (10) + 5 of lot 2.
      tx({ type: "sell", quantity: "15", price: "120", executedAt: new Date("2026-06-01") }),
    ];
    const { trades } = run(txns, { method: "fifo" });
    const t = trades[0];
    expect(t.legs).toHaveLength(2);
    // Total credit = 15/20 × 10 = 7.5, split 10:5 across the two slices → 5 and 2.5.
    const totalCredit = t.legs.reduce((s, l) => s + Number(l.vorabCredit), 0);
    expect(totalCredit).toBeCloseTo(7.5, 6);
    expect(t.legs[0].vorabCredit).toBe("5"); // slice qty 10/15 × 7.5
    expect(t.legs[1].vorabCredit).toBe("2.5"); // slice qty 5/15 × 7.5
  });

  it("credits the average method's single leg with the full sell's proportional credit", () => {
    const txns = [
      tx({ type: "buy", quantity: "20", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "10",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      tx({ type: "sell", quantity: "5", price: "120", executedAt: new Date("2026-06-01") }),
    ];
    const { trades } = run(txns, { method: "average" });
    expect(trades[0].legs).toHaveLength(1);
    expect(trades[0].legs[0].vorabCredit).toBe("2.5");
  });

  it("carries no residual pool into the next episode after a full close (drains to ~0)", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "4.18",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      tx({ type: "sell", quantity: "10", price: "120", executedAt: new Date("2026-06-01") }),
      // New episode, same instrument — must start with an empty pool.
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2026-07-01") }),
      tx({ type: "sell", quantity: "10", price: "120", executedAt: new Date("2026-12-01") }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(2);
    const secondEpisode = trades.find((t) => t.entryDate === "2026-07-01")!;
    expect(secondEpisode.legs[0].vorabCredit).toBe("0");
    expect(secondEpisode.vorabByYear).toEqual([]);
  });

  it("degrades a Vorabpauschale row with a null/zero base to a no-op (no accrual, no crash)", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: null,
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
      tx({ type: "sell", quantity: "10", price: "120", executedAt: new Date("2026-06-01") }),
    ];
    const { trades } = run(txns);
    expect(trades[0].vorabByYear).toEqual([]);
    expect(trades[0].legs[0].vorabCredit).toBe("0");
  });

  it("degrades a Vorabpauschale row with no shares held (no open episode) to a no-op", () => {
    // No prior buy — the accrual event precedes any holding, an edge case that should
    // never legitimately occur but must not crash.
    const txns = [
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "4.18",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(0);
  });

  it("converts a foreign-currency Vorabpauschale base to the display currency", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2025-01-01") }),
      tx({
        type: "tax",
        kind: "vorabpauschale",
        vorabBase: "10",
        currency: "USD",
        quantity: "0",
        price: "0",
        executedAt: new Date("2026-01-27"),
      }),
    ];
    const { trades } = run(txns, { fx: () => "0.9" });
    expect(trades[0].vorabByYear).toEqual([{ year: 2026, amount: "9" }]);
  });
});

describe("computeTrades — corporate actions (lot level)", () => {
  it("applies a 2:1 split: money invariant, per-share prices in current terms", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "20", price: "60", executedAt: new Date("2021-12-01") }),
    ];
    const cas: CorporateAction[] = [
      { instrumentId: INST, type: "split", ratio: "2", exDate: new Date("2021-06-01") },
    ];
    for (const method of ["average", "fifo"] as const) {
      const { trades } = run(txns, { corporateActions: cas, method });
      const t = trades[0];
      expect(t.realizedPnL).toBe("200"); // 1200 − 1000
      expect(t.quantity).toBe("20"); // current-share terms
      expect(t.avgEntryPrice).toBe("50"); // 1000 / 20 post-split
      expect(t.avgExitPrice).toBe("60");
    }
  });

  it("applies a bonus issue as zero-cost shares (cost basis unchanged)", () => {
    const txns = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "11", price: "100", executedAt: new Date("2021-12-01") }),
    ];
    const cas: CorporateAction[] = [
      // 1:10 bonus → ratio 0.1 → 10 shares become 11.
      { instrumentId: INST, type: "bonus", ratio: "0.1", exDate: new Date("2021-06-01") },
    ];
    const { trades } = run(txns, { corporateActions: cas });
    expect(trades[0].realizedPnL).toBe("100"); // 1100 − 1000
    expect(trades[0].quantity).toBe("11");
  });

  it("opens an episode for a `bonus` share receipt (free shares → full gain on exit)", () => {
    const txns = [
      // Zero-cost free shares (TR perk): the whole exit value is realized gain.
      tx({ type: "bonus", quantity: "5", price: "0", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "5", price: "100", executedAt: new Date("2021-06-01") }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(1);
    expect(trades[0].quantity).toBe("5");
    expect(trades[0].realizedPnL).toBe("500"); // 5*100 − 0
  });
});

describe("computeTrades — holding period & tax flags", () => {
  it("flags a position held ≥ 1 year as long-term", () => {
    const txns = [
      tx({ type: "buy", quantity: "1", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "1", price: "120", executedAt: new Date("2022-06-01") }),
    ];
    expect(run(txns).trades[0].longTerm).toBe(true);
  });

  it("flags a short hold as not long-term", () => {
    const txns = [
      tx({ type: "buy", quantity: "1", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "1", price: "120", executedAt: new Date("2021-03-01") }),
    ];
    const t = run(txns).trades[0];
    expect(t.longTerm).toBe(false);
    expect(t.holdingDays).toBe(59);
  });

  it("does not flag an equity held ≥ 1 year as long-term", () => {
    const txns = [
      tx({ type: "buy", quantity: "1", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "1", price: "120", executedAt: new Date("2022-06-01") }),
    ];
    const res = run(txns, {
      instruments: { [INST]: { assetClass: "equity" } },
    });
    expect(res.trades[0].longTerm).toBe(false);
  });
});

describe("computeTrades — costBasisMode (financed gold cicilan)", () => {
  const gold = "inst-gold";
  const txns: CoreTransaction[] = [
    { instrumentId: gold, type: "buy", quantity: "1", price: "1000", fees: "0", currency: "EUR", executedAt: new Date("2023-01-01"), loanId: "L1" },
    { instrumentId: gold, type: "fee", quantity: "0", price: "50", fees: "0", currency: "EUR", executedAt: new Date("2023-01-01"), loanId: "L1" },
    { instrumentId: gold, type: "loan_repayment", quantity: "0", price: "0", fees: "30", currency: "EUR", executedAt: new Date("2023-06-01"), loanId: "L1" },
  ];
  const prices = { [gold]: { price: "1000", currency: "EUR" } };

  it("capitalizes financing into the open invested under total_paid", () => {
    const tp = computeTrades({ transactions: txns, prices, displayCurrency: "EUR", costBasisMode: "total_paid", now: new Date("2024-01-01") });
    const t = tp.trades[0];
    expect(t.invested).toBe("1080"); // 1000 + 50 fee + 30 margin
    expect(t.unrealizedPnL).toBe("-80"); // mv 1000 − cost 1080
  });

  it("leaves invested at the purchase price under purchase_price (default)", () => {
    const pp = computeTrades({ transactions: txns, prices, displayCurrency: "EUR", now: new Date("2024-01-01") });
    expect(pp.trades[0].invested).toBe("1000");
    expect(pp.trades[0].unrealizedPnL).toBe("0");
  });
});

describe("computeTrades — multi-currency & dust", () => {
  it("converts realized P&L to the display currency", () => {
    const usd = "inst-usd";
    const txns: CoreTransaction[] = [
      { instrumentId: usd, type: "buy", quantity: "10", price: "100", fees: "0", currency: "USD", executedAt: new Date("2021-01-01") },
      { instrumentId: usd, type: "sell", quantity: "10", price: "130", fees: "0", currency: "USD", executedAt: new Date("2021-06-01") },
    ];
    const fx = (from: string, to: string) => (from === "USD" && to === "EUR" ? "0.9" : "1");
    const { trades } = computeTrades({
      transactions: txns,
      prices: { [usd]: { price: "130", currency: "USD" } },
      displayCurrency: "EUR",
      fx,
      now: new Date("2022-01-01"),
    });
    expect(trades[0].realizedPnL).toBe("270"); // 300 USD × 0.9
  });

  it("snaps an episode closed when the residual is below the dust tolerance", () => {
    const txns = [
      tx({ type: "buy", quantity: "1", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "0.9999999", price: "110", executedAt: new Date("2021-06-01") }),
    ];
    const { trades } = run(txns);
    expect(trades).toHaveLength(1);
    expect(trades[0].status).toBe("closed");
  });
});

describe("computeTrades — summary", () => {
  it("computes win rate over closed trades on total return (incl. dividends)", () => {
    const a = "inst-a";
    const b = "inst-b";
    const txns: CoreTransaction[] = [
      // Winner: bought, sold higher.
      { instrumentId: a, type: "buy", quantity: "10", price: "100", fees: "0", currency: "EUR", executedAt: new Date("2021-01-01") },
      { instrumentId: a, type: "sell", quantity: "10", price: "120", fees: "0", currency: "EUR", executedAt: new Date("2021-06-01") },
      // Loser: bought, sold lower.
      { instrumentId: b, type: "buy", quantity: "10", price: "100", fees: "0", currency: "EUR", executedAt: new Date("2021-01-01") },
      { instrumentId: b, type: "sell", quantity: "10", price: "80", fees: "0", currency: "EUR", executedAt: new Date("2021-06-01") },
    ];
    const log = computeTrades({
      transactions: txns,
      prices: {},
      displayCurrency: "EUR",
      now: new Date("2022-01-01"),
    });
    expect(log.trades).toHaveLength(2);
    expect(log.winRate).toBe(0.5);
    expect(log.totalRealized).toBe("0"); // +200 − 200
  });

  it("average-mode totalRealized reconciles with summarizePortfolio (the consistency guard)", () => {
    // Multi-episode: buy → partial sell → sell-all (close) → rebuy (open).
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2021-01-01") }),
      tx({ type: "sell", quantity: "4", price: "120", executedAt: new Date("2021-03-01") }),
      tx({ type: "sell", quantity: "6", price: "130", executedAt: new Date("2021-06-01") }),
      tx({ type: "buy", quantity: "5", price: "150", executedAt: new Date("2022-01-01") }),
    ];
    const prices = { [INST]: { price: "160", currency: "EUR" } };
    const log = computeTrades({
      transactions: txns,
      prices,
      displayCurrency: "EUR",
      now: new Date("2024-01-01"),
    });
    const summary = summarizePortfolio({ transactions: txns, prices, displayCurrency: "EUR" });
    // Same realized P&L as the dashboard engine — not a divergent third figure.
    expect(log.totalRealized).toBe(summary.totalRealizedPnL);
    expect(log.totalRealized).toBe("260"); // 80 (4@120) + 180 (6@130)
    expect(log.trades).toHaveLength(2); // closed episode + open rebuy
  });

  it("returns an empty log when there are no instrument transactions", () => {
    const log = computeTrades({
      transactions: [
        { instrumentId: null, type: "deposit", quantity: "0", price: "500", fees: "0", currency: "EUR", executedAt: new Date("2021-01-01") },
      ],
      prices: {},
      displayCurrency: "EUR",
    });
    expect(log.trades).toEqual([]);
    expect(log.winRate).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// avgHoldingDays — capital-weighted average holding period (issue #308)
// ---------------------------------------------------------------------------
// The "Annualized" figure is XIRR (money-weighted), not CAGR.  For a savings
// plan where capital is deployed gradually, XIRR ≈ totalReturn ÷ avgHoldingYears
// (dollar-weighted) NOT totalReturn ÷ calendarYears.  The mismatch makes the
// annualized figure look ~2× the "naive" expected rate next to the calendar
// period in the UI.  avgHoldingDays surfaces the reconciling denominator.
describe("computeTrades — avgHoldingDays (issue #308)", () => {
  // Savings-plan scenario: 7 equal monthly buys spread over ~1 year, then a
  // single closing sell.  This mirrors the ABBV pattern reported in the issue.
  const SP = "inst-savings";
  const buyDates = [
    "2023-01-01",
    "2023-03-01",
    "2023-05-01",
    "2023-07-01",
    "2023-09-01",
    "2023-11-01",
    "2024-01-01",
  ];
  const savingsPlanTxns: CoreTransaction[] = [
    ...buyDates.map((d) => ({
      instrumentId: SP,
      type: "buy" as const,
      quantity: "1",
      price: "100",
      fees: "0",
      currency: "EUR",
      executedAt: new Date(d),
    })),
    // Sell all 7 shares at a small gain ~2 months after the last buy.
    {
      instrumentId: SP,
      type: "sell" as const,
      quantity: "7",
      price: "101",
      fees: "0",
      currency: "EUR",
      executedAt: new Date("2024-03-01"),
    },
  ];

  it("lump-sum: avgHoldingDays equals holdingDays exactly", () => {
    // A single buy followed by a single sell — no gradual deployment.
    // avgHoldingDays must equal holdingDays: the formula should not diverge here.
    const txns: CoreTransaction[] = [
      {
        instrumentId: SP,
        type: "buy",
        quantity: "7",
        price: "100",
        fees: "0",
        currency: "EUR",
        executedAt: new Date("2023-01-01"),
      },
      {
        instrumentId: SP,
        type: "sell",
        quantity: "7",
        price: "101",
        fees: "0",
        currency: "EUR",
        executedAt: new Date("2024-03-01"),
      },
    ];
    const { trades } = computeTrades({
      transactions: txns,
      prices: {},
      displayCurrency: "EUR",
      now: new Date("2024-06-01"),
    });
    expect(trades).toHaveLength(1);
    const t = trades[0];
    // For a single buy + single sell the weighted average equals the calendar period.
    expect(t.avgHoldingDays).toBe(t.holdingDays);
  });

  it("savings plan: avgHoldingDays is materially shorter than holdingDays", () => {
    // Capital deployed gradually → dollar-weighted average holding < calendar holding.
    const { trades } = computeTrades({
      transactions: savingsPlanTxns,
      prices: {},
      displayCurrency: "EUR",
      now: new Date("2024-06-01"),
    });
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.status).toBe("closed");
    // Calendar period: 2023-01-01 → 2024-03-01 ≈ 425 days
    expect(t.holdingDays).toBeGreaterThan(400);
    // Weighted average must be shorter because the later tranches had less time invested.
    expect(t.avgHoldingDays).toBeLessThan(t.holdingDays);
    // Weighted average should be roughly half the calendar period (equal tranches,
    // equally spaced → avg is near the midpoint of the deployment window).
    expect(t.avgHoldingDays).toBeLessThan(t.holdingDays * 0.75);
    expect(t.avgHoldingDays).toBeGreaterThan(0);
  });

  it("savings plan: annualizedPct materially exceeds naive CAGR (totalReturn ÷ calendar)", () => {
    // This is the core invariant from issue #308: XIRR > totalReturn ÷ calendarYears
    // because money-weighting recognises that most capital was deployed near the end.
    const { trades } = computeTrades({
      transactions: savingsPlanTxns,
      prices: {},
      displayCurrency: "EUR",
      now: new Date("2024-06-01"),
    });
    const t = trades[0];
    const naiveCagr = (t.totalReturnPct ?? 0) / (t.holdingDays / 365);
    // XIRR should noticeably exceed the naive CAGR for a gradual savings plan.
    expect(t.annualizedPct).not.toBeNull();
    expect(t.annualizedPct!).toBeGreaterThan(naiveCagr * 1.3);
  });

  it("savings plan: totalReturn ÷ avgHoldingYears approximates annualizedPct", () => {
    // The reconciliation that resolves issue #308: once you substitute the
    // capital-weighted holding period for the calendar period, the implied
    // annualized return converges to the XIRR.
    const { trades } = computeTrades({
      transactions: savingsPlanTxns,
      prices: {},
      displayCurrency: "EUR",
      now: new Date("2024-06-01"),
    });
    const t = trades[0];
    const impliedAnn = (t.totalReturnPct ?? 0) / (t.avgHoldingDays / 365);
    // Should be within 20 % of the actual XIRR (loose tolerance — both metrics
    // capture the same economic reality but use different mathematical approaches).
    expect(Math.abs(impliedAnn - t.annualizedPct!)).toBeLessThan(
      Math.abs(t.annualizedPct!) * 0.2,
    );
  });

  it("open unpriced position falls back to holdingDays (no misleading 0d avg)", () => {
    // If a position has no current price and no dividends, inflows are empty.
    // avgHoldingYears would be ≤0; we must fall back to holdingDays rather than
    // rendering "0d avg" next to a multi-year calendar hold.
    const txns: CoreTransaction[] = [
      {
        instrumentId: SP,
        type: "buy",
        quantity: "1",
        price: "100",
        fees: "0",
        currency: "EUR",
        executedAt: new Date("2022-01-01"),
      },
    ];
    const { trades } = computeTrades({
      transactions: txns,
      prices: {}, // no price → no terminal MV flow → inflows empty
      displayCurrency: "EUR",
      now: new Date("2024-06-01"),
    });
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.status).toBe("open");
    // Must fall back to holdingDays, not 0.
    expect(t.avgHoldingDays).toBe(t.holdingDays);
    expect(t.avgHoldingDays).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-currency: cost ccy (EUR) ≠ quote ccy (USD)
// ---------------------------------------------------------------------------
// Regression for the PEP bug: a USD-quoted US stock bought in EUR via a
// European broker had its EUR cost basis incorrectly treated as USD, producing
// a large overstatement of invested/totalReturn and a misleadingly negative
// annualizedPct. After the fix both measures agree on sign.
describe("cross-currency trade — USD-quoted, EUR-bought (PEP scenario)", () => {
  const PEP = "inst-pep";
  const NOW = new Date("2026-06-20");

  // Real production values:
  //   buy 0.196633 sh × €127.14 + €1 fee = €26.00 cost
  //   3 × €0.18 dividend = €0.54
  //   market value: 0.196633 × $142.02 = $27.93 USD; at 0.8708 → €24.32
  //   true EUR total return ≈ 24.32 + 0.54 − 26.00 = −1.14 (a real loss)
  const buyTx: CoreTransaction = {
    instrumentId: PEP, type: "buy",
    quantity: "0.196633", price: "127.14", fees: "1",
    currency: "EUR", executedAt: new Date("2025-08-26"),
  };
  const div = (date: string): CoreTransaction => ({
    instrumentId: PEP, type: "dividend",
    quantity: "0", price: "0.18", fees: "0",
    currency: "EUR", executedAt: new Date(date),
  });
  const prices = { [PEP]: { price: "142.02", currency: "USD" } };
  const fx = (from: string, to: string): string => {
    if (from === "USD" && to === "EUR") return "0.8708";
    if (from === "EUR" && to === "USD") return "1.1484";
    return "1";
  };

  it("invested is in EUR (cost ccy), not USD-treated-as-EUR", () => {
    const { trades } = computeTrades({
      transactions: [buyTx],
      prices,
      displayCurrency: "EUR",
      fx,
      now: NOW,
    });
    expect(trades).toHaveLength(1);
    const t = trades[0];
    // Cost basis ≈ €26.00 (not €22.64 which was the bug)
    expect(Number(t.invested)).toBeCloseTo(26.00, 1);
    // currency label should be EUR (the trade currency), not USD
    expect(t.currency).toBe("EUR");
  });

  it("totalReturn is negative in EUR for a position actually under water", () => {
    const { trades } = computeTrades({
      transactions: [buyTx, div("2025-09-30"), div("2026-01-06"), div("2026-03-31")],
      prices,
      displayCurrency: "EUR",
      fx,
      now: NOW,
    });
    const t = trades[0];
    // Total return = MV (≈24.32) + dividends (0.54) − invested (26.00) ≈ −1.14
    expect(Number(t.totalReturn)).toBeLessThan(0);
    // annualizedPct should also be negative (consistent with totalReturn sign)
    expect(t.annualizedPct).toBeLessThan(0);
    // totalReturnPct should be negative
    expect(t.totalReturnPct).toBeLessThan(0);
  });

  it("same-currency position (EUR/EUR) is unaffected — no regression", () => {
    const I = "inst-eur";
    const { trades } = computeTrades({
      transactions: [{
        instrumentId: I, type: "buy",
        quantity: "10", price: "100", fees: "0",
        currency: "EUR", executedAt: new Date("2024-01-01"),
      }],
      prices: { [I]: { price: "120", currency: "EUR" } },
      displayCurrency: "EUR",
      now: NOW,
    });
    expect(trades).toHaveLength(1);
    const t = trades[0];
    expect(t.invested).toBe("1000");
    expect(Number(t.unrealizedPnL)).toBeCloseTo(200, 0);
    expect(t.currency).toBe("EUR");
  });
});
