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
  projectCoupons,
  projectDividends,
  trailingIncomeByInstrument,
  trailingYield,
  type BondPosition,
  type CoreTransaction,
  type CorporateAction,
  type IncomeEntry,
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

  it("throws when one instrument has transactions in multiple currencies", () => {
    const txs: CoreTransaction[] = [
      tx({ type: "buy", quantity: "10", price: "100", currency: "USD" }),
      tx({ type: "buy", quantity: "10", price: "950", currency: "EUR", executedAt: new Date("2026-01-02") }),
    ];
    expect(() => computeHoldings(txs)).toThrow(/multiple currencies/);
  });

  it("excludes transactions after the asOf cutoff", () => {
    const txs: CoreTransaction[] = [
      tx({ type: "buy", quantity: "100", price: "9500", executedAt: new Date("2025-03-01") }),
      tx({ type: "buy", quantity: "50",  price: "10000", executedAt: new Date("2025-09-01") }), // after cutoff
    ];
    const cutoff = new Date("2025-06-30");
    const [h] = computeHoldings(txs, [], cutoff);
    // Only the March buy should be included.
    expect(h.quantity).toBe("100");
    expect(h.costBasis).toBe("950000");
  });

  it("applies all corporate actions even when asOf precedes the ex-date (split-consistent qty)", () => {
    // 100 shares bought in January; 2:1 split in June; asOf in March (before split).
    // The result should be 200 (split applied to historical qty) so that the ratio
    // 200 / currentQty=200 = 1 correctly reflects "same position, just post-split terms".
    const txs: CoreTransaction[] = [
      tx({ type: "buy", quantity: "100", price: "10000", executedAt: new Date("2025-01-01") }),
    ];
    const cas: CorporateAction[] = [
      { instrumentId: AAPL, type: "split", ratio: "2", exDate: new Date("2025-06-01") },
    ];
    const cutoff = new Date("2025-03-01"); // before the split
    const [h] = computeHoldings(txs, cas, cutoff);
    // All splits applied → 100 × 2 = 200, expressed in current share terms.
    expect(h.quantity).toBe("200");
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

  it("exposes per-holding value/cost in the display currency (#94)", () => {
    const summary = summarizePortfolio({
      transactions: [
        mk({ type: "buy", instrumentId: I2, quantity: "10", price: "100", currency: "USD" }), // USD, priced
        mk({ type: "buy", instrumentId: I1, quantity: "5", price: "300", currency: "IDR" }), // unpriced
      ],
      prices: { [I2]: { price: "110", currency: "USD" } },
      displayCurrency: "IDR",
      fx: (from, to) => (from === "USD" && to === "IDR" ? "16000" : "1"),
    });

    const h2 = summary.holdings.find((h) => h.instrumentId === I2)!;
    // Native (unchanged): value/cost in USD.
    expect(h2.marketValue).toBe("1100"); // 10 × 110
    expect(h2.costBasis).toBe("1000"); // 10 × 100
    // Display (× 16,000 IDR/USD).
    expect(h2.marketValueDisplay).toBe("17600000");
    expect(h2.costBasisDisplay).toBe("16000000");
    expect(h2.unrealizedPnLDisplay).toBe("1600000"); // 17.6M − 16M

    // Unpriced: value/P&L unknown; cost basis falls back to native (best effort).
    const h1 = summary.holdings.find((h) => h.instrumentId === I1)!;
    expect(h1.marketValueDisplay).toBeNull();
    expect(h1.unrealizedPnLDisplay).toBeNull();
    expect(h1.costBasisDisplay).toBe(h1.costBasis); // "1500"
  });

  it("breaks exposure down by currency (holdings + cash) in display currency", () => {
    const summary = summarizePortfolio({
      transactions: [
        mk({ type: "deposit", instrumentId: null, currency: "IDR", price: "1000000" }),
        mk({ type: "deposit", instrumentId: null, currency: "USD", price: "200" }),
        mk({ type: "buy", quantity: "100", price: "9000", currency: "IDR" }), // I1, IDR
        mk({ type: "buy", instrumentId: I2, quantity: "10", price: "100", currency: "USD" }), // I2, USD
      ],
      prices: {
        [I1]: { price: "9500", currency: "IDR" },
        [I2]: { price: "110", currency: "USD" },
      },
      displayCurrency: "IDR",
      fx: (from, to) => (from === "USD" && to === "IDR" ? "16000" : "1"),
    });

    // IDR: holding 100×9500=950,000 + cash (1,000,000 − 900,000)=100,000 → 1,050,000.
    expect(summary.exposureByCurrency.IDR).toBe("1050000");
    // USD: holding 10×110=1,100 + cash (200 − 1,000)=−800 → ×16,000 = 4,800,000.
    expect(summary.exposureByCurrency.USD).toBe("4800000");
  });
});

