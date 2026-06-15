import { describe, it, expect } from "vitest";
import {
  computeHoldings,
  marketValue,
  unrealizedPnL,
  cashBalances,
  cashFlow,
  xirr,
  netWorth,
  summarizePortfolio,
  aggregatePortfolios,
  type CoreTransaction,
  type CorporateAction,
  type PortfolioSummary,
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

describe("summarizePortfolio", () => {
  const I1 = "inst-1";
  const I2 = "inst-2";

  function mk(p: Partial<CoreTransaction>): CoreTransaction {
    return {
      instrumentId: I1,
      type: "buy",
      quantity: "0",
      price: "0",
      fees: "0",
      currency: "IDR",
      executedAt: new Date("2026-01-01"),
      ...p,
    };
  }

  it("values holdings, cash, P&L and net worth", () => {
    const txs: CoreTransaction[] = [
      mk({ type: "deposit", instrumentId: null, price: "5000000" }),
      mk({ type: "buy", quantity: "100", price: "9500", executedAt: new Date("2026-01-02") }),
      mk({ type: "buy", quantity: "100", price: "10500", executedAt: new Date("2026-01-03") }),
      mk({ type: "sell", quantity: "50", price: "11000", executedAt: new Date("2026-01-04") }),
      // unpriced holding — returned but excluded from market-value totals
      mk({ type: "buy", instrumentId: I2, quantity: "10", price: "100", executedAt: new Date("2026-01-05") }),
    ];

    const summary = summarizePortfolio({
      transactions: txs,
      prices: { [I1]: { price: "11000", currency: "IDR" } },
      displayCurrency: "IDR",
    });

    const h1 = summary.holdings.find((h) => h.instrumentId === I1)!;
    expect(h1.marketValue).toBe("1650000"); // 150 * 11000
    expect(h1.unrealizedPnL).toBe("150000"); // 1,650,000 - 1,500,000
    expect(h1.realizedPnL).toBe("50000");

    expect(h1.dayChange).toBeNull(); // priced, but no previous close given

    const h2 = summary.holdings.find((h) => h.instrumentId === I2)!;
    expect(h2.marketValue).toBeNull(); // no price

    // 5,000,000 - 950,000 - 1,050,000 + 550,000 - 1,000 (the I2 buy)
    expect(summary.cash.IDR).toBe("3549000");
    expect(summary.totalCost).toBe("1500000"); // priced holdings only
    expect(summary.totalMarketValue).toBe("1650000");
    expect(summary.totalUnrealizedPnL).toBe("150000");
    expect(summary.totalRealizedPnL).toBe("50000");
    expect(summary.netWorth).toBe("5199000"); // 1,650,000 + 3,549,000
  });

  it("sums dividend and coupon cash as total income", () => {
    const summary = summarizePortfolio({
      transactions: [
        mk({ type: "dividend", quantity: "0", price: "25000" }),
        mk({ type: "coupon", instrumentId: I2, price: "37500" }),
        mk({ type: "buy", quantity: "10", price: "9500" }), // not income
      ],
      prices: {},
      displayCurrency: "IDR",
    });
    expect(summary.totalIncome).toBe("62500"); // 25,000 + 37,500
  });

  it("computes per-holding and total day change, FX-converting the total", () => {
    const summary = summarizePortfolio({
      transactions: [
        mk({ type: "buy", quantity: "100", price: "9000" }), // I1, IDR
        mk({ type: "buy", instrumentId: I2, quantity: "10", price: "100" }), // I2, USD
      ],
      prices: {
        [I1]: { price: "9500", currency: "IDR", previousClose: "9000" },
        [I2]: { price: "110", currency: "USD", previousClose: "100" },
      },
      displayCurrency: "IDR",
      fx: (from, to) => (from === "USD" && to === "IDR" ? "16000" : "1"),
    });

    const h1 = summary.holdings.find((h) => h.instrumentId === I1)!;
    expect(h1.dayChange).toBe("50000"); // 100 * (9500 − 9000)
    expect(Number(h1.dayChangePct)).toBeCloseTo(5.5556, 3); // 500/9000

    const h2 = summary.holdings.find((h) => h.instrumentId === I2)!;
    expect(h2.dayChange).toBe("100"); // 10 * (110 − 100) USD
    expect(h2.dayChangePct).toBe("10");

    // Total in IDR: 50,000 + 100 × 16,000.
    expect(summary.totalDayChange).toBe("1650000");
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

describe("aggregatePortfolios", () => {
  const mk = (over: Partial<PortfolioSummary>): PortfolioSummary => ({
    displayCurrency: "IDR",
    holdings: [],
    cash: {},
    netWorth: "0",
    totalCost: "0",
    totalMarketValue: "0",
    totalUnrealizedPnL: "0",
    totalRealizedPnL: "0",
    totalIncome: "0",
    totalDayChange: "0",
    ...over,
  });

  it("merges holdings by instrument, cash by currency, and sums totals", () => {
    const a = mk({
      holdings: [
        {
          instrumentId: "i1",
          quantity: "100",
          avgCost: "9000",
          costBasis: "900000",
          realizedPnL: "0",
          price: "9500",
          currency: "IDR",
          marketValue: "950000",
          unrealizedPnL: "50000",
          previousClose: "9000",
          dayChange: "50000",
          dayChangePct: "5",
        },
      ],
      cash: { IDR: "1000000" },
      netWorth: "1950000",
      totalCost: "900000",
      totalMarketValue: "950000",
      totalUnrealizedPnL: "50000",
      totalRealizedPnL: "0",
      totalDayChange: "50000",
    });
    const b = mk({
      holdings: [
        {
          instrumentId: "i1",
          quantity: "100",
          avgCost: "9500",
          costBasis: "950000",
          realizedPnL: "10000",
          price: "9500",
          currency: "IDR",
          marketValue: "950000",
          unrealizedPnL: "0",
          previousClose: "9000",
          dayChange: "50000",
          dayChangePct: "5",
        },
        {
          instrumentId: "i2",
          quantity: "5",
          avgCost: "1000000",
          costBasis: "5000000",
          realizedPnL: "0",
          price: "1150000",
          currency: "IDR",
          marketValue: "5750000",
          unrealizedPnL: "750000",
          previousClose: "1100000",
          dayChange: "250000",
          dayChangePct: "4.5",
        },
      ],
      cash: { IDR: "500000", USD: "100" },
      netWorth: "7200000",
      totalCost: "5950000",
      totalMarketValue: "6700000",
      totalUnrealizedPnL: "750000",
      totalRealizedPnL: "10000",
      totalDayChange: "300000",
    });

    const out = aggregatePortfolios([a, b], "IDR");

    const i1 = out.holdings.find((h) => h.instrumentId === "i1")!;
    expect(i1.quantity).toBe("200"); // 100 + 100
    expect(i1.costBasis).toBe("1850000"); // 900k + 950k
    expect(i1.avgCost).toBe("9250"); // 1,850,000 / 200
    expect(i1.marketValue).toBe("1900000"); // 950k + 950k
    expect(i1.realizedPnL).toBe("10000");
    expect(i1.dayChange).toBe("100000"); // 50k + 50k (same instrument, summed)
    expect(i1.dayChangePct).toBe("5"); // per-share pct carried, not summed
    expect(out.holdings).toHaveLength(2); // i1 merged, i2 distinct

    expect(out.cash).toEqual({ IDR: "1500000", USD: "100" });
    expect(out.netWorth).toBe("9150000"); // 1,950,000 + 7,200,000
    expect(out.totalCost).toBe("6850000");
    expect(out.totalUnrealizedPnL).toBe("800000"); // totalMV − totalCost
    expect(out.totalRealizedPnL).toBe("10000");
    expect(out.totalDayChange).toBe("350000"); // 50,000 + 300,000
  });

  it("handles an empty list", () => {
    const out = aggregatePortfolios([], "IDR");
    expect(out.netWorth).toBe("0");
    expect(out.holdings).toEqual([]);
  });
});
