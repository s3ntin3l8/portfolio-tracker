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