describe("projectCoupons", () => {
  const bond = (over: Partial<BondPosition> = {}): BondPosition => ({
    instrumentId: "ori",
    symbol: "ORI023",
    quantity: "10",
    faceValue: "1000000",
    couponRate: "0.06",
    couponSchedule: "semiannual",
    maturityDate: "2027-06-10",
    currency: "IDR",
    ...over,
  });

  const now = new Date("2026-06-15T00:00:00.000Z");

  it("projects semiannual coupons anchored to maturity within the horizon", () => {
    const coupons = projectCoupons([bond()], 12, now);
    // Coupon dates step back from 2027-06-10 by 6 months: 2026-12-10 and 2027-06-10.
    expect(coupons.map((c) => c.date)).toEqual(["2026-12-10", "2027-06-10"]);
    // 1,000,000 × 10 × 0.06 ÷ 2 per period.
    expect(coupons[0].amount).toBe("300000");
    expect(coupons[0].symbol).toBe("ORI023");
  });

  it("skips zero-quantity positions and unparseable maturities", () => {
    expect(projectCoupons([bond({ quantity: "0" })], 12, now)).toHaveLength(0);
    expect(projectCoupons([bond({ maturityDate: "n/a" })], 12, now)).toHaveLength(0);
  });

  it("accepts an explicit Date horizon and collects only coupons up to that date", () => {
    // Dec 31 of the current year: only the 2026-12-10 coupon falls within; 2027-06-10 does not.
    const yearEnd = new Date(Date.UTC(2026, 11, 31));
    const coupons = projectCoupons([bond()], yearEnd, now);
    expect(coupons.map((c) => c.date)).toEqual(["2026-12-10"]);
  });
});

describe("projectDividends", () => {
  const now = new Date("2026-06-15T00:00:00.000Z");

  const entry = (over: Partial<IncomeEntry>): IncomeEntry => ({
    instrumentId: "bbca",
    symbol: "BBCA",
    name: "BCA",
    assetClass: "equity",
    type: "dividend",
    price: "100000",
    currency: "IDR",
    executedAt: new Date("2025-09-01T00:00:00.000Z"),
    ...over,
  });

  it("projects last year's payment into the same future window (+1 year)", () => {
    const heldQty = new Map([["bbca", "100"]]);
    // Same qty then and now → amount unchanged.
    const qtyAt = () => "100";
    const result = projectDividends([entry()], heldQty, qtyAt, now);
    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-09-01");
    expect(result[0].amount).toBe("100000");
    expect(result[0].basisYear).toBe(2025);
  });

  it("scales amount when current qty differs from historical qty", () => {
    // Bought more shares: 100 → 150. Projected = 100000 × (150/100) = 150000.
    const heldQty = new Map([["bbca", "150"]]);
    const qtyAt = () => "100";
    const [r] = projectDividends([entry()], heldQty, qtyAt, now);
    expect(r.amount).toBe("150000");
  });

  it("scales correctly when a 2:1 split occurred between payout and now (split-consistent)", () => {
    // Before split: 100 shares; after split: 200 shares (all in current share terms).
    // qtyAt returns 200 (split applied to historical), currentQty = 200 → ratio 1 → same amount.
    const heldQty = new Map([["bbca", "200"]]);
    const qtyAt = () => "200"; // already in current (post-split) terms
    const [r] = projectDividends([entry()], heldQty, qtyAt, now);
    expect(r.amount).toBe("100000"); // same total, not doubled
  });

  it("falls back to raw amount when historical qty is zero or missing", () => {
    const heldQty = new Map([["bbca", "100"]]);
    const qtyAt = () => "0";
    const [r] = projectDividends([entry()], heldQty, qtyAt, now);
    expect(r.amount).toBe("100000");
  });

  it("skips instruments not in heldQty (sold before now)", () => {
    const heldQty = new Map<string, string>(); // empty — BBCA sold
    const result = projectDividends([entry()], heldQty, () => "100", now);
    expect(result).toHaveLength(0);
  });

  it("skips dividends outside the source window (too old or already this year)", () => {
    const heldQty = new Map([["bbca", "100"]]);
    const qtyAt = () => "100";
    // 2025-01-01 is before (now − 1yr = 2025-06-15) → outside source window.
    const tooOld = entry({ executedAt: new Date("2025-01-01T00:00:00.000Z") });
    // 2025-06-10 is also before pastStart → skip (projects to 2026-06-10 ≤ now).
    const borderline = entry({ executedAt: new Date("2025-06-10T00:00:00.000Z") });
    // 2026-03-01 is this year → outside source window (only last year accepted).
    const thisYear = entry({ executedAt: new Date("2026-03-01T00:00:00.000Z") });
    const result = projectDividends(
      [tooOld, borderline, thisYear],
      heldQty,
      qtyAt,
      now,
    );
    expect(result).toHaveLength(0);
  });

  it("skips non-dividend events (coupons)", () => {
    const heldQty = new Map([["fr01", "10"]]);
    const coupon = entry({ instrumentId: "fr01", type: "coupon" });
    expect(projectDividends([coupon], heldQty, () => "10", now)).toHaveLength(0);
  });

  it("returns results sorted ascending by projected date", () => {
    const heldQty = new Map([["bbca", "100"], ["vwrl", "50"]]);
    const qtyAt = () => "100";
    const e1 = entry({ executedAt: new Date("2025-12-01T00:00:00.000Z") }); // → 2026-12-01
    const e2 = entry({
      instrumentId: "vwrl", symbol: "VWRL",
      executedAt: new Date("2025-09-15T00:00:00.000Z"), // → 2026-09-15
    });
    const result = projectDividends([e1, e2], heldQty, qtyAt, now);
    expect(result.map((r) => r.date)).toEqual(["2026-09-15", "2026-12-01"]);
  });
});

