import { describe, it, expect } from "vitest";
import { bestAndWorst, periodToMover } from "../src/lib/movers";
import type { HoldingValuation, PeriodMover } from "@portfolio/api-client";

function holding(
  overrides: Partial<HoldingValuation> & { instrumentId: string },
): HoldingValuation {
  return {
    quantity: "10",
    avgCost: "100",
    costBasis: "1000",
    realizedPnL: "0",
    costCurrency: "IDR",
    price: "110",
    currency: "IDR",
    marketValue: "1100",
    unrealizedPnL: "100",
    marketValueDisplay: "1100",
    costBasisDisplay: "1000",
    unrealizedPnLDisplay: "100",
    previousClose: "108",
    dayChange: "20",
    dayChangePct: "1.8",
    instrument: null,
    ...overrides,
  };
}

describe("bestAndWorst", () => {
  it("returns null when fewer than 2 holdings have a known day move", () => {
    const holdings = [holding({ instrumentId: "a", dayChangePct: "1.5" })];
    expect(bestAndWorst(holdings)).toBeNull();
  });

  it("returns null when no holdings have a day move (all null)", () => {
    const holdings = [
      holding({ instrumentId: "a", dayChangePct: null }),
      holding({ instrumentId: "b", dayChangePct: null }),
    ];
    expect(bestAndWorst(holdings)).toBeNull();
  });

  it("ranks by signed dayChangePct — not absolute value", () => {
    const holdings = [
      holding({
        instrumentId: "a",
        dayChangePct: "-8.0", // biggest magnitude, but a loser
        instrument: {
          symbol: "AAA",
          market: "IDX",
          assetClass: "equity",
          unit: "share",
          sector: null,
          sectorWeights: null,
          countryWeights: null,
          name: "Alpha",
          displayName: null,
        },
      }),
      holding({
        instrumentId: "b",
        dayChangePct: "3.0",
        instrument: {
          symbol: "BBB",
          market: "IDX",
          assetClass: "equity",
          unit: "share",
          sector: null,
          sectorWeights: null,
          countryWeights: null,
          name: "Beta",
          displayName: null,
        },
      }),
      holding({
        instrumentId: "c",
        dayChangePct: "-1.0",
        instrument: {
          symbol: "CCC",
          market: "IDX",
          assetClass: "gold",
          unit: "gram",
          sector: null,
          sectorWeights: null,
          countryWeights: null,
          name: "Gamma",
          displayName: null,
        },
      }),
    ];

    const result = bestAndWorst(holdings);
    expect(result).not.toBeNull();
    expect(result?.best.symbol).toBe("BBB");
    expect(result?.best.pct).toBeCloseTo(0.03);
    expect(result?.worst.symbol).toBe("AAA");
    expect(result?.worst.pct).toBeCloseTo(-0.08);
  });

  it("excludes zero-quantity (closed) holdings", () => {
    const holdings = [
      holding({ instrumentId: "a", quantity: "0", dayChangePct: "5.0" }),
      holding({ instrumentId: "b", dayChangePct: "2.0" }),
    ];
    expect(bestAndWorst(holdings)).toBeNull();
  });
});

describe("periodToMover", () => {
  it("maps PeriodMover fields to Mover correctly", () => {
    const pm: PeriodMover = {
      instrumentId: "x",
      symbol: "BBCA",
      name: "Bank Central Asia",
      assetClass: "equity",
      pct: 0.05,
    };
    const m = periodToMover(pm);
    expect(m.instrumentId).toBe("x");
    expect(m.symbol).toBe("BBCA");
    expect(m.name).toBe("Bank Central Asia");
    expect(m.assetClass).toBe("equity");
    expect(m.pct).toBeCloseTo(0.05);
  });

  it("falls back to instrumentId when name is null", () => {
    const pm: PeriodMover = {
      instrumentId: "fallback-id",
      symbol: "SYM",
      name: null,
      assetClass: "gold",
      pct: -0.03,
    };
    const m = periodToMover(pm);
    expect(m.name).toBe("fallback-id");
    expect(m.pct).toBeCloseTo(-0.03);
  });
});
