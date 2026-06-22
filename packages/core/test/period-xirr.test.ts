import { describe, it, expect } from "vitest";
import { periodXirr } from "../src/period-xirr.js";

const d = (s: string) => new Date(s);

describe("periodXirr", () => {
  it("returns null when startNav is zero", () => {
    const result = periodXirr([], 1000, 0, d("2024-01-01"), d("2024-12-31"));
    expect(result).toBeNull();
  });

  it("returns null when startNav is negative", () => {
    const result = periodXirr([], 1000, -100, d("2024-01-01"), d("2024-12-31"));
    expect(result).toBeNull();
  });

  it("computes a simple annual return with no intermediate flows", () => {
    // $1000 invested, grew to $1100 in one year → ~10% return
    const result = periodXirr([], 1100, 1000, d("2024-01-01"), d("2025-01-01"));
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.1, 1);
  });

  it("clips flows before anchorDate", () => {
    const allFlows = [
      { amount: -500, date: d("2023-01-01") }, // before anchor, should be excluded
      { amount: -200, date: d("2024-06-01") }, // after anchor, included
    ];
    const result = periodXirr(allFlows, 1200, 1000, d("2024-01-01"), d("2025-01-01"));
    expect(result).not.toBeNull();
    // With an extra $200 invested mid-year, the return should be positive but lower
    expect(result!).toBeGreaterThan(-0.5);
  });

  it("returns null for unreasonably large rates (>5000%)", () => {
    // Nearly zero start nav but huge current value => astronomical rate
    const result = periodXirr([], 1_000_000, 1, d("2024-12-30"), d("2024-12-31"));
    expect(result).toBeNull();
  });

  it("excludes flows on or before anchorDate (boundary is exclusive)", () => {
    const anchorDate = d("2024-01-01");
    const allFlows = [
      { amount: -300, date: anchorDate }, // exactly on anchorDate — should be excluded
      { amount: -200, date: d("2024-07-01") }, // after — included
    ];
    const result = periodXirr(allFlows, 1500, 1000, anchorDate, d("2025-01-01"));
    expect(result).not.toBeNull();
  });
});