describe("trailingIncomeByInstrument / trailingYield", () => {
  const since = new Date("2025-06-15T00:00:00.000Z");
  const ev = (over: Partial<CoreTransaction>): CoreTransaction => tx(over);

  it("sums dividend and coupon cash per instrument since the cutoff", () => {
    const income = trailingIncomeByInstrument(
      [
        ev({ instrumentId: "a", type: "dividend", price: "100", executedAt: new Date("2026-01-10") }),
        ev({ instrumentId: "a", type: "dividend", price: "150", executedAt: new Date("2026-03-10") }),
        ev({ instrumentId: "b", type: "coupon", price: "300", executedAt: new Date("2026-02-10") }),
        ev({ instrumentId: "a", type: "dividend", price: "999", executedAt: new Date("2024-01-10") }), // too old
        ev({ instrumentId: "a", type: "buy", price: "50", executedAt: new Date("2026-04-10") }), // not income
      ],
      since,
      "IDR",
    );
    expect(income).toEqual({ a: "250", b: "300" });
  });

  it("computes yield as income over market value, null at zero value", () => {
    expect(trailingYield("300000", "6000000")).toBe("0.05");
    expect(trailingYield("100", "0")).toBeNull();
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
    exposureByCurrency: {},
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
          marketValueDisplay: "950000",
          costBasisDisplay: "900000",
          unrealizedPnLDisplay: "50000",
          previousClose: "9000",
          dayChange: "50000",
          dayChangePct: "5",
        },
      ],
      cash: { IDR: "1000000" },
      exposureByCurrency: { IDR: "1950000" },
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
          marketValueDisplay: "950000",
          costBasisDisplay: "950000",
          unrealizedPnLDisplay: "0",
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
          marketValueDisplay: "5750000",
          costBasisDisplay: "5000000",
          unrealizedPnLDisplay: "750000",
          previousClose: "1100000",
          dayChange: "250000",
          dayChangePct: "4.5",
        },
      ],
      cash: { IDR: "500000", USD: "100" },
      exposureByCurrency: { IDR: "7100000", USD: "100000" },
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
    expect(i1.costBasisDisplay).toBe("1850000"); // display fields sum too
    expect(i1.marketValueDisplay).toBe("1900000");
    expect(i1.unrealizedPnLDisplay).toBe("50000"); // 50k + 0
    expect(i1.realizedPnL).toBe("10000");
    expect(i1.dayChange).toBe("100000"); // 50k + 50k (same instrument, summed)
    expect(i1.dayChangePct).toBe("5"); // per-share pct carried, not summed
    expect(out.holdings).toHaveLength(2); // i1 merged, i2 distinct

    expect(out.cash).toEqual({ IDR: "1500000", USD: "100" });
    expect(out.exposureByCurrency).toEqual({ IDR: "9050000", USD: "100000" });
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
