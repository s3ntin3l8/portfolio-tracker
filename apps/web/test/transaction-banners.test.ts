import { describe, it, expect } from "vitest";
import {
  computeAllBanner,
  computeIncomeBanner,
  computeTradeBanner,
  ACTIVITY_INCOME_TYPES,
} from "../src/lib/transaction-banners";
import type { TxRow } from "../src/components/transactions-table";

const NOW = new Date("2026-07-04T00:00:00.000Z");

function row(overrides: Partial<TxRow> & Pick<TxRow, "type" | "executedAt">): TxRow {
  return {
    id: Math.random().toString(36).slice(2),
    portfolioId: "p1",
    quantity: "0",
    price: "0",
    fees: "0",
    tax: null,
    fxRate: null,
    currency: "IDR",
    source: "manual",
    instrument: null,
    ...overrides,
  };
}

const allLabels = {
  invested: "Invested",
  proceeds: "Proceeds",
  incomeYtd: "Income YTD",
  buysCount: (n: number) => `${n} buys`,
  sellsCount: (n: number) => `${n} sells`,
  vsLastYear: (pct: string) => `${pct} vs last year`,
  buys: "Buys",
  sells: "Sells",
  income: "Income",
};

const incomeLabels = {
  vsLastYear: (pct: string) => `${pct} vs last year`,
  new: "New",
  perMonth: (amount: string) => `~ ${amount}/mo`,
  dividends: "Dividends",
  couponsInterest: "Coupons & interest",
  other: "Other income",
};

describe("ACTIVITY_INCOME_TYPES", () => {
  it("classifies dividend, coupon, interest, and bonus_cash as income", () => {
    expect(ACTIVITY_INCOME_TYPES.has("dividend")).toBe(true);
    expect(ACTIVITY_INCOME_TYPES.has("coupon")).toBe(true);
    expect(ACTIVITY_INCOME_TYPES.has("interest")).toBe(true);
    expect(ACTIVITY_INCOME_TYPES.has("bonus_cash")).toBe(true);
    expect(ACTIVITY_INCOME_TYPES.has("buy")).toBe(false);
    expect(ACTIVITY_INCOME_TYPES.has("deposit")).toBe(false);
  });
});

describe("computeAllBanner", () => {
  it("returns null when there are no rows", () => {
    expect(computeAllBanner([], "en", allLabels, NOW)).toBeNull();
  });

  it("sums buys and sells (all-time) and income (current year only) into 3 tiles", () => {
    const rows: TxRow[] = [
      row({ type: "buy", quantity: "10", price: "100", executedAt: "2024-01-01T00:00:00Z" }),
      row({ type: "buy", quantity: "5", price: "200", executedAt: "2026-06-01T00:00:00Z" }),
      row({ type: "sell", quantity: "3", price: "50", executedAt: "2026-05-01T00:00:00Z" }),
      // Dividend in the current year counts toward Income · YTD...
      row({ type: "dividend", price: "1000", executedAt: "2026-01-15T00:00:00Z" }),
      // ...but one from last year should NOT be included in the YTD tile.
      row({ type: "dividend", price: "500", executedAt: "2025-01-15T00:00:00Z" }),
    ];
    const data = computeAllBanner(rows, "en", allLabels, NOW)!;
    expect(data).not.toBeNull();
    // Invested = 10*100 + 5*200 = 2000; 2 buys.
    expect(data.tiles[0].value).toContain("2,000");
    expect(data.tiles[0].sub).toBe("2 buys");
    // Proceeds = 3*50 = 150; 1 sell.
    expect(data.tiles[1].value).toContain("150");
    expect(data.tiles[1].sub).toBe("1 sells");
    // Income YTD = 1000 only (2025 dividend excluded).
    expect(data.tiles[2].value).toContain("1,000");
    // The 2025 dividend (500) falls within last year's Jan-1..same-date window, so it's the
    // trend's comparison base: (1000 − 500) / 500 = +100%.
    expect(data.tiles[2].sub).toBe("+100.00% vs last year");
    expect(data.mix.map((m) => m.label)).toEqual(["Buys", "Sells", "Income"]);
  });

  it("scopes to the dominant currency when rows are mixed", () => {
    const rows: TxRow[] = [
      row({ type: "buy", quantity: "1", price: "100", executedAt: "2026-01-01T00:00:00Z", currency: "IDR" }),
      row({ type: "buy", quantity: "1", price: "100", executedAt: "2026-01-02T00:00:00Z", currency: "IDR" }),
      row({ type: "buy", quantity: "1", price: "999", executedAt: "2026-01-03T00:00:00Z", currency: "USD" }),
    ];
    const data = computeAllBanner(rows, "en", allLabels, NOW)!;
    expect(data.currency).toBe("IDR");
    // Only the two IDR rows (200 total) count; the USD row is dropped.
    expect(data.tiles[0].sub).toBe("2 buys");
  });
});

