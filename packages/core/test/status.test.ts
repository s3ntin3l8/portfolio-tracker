import { describe, it, expect } from "vitest";
import {
  cashFlow,
  cashBalances,
  computeHoldings,
  contributionStats,
  computeTrades,
  type CoreTransaction,
} from "../src/index.js";

const INST = "inst-x";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: INST,
    type: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-01-01"),
    ...p,
  };
}

describe("transaction status — cashFlow", () => {
  it("cash_neutral buy contributes only -fees (reward funds the principal)", () => {
    const t = tx({ type: "buy", quantity: "2", price: "10", fees: "1", status: "cash_neutral" });
    expect(cashFlow(t).toString()).toBe("-1");
  });

  it("cash_neutral with zero fees is exactly cash-neutral", () => {
    const t = tx({ type: "buy", quantity: "3", price: "7", fees: "0", status: "cash_neutral" });
    expect(cashFlow(t).toString()).toBe("0");
  });

  it("archived row has zero cash effect regardless of type", () => {
    expect(cashFlow(tx({ type: "buy", quantity: "2", price: "10", status: "archived" })).toString()).toBe("0");
    expect(cashFlow(tx({ type: "dividend", price: "50", status: "archived" })).toString()).toBe("0");
    expect(cashFlow(tx({ type: "deposit", price: "100", status: "archived" })).toString()).toBe("0");
  });

  it("normal buy is unchanged (-notional - fees)", () => {
    const t = tx({ type: "buy", quantity: "2", price: "10", fees: "1", status: "normal" });
    expect(cashFlow(t).toString()).toBe("-21");
  });
});

describe("transaction status — cashBalances", () => {
  it("excludes archived and only books fees for cash_neutral", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "deposit", instrumentId: null, price: "1000" }),
      tx({ type: "buy", quantity: "2", price: "100", fees: "1", status: "cash_neutral" }), // -1
      tx({ type: "buy", quantity: "5", price: "999", status: "archived" }), // ignored
    ];
    // 1000 - 1 = 999 (the archived -4995 buy is ignored, the cash_neutral buy costs only the fee)
    expect(cashBalances(txns).EUR).toBe("999");
  });
});

describe("transaction status — computeHoldings", () => {
  it("cash_neutral buy still builds shares and cost basis", () => {
    const holdings = computeHoldings([
      tx({ type: "buy", quantity: "4", price: "5", status: "cash_neutral" }),
    ]);
    expect(holdings).toHaveLength(1);
    expect(holdings[0].quantity).toBe("4");
    expect(holdings[0].costBasis).toBe("20");
  });

  it("archived buy is excluded from holdings entirely", () => {
    const holdings = computeHoldings([
      tx({ type: "buy", quantity: "4", price: "5", status: "archived" }),
    ]);
    expect(holdings).toHaveLength(0);
  });
});

describe("transaction status — contributions (outside boundary)", () => {
  it("cash_neutral acquisition is not a contribution but still builds the cost pool", () => {
    const stats = contributionStats({
      txns: [
        tx({ type: "buy", quantity: "10", price: "10", status: "cash_neutral", executedAt: new Date("2026-01-10") }),
      ],
      displayCurrency: "EUR",
      boundary: "outside",
    });
    expect(stats.totalContributed).toBe("0");

    // The pool it built is drawn down by a later sell (no phantom gain).
    const withSell = contributionStats({
      txns: [
        tx({ type: "buy", quantity: "10", price: "10", status: "cash_neutral", executedAt: new Date("2026-01-10") }),
        tx({ type: "sell", quantity: "10", price: "12", executedAt: new Date("2026-02-10") }),
      ],
      displayCurrency: "EUR",
      boundary: "outside",
    });
    // inflow 0, outflow = 10 units * avg cost 10 = 100 → net -100.
    expect(withSell.netContributed).toBe("-100");
  });

  it("archived acquisition is excluded from contributions", () => {
    const stats = contributionStats({
      txns: [
        tx({ type: "buy", quantity: "10", price: "10", status: "archived", executedAt: new Date("2026-01-10") }),
      ],
      displayCurrency: "EUR",
      boundary: "outside",
    });
    expect(stats.totalContributed).toBe("0");
    expect(stats.netContributed).toBe("0");
  });
});

describe("transaction status — computeTrades", () => {
  it("archived trades are excluded from the trade log", () => {
    const log = computeTrades({
      transactions: [
        tx({ type: "buy", quantity: "5", price: "10", executedAt: new Date("2026-01-01"), status: "archived" }),
        tx({ type: "sell", quantity: "5", price: "20", executedAt: new Date("2026-02-01"), status: "archived" }),
      ],
      displayCurrency: "EUR",
    });
    expect(log.trades).toHaveLength(0);
  });
});
