import { describe, it, expect } from "vitest";
import {
  computeHoldings,
  marketValue,
  unrealizedPnL,
  cashBalances,
  cashFlow,
  xirr,
  netWorth,
  type CoreTransaction,
  type CorporateAction,
} from "../src/index.js";

const AAPL = "inst-aapl";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: AAPL,
    type: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "IDR",
    executedAt: new Date("2026-01-01"),
    ...p,
  };
}

describe("computeHoldings", () => {
  it("computes average cost and realized P&L", () => {
    const txs: CoreTransaction[] = [
      tx({ type: "buy", quantity: "100", price: "9500", executedAt: new Date("2026-01-01") }),
      tx({ type: "buy", quantity: "100", price: "10500", executedAt: new Date("2026-01-02") }),
      tx({ type: "sell", quantity: "50", price: "11000", executedAt: new Date("2026-01-03") }),
    ];
    const [h] = computeHoldings(txs);
    expect(h.quantity).toBe("150");
    expect(h.avgCost).toBe("10000");
    expect(h.costBasis).toBe("1500000");
    expect(h.realizedPnL).toBe("50000"); // 50 * (11000 - 10000)
  });

  it("folds fees into cost basis", () => {
    const [h] = computeHoldings([tx({ type: "buy", quantity: "10", price: "100", fees: "5" })]);
    expect(h.costBasis).toBe("1005");
    expect(h.avgCost).toBe("100.5");
  });

  it("applies a 2:1 split (qty doubles, basis unchanged)", () => {
    const txs: CoreTransaction[] = [
      tx({ type: "buy", quantity: "150", price: "10000", executedAt: new Date("2026-01-01") }),
    ];
    const cas: CorporateAction[] = [
      { instrumentId: AAPL, type: "split", ratio: "2", exDate: new Date("2026-02-01") },
    ];
    const [h] = computeHoldings(txs, cas);
    expect(h.quantity).toBe("300");
    expect(h.avgCost).toBe("5000");
    expect(h.costBasis).toBe("1500000");
  });

  it("applies a 1:10 bonus issue", () => {
    const [h] = computeHoldings(
      [tx({ type: "buy", quantity: "100", price: "1000", executedAt: new Date("2026-01-01") })],
      [{ instrumentId: AAPL, type: "bonus", ratio: "0.1", exDate: new Date("2026-02-01") }],
    );
    expect(h.quantity).toBe("110");
    expect(h.costBasis).toBe("100000");
  });
});

describe("marketValue / unrealizedPnL", () => {
  it("computes market value and unrealized P&L", () => {
    expect(marketValue("150", "11000")).toBe("1650000");
    expect(unrealizedPnL("150", "11000", "1500000")).toBe("150000");
  });
});

describe("cashBalances", () => {
  it("derives per-currency cash from all flows", () => {
    const txs: CoreTransaction[] = [
      tx({ type: "deposit", instrumentId: null, price: "5000000" }),
      tx({ type: "buy", quantity: "100", price: "9500", fees: "1000" }), // -951000
      tx({ type: "sell", quantity: "50", price: "11000", fees: "500" }), // +549500
      tx({ type: "dividend", instrumentId: AAPL, quantity: "0", price: "25000" }), // +25000
      tx({ type: "deposit", instrumentId: null, price: "1000", currency: "EUR" }),
    ];
    const balances = cashBalances(txs);
    expect(balances.IDR).toBe("4623500"); // 5,000,000 - 951,000 + 549,500 + 25,000
    expect(balances.EUR).toBe("1000");
  });
});

