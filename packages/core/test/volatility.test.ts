import { describe, it, expect } from "vitest";
import { dailyReturns, annualizedVolatility, sharpeRatio, sortinoRatio } from "../src/volatility.js";

describe("dailyReturns", () => {
  it("returns empty array for single point", () => {
    expect(dailyReturns([{ date: "2026-01-01", index: "100" }])).toEqual([]);
  });

  it("computes percentage returns between consecutive points", () => {
    const points = [
      { date: "2026-01-01", index: "100" },
      { date: "2026-01-02", index: "110" },
      { date: "2026-01-03", index: "99" },
    ];
    const result = dailyReturns(points);
    expect(result.length).toBe(2);
    expect(result[0]).toBeCloseTo(0.1, 10);
    expect(result[1]).toBeCloseTo(-0.1, 10);
  });

  it("handles zero previous index", () => {
    const points = [
      { date: "2026-01-01", index: "0" },
      { date: "2026-01-02", index: "100" },
    ];
    const result = dailyReturns(points);
    expect(result).toEqual([0]);
  });
});

describe("annualizedVolatility", () => {
  it("returns null for empty returns", () => {
    expect(annualizedVolatility([], 252)).toBeNull();
  });

  it("returns null for single return", () => {
    expect(annualizedVolatility([0.01], 252)).toBeNull();
  });

  it("computes 0 for constant returns", () => {
    expect(annualizedVolatility([0.01, 0.01, 0.01], 252)).toBeCloseTo(0, 10);
  });

  it("computes expected volatility for known series", () => {
    const returns = [0.01, -0.01, 0.02, -0.02, 0.01, -0.01, 0.03, -0.03];
    const vol = annualizedVolatility(returns, 252);
    expect(vol).not.toBeNull();
    expect(vol!).toBeGreaterThan(0);
  });
});

describe("sharpeRatio", () => {
  it("returns null for empty returns", () => {
    expect(sharpeRatio([], 0.02, 252)).toBeNull();
  });

  it("returns null for single return", () => {
    expect(sharpeRatio([0.01], 0.02, 252)).toBeNull();
  });

  it("returns negative sharpe when return is below risk-free", () => {
    const returns = [-0.02, -0.01, -0.03];
    const sr = sharpeRatio(returns, 0.03, 252);
    expect(sr).not.toBeNull();
    expect(sr!).toBeLessThan(0);
  });
});

describe("sortinoRatio", () => {
  it("returns null for empty returns", () => {
    expect(sortinoRatio([], 0.02, 252)).toBeNull();
  });

  it("returns null for single return", () => {
    expect(sortinoRatio([0.01], 0.02, 252)).toBeNull();
  });

  it("returns null when there are no down-months (undefined Sortino)", () => {
    const returns = [0.01, 0.02, 0.015];
    const sr = sortinoRatio(returns, 0.02, 252);
    expect(sr).toBeNull();
  });
});
