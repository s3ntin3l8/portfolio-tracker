import { describe, it, expect } from "vitest";
import { isIdxOpen, isGoldOpen, isMarketOpen } from "../../src/services/market-hours.js";

// 2026-02-09 is a Monday; 2026-02-14 a Saturday; 2026-02-15 a Sunday.
const monday = (h: number, m = 0) =>
  new Date(Date.UTC(2026, 1, 9, h, m, 0));

describe("isIdxOpen", () => {
  it("is open inside the 02:00–09:00 UTC weekday window", () => {
    expect(isIdxOpen(monday(3))).toBe(true);
    expect(isIdxOpen(monday(2))).toBe(true);
  });

  it("is closed before/after the window", () => {
    expect(isIdxOpen(monday(1, 59))).toBe(false);
    expect(isIdxOpen(monday(9))).toBe(false);
  });

  it("is closed on weekends", () => {
    expect(isIdxOpen(new Date(Date.UTC(2026, 1, 14, 3)))).toBe(false); // Sat
    expect(isIdxOpen(new Date(Date.UTC(2026, 1, 15, 3)))).toBe(false); // Sun
  });
});

describe("isGoldOpen", () => {
  it("is open on weekdays", () => {
    expect(isGoldOpen(monday(3))).toBe(true);
    expect(isGoldOpen(monday(23))).toBe(true);
  });

  it("is closed all of Saturday", () => {
    expect(isGoldOpen(new Date(Date.UTC(2026, 1, 14, 12)))).toBe(false);
  });

  it("opens Sunday at 22:00 UTC", () => {
    expect(isGoldOpen(new Date(Date.UTC(2026, 1, 15, 21)))).toBe(false);
    expect(isGoldOpen(new Date(Date.UTC(2026, 1, 15, 22)))).toBe(true);
  });

  it("closes Friday at 22:00 UTC", () => {
    expect(isGoldOpen(new Date(Date.UTC(2026, 1, 13, 21)))).toBe(true);
    expect(isGoldOpen(new Date(Date.UTC(2026, 1, 13, 22)))).toBe(false);
  });
});

describe("isMarketOpen", () => {
  it("routes by market and defaults unknown markets to open", () => {
    expect(isMarketOpen("IDX", monday(3))).toBe(true);
    expect(isMarketOpen("XAU", monday(3))).toBe(true);
    expect(isMarketOpen("NASDAQ", monday(3))).toBe(true);
  });
});