describe("xirr", () => {
  it("returns ~10% for a one-year 1000 -> 1100", () => {
    const r = xirr([
      { amount: -1000, date: new Date("2025-01-01") },
      { amount: 1100, date: new Date("2026-01-01") },
    ]);
    expect(r).toBeCloseTo(0.1, 3);
  });

  it("handles multiple contributions", () => {
    const r = xirr([
      { amount: -1000, date: new Date("2025-01-01") },
      { amount: -1000, date: new Date("2025-07-01") },
      { amount: 2200, date: new Date("2026-01-01") },
    ]);
    expect(r).toBeGreaterThan(0);
    expect(Number.isFinite(r)).toBe(true);
  });

  it("returns NaN without both an inflow and an outflow", () => {
    expect(
      Number.isNaN(
        xirr([
          { amount: -100, date: new Date("2025-01-01") },
          { amount: -200, date: new Date("2026-01-01") },
        ]),
      ),
    ).toBe(true);
  });
});

describe("cashFlow", () => {
  const base = { instrumentId: AAPL, quantity: "0", price: "0", fees: "0", currency: "IDR", executedAt: new Date() };
  it("signs each transaction type correctly", () => {
    expect(cashFlow({ ...base, type: "deposit", price: "1000" }).toString()).toBe("1000");
    expect(cashFlow({ ...base, type: "withdrawal", price: "1000" }).toString()).toBe("-1000");
    expect(cashFlow({ ...base, type: "buy", quantity: "10", price: "100", fees: "5" }).toString()).toBe("-1005");
    expect(cashFlow({ ...base, type: "savings_plan", quantity: "10", price: "100" }).toString()).toBe("-1000");
    expect(cashFlow({ ...base, type: "sell", quantity: "10", price: "100", fees: "5" }).toString()).toBe("995");
    expect(cashFlow({ ...base, type: "dividend", quantity: "0", price: "250" }).toString()).toBe("250");
    expect(cashFlow({ ...base, type: "dividend", quantity: "10", price: "25" }).toString()).toBe("250");
    expect(cashFlow({ ...base, type: "coupon", price: "300" }).toString()).toBe("300");
    expect(cashFlow({ ...base, type: "fee", price: "20" }).toString()).toBe("-20");
    expect(cashFlow({ ...base, type: "split", fees: "0" }).toString()).toBe("0");
    expect(cashFlow({ ...base, type: "bonus" }).toString()).toBe("0");
    expect(cashFlow({ ...base, type: "rights", fees: "10" }).toString()).toBe("-10");
  });
});

describe("xirr (extreme / fallback)", () => {
  it("returns a finite negative rate for a near-total loss", () => {
    const r = xirr([
      { amount: -1000, date: new Date("2025-01-01") },
      { amount: 1, date: new Date("2026-01-01") },
    ]);
    expect(Number.isFinite(r)).toBe(true);
    expect(r).toBeLessThan(0);
  });
  it("returns NaN for fewer than two points", () => {
    expect(Number.isNaN(xirr([{ amount: -1, date: new Date() }]))).toBe(true);
  });
});

describe("netWorth", () => {
  it("skips holdings without a price and defaults FX to 1", () => {
    const value = netWorth({
      holdings: [
        { instrumentId: AAPL, quantity: "10", avgCost: "100", costBasis: "1000", realizedPnL: "0" },
        { instrumentId: "no-price", quantity: "5", avgCost: "1", costBasis: "5", realizedPnL: "0" },
      ],
      prices: { [AAPL]: { price: "150", currency: "IDR" } },
      cash: { IDR: "500" },
      displayCurrency: "IDR",
    });
    // 10*150 + 500 (the no-price holding is skipped)
    expect(value).toBe("2000");
  });

  it("sums holdings (FX-converted) and cash in the display currency", () => {
    const value = netWorth({
      holdings: [
        { instrumentId: AAPL, quantity: "300", avgCost: "5000", costBasis: "1500000", realizedPnL: "0" },
      ],
      prices: { [AAPL]: { price: "11000", currency: "IDR" } },
      cash: { IDR: "1000000", EUR: "100" },
      displayCurrency: "IDR",
      fx: (from, to) => (from === "EUR" && to === "IDR" ? "17000" : "1"),
    });
    // 300*11000 + 1,000,000 + 100*17000 = 3,300,000 + 1,000,000 + 1,700,000
    expect(value).toBe("6000000");
  });
});
