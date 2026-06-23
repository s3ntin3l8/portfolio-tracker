import { describe, it, expect } from "vitest";
import { getDrillDownInstruments } from "../src/lib/sector-drilldown";

function makeHolding(
  overrides: Partial<{
    instrumentId: string;
    instrument: {
      symbol: string;
      name: string;
      assetClass: string;
      unit: string;
      market: string;
      sector: string | null;
      sectorWeights: Record<string, number> | null;
      countryWeights: Record<string, number> | null;
    } | null;
    marketValueDisplay: string | null;
    currency: string | null;
  }>,
) {
  return {
    instrumentId: overrides.instrumentId ?? "h1",
    quantity: "100",
    avgCost: "10",
    costBasis: "1000",
    realizedPnL: "0",
    costCurrency: null,
    price: "15",
    currency: overrides.currency ?? "USD",
    marketValue: "1500",
    unrealizedPnL: "500",
    marketValueDisplay: overrides.marketValueDisplay !== undefined ? overrides.marketValueDisplay : "1500",
    costBasisDisplay: "1000",
    unrealizedPnLDisplay: "500",
    previousClose: "14.5",
    dayChange: "0.5",
    dayChangePct: "3.4",
    instrument: overrides.instrument ?? null,
  };
}

// ---------------------------------------------------------------------------
// Sector dimension
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — sector", () => {
  it("includes equity whose sector matches", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "500",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Technology");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "goto", name: "GOTO", value: 500 });
  });

  it("excludes equity whose sector does not match", () => {
    const holdings = [
      makeHolding({
        instrument: { symbol: "BBCA", name: "Bank BCA", assetClass: "equity", unit: "shares", market: "IDX", sector: "Finance", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "1000",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("decomposes ETF by sectorWeights proportionally", () => {
    const holdings = [
      makeHolding({
        instrumentId: "sxr8",
        instrument: { symbol: "SXR8", name: "S&P 500 ETF", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: { Technology: 0.39, Finance: 0.13 }, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Technology");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "sxr8", name: "SXR8", value: 3900 });
  });

  it("skips ETF with zero weight in sector", () => {
    const holdings = [
      makeHolding({
        instrumentId: "sxr8",
        instrument: { symbol: "SXR8", name: "S&P 500 ETF", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: { Finance: 0.13 }, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("normalizes 'Financial Services' to match 'Financials' (selectedKey)", () => {
    const holdings = [
      makeHolding({
        instrumentId: "sxr8",
        instrument: { symbol: "SXR8", name: "S&P 500 ETF", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: { "Financial Services": 0.15, Technology: 0.5 }, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Financials");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "sxr8", name: "SXR8", value: 1500 });
  });

  it("normalizes equity 'Healthcare' to match 'Health Care' (selectedKey)", () => {
    const holdings = [
      makeHolding({
        instrumentId: "pfe",
        instrument: { symbol: "PFE", name: "Pfizer", assetClass: "equity", unit: "shares", market: "NYSE", sector: "Healthcare", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "5000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Health Care");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "pfe", name: "PFE", value: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Region dimension
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — region", () => {
  it("includes equity whose market maps to region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "500",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "ID");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "goto", name: "GOTO", value: 500 });
  });

  it("excludes equity whose market maps to different region", () => {
    const holdings = [
      makeHolding({
        instrument: { symbol: "SXR8", name: "S&P 500 ETF", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "1000",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "region", "ID")).toEqual([]);
  });

  it("includes ETF by its listing market region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "EU");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "vwce", name: "VWCE", value: 10000 });
  });

  it("maps NASDAQ to US region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "aapl",
        instrument: { symbol: "AAPL", name: "Apple", assetClass: "equity", unit: "shares", market: "NASDAQ", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "5000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "US");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "aapl", name: "AAPL", value: 5000 });
  });
});

// ---------------------------------------------------------------------------
// Currency dimension
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — currency", () => {
  it("includes equity whose currency matches", () => {
    const holdings = [
      makeHolding({
        instrumentId: "aapl",
        instrument: { symbol: "AAPL", name: "Apple", assetClass: "equity", unit: "shares", market: "NASDAQ", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "5000",
        currency: "USD",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "currency", "USD");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "aapl", name: "AAPL", value: 5000 });
  });

  it("excludes equity whose currency does not match", () => {
    const holdings = [
      makeHolding({
        instrument: { symbol: "BBCA", name: "Bank BCA", assetClass: "equity", unit: "shares", market: "IDX", sector: "Finance", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "1000",
        currency: "IDR",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "currency", "USD")).toEqual([]);
  });

  it("includes ETF by its quote currency", () => {
    const holdings = [
      makeHolding({
        instrumentId: "sxr8",
        instrument: { symbol: "SXR8", name: "S&P 500 ETF", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "10000",
        currency: "EUR",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "currency", "EUR");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "sxr8", name: "SXR8", value: 10000 });
  });
});

// ---------------------------------------------------------------------------
// Asset class dimension
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — asset_class", () => {
  it("includes equity when filtering by equity", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "500",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "asset_class", "equity");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "goto", name: "GOTO", value: 500 });
  });

  it("excludes ETF when filtering by equity", () => {
    const holdings = [
      makeHolding({
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "asset_class", "equity")).toEqual([]);
  });

  it("includes gold when filtering by gold", () => {
    const holdings = [
      makeHolding({
        instrumentId: "xau",
        instrument: { symbol: "XAU", name: "Gold", assetClass: "gold", unit: "oz", market: "XAU", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "2000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "asset_class", "gold");
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ key: "xau", name: "XAU", value: 2000 });
  });
});

// ---------------------------------------------------------------------------
// Region dimension — ETF countryWeights decomposition
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — region with countryWeights", () => {
  it("decomposes ETF by countryWeights into region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: { "United States": 0.57, Germany: 0.05, Japan: 0.06 } },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "North America");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeCloseTo(5700);
  });

  it("sums multiple countries in same region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: { "United States": 0.57, Canada: 0.03 } },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "North America");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBeCloseTo(6000);
  });

  it("adds remainder to listing venue region when countryWeights < 1", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: { "United States": 0.8 } },
        marketValueDisplay: "10000",
      }),
    ];
    // 80% US → North America; remainder attributed to listing venue (EU)
    const euResult = getDrillDownInstruments(holdings, "region", "EU");
    expect(euResult).toHaveLength(1);
    // remainder = 1 - 0 (regionTotal for EU) = 1, so contribution = 10000
    expect(euResult[0].value).toBeCloseTo(10000);

    // 80% US → North America
    const naResult = getDrillDownInstruments(holdings, "region", "North America");
    expect(naResult).toHaveLength(1);
    expect(naResult[0].value).toBeCloseTo(8000);
  });

  it("returns empty when countryWeights has no countries in selected region", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: { "United States": 0.8 } },
        marketValueDisplay: "10000",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "region", "Asia")).toEqual([]);
  });

  it("falls back to listing venue when ETF has no countryWeights", () => {
    const holdings = [
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: null, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "region", "EU");
    expect(result).toHaveLength(1);
    expect(result[0].value).toBe(10000);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("getDrillDownInstruments — edge cases", () => {
  it("skips holding with null instrument", () => {
    const holdings = [
      makeHolding({ instrument: null, marketValueDisplay: "1000" }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("skips holding with null marketValueDisplay", () => {
    const holdings = [
      makeHolding({
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: null,
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("sorts by value descending", () => {
    const holdings = [
      makeHolding({
        instrumentId: "h1",
        instrument: { symbol: "BBCA", name: "Bank BCA", assetClass: "equity", unit: "shares", market: "IDX", sector: "Finance", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "100",
      }),
      makeHolding({
        instrumentId: "h2",
        instrument: { symbol: "BBRI", name: "Bank BRI", assetClass: "equity", unit: "shares", market: "IDX", sector: "Finance", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "500",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Finance");
    expect(result[0].key).toBe("h2");
    expect(result[1].key).toBe("h1");
  });

  it("combines equities and ETF decompositions in same sector", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "500",
      }),
      makeHolding({
        instrumentId: "vwce",
        instrument: { symbol: "VWCE", name: "Vanguard FTSE", assetClass: "etf", unit: "shares", market: "XETRA", sector: null, sectorWeights: { Technology: 0.2 }, countryWeights: null },
        marketValueDisplay: "10000",
      }),
    ];
    const result = getDrillDownInstruments(holdings, "sector", "Technology");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ key: "vwce", name: "VWCE", value: 2000 });
    expect(result[1]).toEqual({ key: "goto", name: "GOTO", value: 500 });
  });

  it("returns empty array for empty holdings", () => {
    expect(getDrillDownInstruments([], "sector", "Technology")).toEqual([]);
  });

  it("skips holding with non-finite marketValueDisplay", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "NaN",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("skips holding with negative marketValueDisplay", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "-500",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });

  it("skips holding with zero marketValueDisplay", () => {
    const holdings = [
      makeHolding({
        instrumentId: "goto",
        instrument: { symbol: "GOTO", name: "GoTo", assetClass: "equity", unit: "shares", market: "IDX", sector: "Technology", sectorWeights: null, countryWeights: null },
        marketValueDisplay: "0",
      }),
    ];
    expect(getDrillDownInstruments(holdings, "sector", "Technology")).toEqual([]);
  });
});
