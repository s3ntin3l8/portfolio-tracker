import { describe, it, expect } from "vitest";
import { streakAnalysis } from "../src/streaks.js";

function num(s: string | undefined): number {
  return s ? Number(s) : 0;
}

describe("streakAnalysis", () => {
  it("returns null values for empty series", () => {
    const result = streakAnalysis([]);
    expect(result.bestStreak).toBeNull();
    expect(result.worstStreak).toBeNull();
    expect(result.totalMonths).toBe(0);
  });

  it("detects a single winning streak", () => {
    const result = streakAnalysis([
      { date: "2026-01-01", index: "100" },
      { date: "2026-02-01", index: "105" },
      { date: "2026-03-01", index: "110" },
      { date: "2026-04-01", index: "115" },
    ]);
    expect(result.bestStreak?.length).toBe(3);
    expect(num(result.bestStreak?.totalReturnPct)).toBeCloseTo(0.15, 8);
    expect(result.worstStreak).toBeNull();
    expect(result.positiveMonths).toBe(3);
    expect(result.negativeMonths).toBe(0);
    expect(result.totalMonths).toBe(3);
  });

  it("detects a single losing streak", () => {
    const result = streakAnalysis([
      { date: "2026-01-01", index: "100" },
      { date: "2026-02-01", index: "95" },
      { date: "2026-03-01", index: "90" },
    ]);
    expect(result.worstStreak?.length).toBe(2);
    expect(num(result.worstStreak?.totalReturnPct)).toBeCloseTo(-0.1, 8);
    expect(result.bestStreak).toBeNull();
    expect(result.positiveMonths).toBe(0);
    expect(result.negativeMonths).toBe(2);
  });

  it("detects alternating wins and losses with multiple streaks", () => {
    const result = streakAnalysis([
      { date: "2026-01-01", index: "100" },
      { date: "2026-02-01", index: "110" },
      { date: "2026-03-01", index: "105" },
      { date: "2026-04-01", index: "115" },
      { date: "2026-05-01", index: "120" },
    ]);
    expect(result.bestStreak?.length).toBe(2);
    expect(num(result.bestStreak?.totalReturnPct)).toBeCloseTo(0.142857, 5);
    expect(result.worstStreak?.length).toBe(1);
    expect(result.totalMonths).toBe(4);
  });

  it("identifies best and worst single months", () => {
    const result = streakAnalysis([
      { date: "2026-01-01", index: "100" },
      { date: "2026-02-01", index: "95" },
      { date: "2026-03-01", index: "110" },
    ]);
    expect(result.bestMonth?.date).toBe("2026-03");
    expect(Number(result.bestMonth?.returnPct)).toBeCloseTo(0.15789, 4);
    expect(result.worstMonth?.date).toBe("2026-02");
    expect(Number(result.worstMonth?.returnPct)).toBeCloseTo(-0.05, 8);
  });

  it("identifies best and worst calendar years", () => {
    const result = streakAnalysis([
      { date: "2025-01-01", index: "100" },
      { date: "2025-06-01", index: "90" },
      { date: "2026-01-01", index: "110" },
      { date: "2026-06-01", index: "120" },
    ]);
    expect(result.bestYear?.year).toBe(2026);
    expect(result.worstYear?.year).toBe(2025);
    expect(Number(result.worstYear?.returnPct)).toBeCloseTo(-0.1, 4);
  });

  it("uses the first point's year as the series start", () => {
    const result = streakAnalysis([
      { date: "2026-06-01", index: "100" },
      { date: "2026-12-01", index: "110" },
    ]);
    expect(result.bestYear?.year).toBe(2026);
  });
});