describe("computeIncomeBanner", () => {
  it("returns null when there is no income at all", () => {
    const rows: TxRow[] = [row({ type: "buy", quantity: "1", price: "1", executedAt: "2026-01-01T00:00:00Z" })];
    expect(computeIncomeBanner(rows, "en", incomeLabels, NOW)).toBeNull();
  });

  it("computes YTD, a trailing-12mo projection, and a by-source split that foots to YTD", () => {
    const rows: TxRow[] = [
      row({ type: "dividend", price: "700", executedAt: "2026-02-01T00:00:00Z" }),
      row({ type: "coupon", price: "300", executedAt: "2026-03-01T00:00:00Z" }),
      // Outside the trailing-12mo window (> 365 days before NOW) — excluded from Projected.
      row({ type: "dividend", price: "5000", executedAt: "2024-01-01T00:00:00Z" }),
    ];
    const data = computeIncomeBanner(rows, "en", incomeLabels, NOW)!;
    expect(data).not.toBeNull();
    expect(data.ytd).toContain("1,000"); // 700 + 300
    expect(data.trendLabel).toBe("New"); // no 2025 income to compare against
    expect(data.bySource).toHaveLength(2);
    expect(data.bySource.find((s) => s.label === "Dividends")?.value).toContain("700");
    expect(data.bySource.find((s) => s.label === "Coupons & interest")?.value).toContain("300");
  });

  it("shows a positive vs-last-year trend when last year's comparable window had income", () => {
    const rows: TxRow[] = [
      row({ type: "dividend", price: "200", executedAt: "2025-06-01T00:00:00Z" }),
      row({ type: "dividend", price: "300", executedAt: "2026-06-01T00:00:00Z" }),
    ];
    const data = computeIncomeBanner(rows, "en", incomeLabels, NOW)!;
    // (300 - 200) / 200 = +50%
    expect(data.trendLabel).toBe("+50.00% vs last year");
    expect(data.trendTone).toBe("up");
  });
});

describe("computeTradeBanner", () => {
  it("returns null when there are no rows of that type", () => {
    const rows: TxRow[] = [row({ type: "sell", quantity: "1", price: "1", executedAt: "2026-01-01T00:00:00Z" })];
    expect(computeTradeBanner(rows, "buy", "en")).toBeNull();
  });

  it("ranks the per-symbol breakdown by amount, largest first", () => {
    const rows: TxRow[] = [
      row({
        type: "buy",
        quantity: "10",
        price: "100",
        executedAt: "2026-01-01T00:00:00Z",
        instrument: { symbol: "BBCA", name: "Bank Central Asia" },
      }),
      row({
        type: "buy",
        quantity: "1",
        price: "5000",
        executedAt: "2026-02-01T00:00:00Z",
        instrument: { symbol: "TLKM", name: "Telkom" },
      }),
    ];
    const data = computeTradeBanner(rows, "buy", "en")!;
    expect(data.count).toBe(2);
    expect(data.total).toContain("6,000");
    expect(data.avg).toContain("3,000");
    expect(data.bySymbol[0].label).toBe("TLKM"); // 5000 > 1000
    expect(data.bySymbol[0].pct).toBe(100);
    expect(data.bySymbol[1].label).toBe("BBCA");
    expect(data.bySymbol[1].pct).toBe(20); // 1000 / 5000
  });
});
