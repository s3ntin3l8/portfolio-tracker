import { describe, expect, it } from "vitest";
import {
  actionClass,
  decimalsClose,
  findCrossSourceDuplicates,
  parseLooseDecimal,
  withinDayTolerance,
} from "./dedup.js";

describe("actionClass", () => {
  it("collapses buy and savings_plan to one acquisition class", () => {
    expect(actionClass("buy")).toBe(actionClass("savings_plan"));
  });

  it("keeps unrelated actions distinct (sell is never an acquisition peer)", () => {
    expect(actionClass("sell")).toBe("sell");
    expect(actionClass("dividend")).toBe("dividend");
    expect(actionClass("sell")).not.toBe(actionClass("buy"));
  });
});

describe("parseLooseDecimal", () => {
  it("parses English and German decimal marks identically", () => {
    expect(parseLooseDecimal("74.506")).toBe(74.506);
    expect(parseLooseDecimal("74,506")).toBe(74.506);
  });

  it("handles thousands separators on both conventions", () => {
    expect(parseLooseDecimal("1.234,56")).toBe(1234.56);
    expect(parseLooseDecimal("1,234.56")).toBe(1234.56);
  });

  it("returns null for non-numeric input", () => {
    expect(parseLooseDecimal("abc")).toBeNull();
    expect(parseLooseDecimal("")).toBeNull();
    expect(parseLooseDecimal(null)).toBeNull();
  });
});

describe("decimalsClose", () => {
  it("treats a precision/rounding divergence as equal (C3)", () => {
    // PDF rounds a fund quantity the CSV carries to full precision.
    expect(decimalsClose("74.506", "74.51")).toBe(true);
    expect(decimalsClose("74.50600000", "74.506")).toBe(true);
  });

  it("matches across decimal-mark locales", () => {
    expect(decimalsClose("74,506", "74.506")).toBe(true);
  });

  it("keeps genuinely different same-instrument quantities apart", () => {
    // The two real A2H9QY buys on 2021-07-05 — 1.3358 vs 3.1399 units.
    expect(decimalsClose("1.3358", "3.1399")).toBe(false);
  });

  it("uses an absolute floor for sub-unit values", () => {
    expect(decimalsClose("0.3355", "0.3357")).toBe(true);
    expect(decimalsClose("0.3355", "0.9")).toBe(false);
  });
});

describe("withinDayTolerance", () => {
  it("accepts an adjacent trade-date vs settlement-date (C4)", () => {
    expect(withinDayTolerance("2021-11-17", "2021-11-18")).toBe(true);
  });

  it("rejects a two-day gap", () => {
    expect(withinDayTolerance("2021-11-17", "2021-11-19")).toBe(false);
  });

  it("absorbs an intraday timezone difference around midnight", () => {
    expect(withinDayTolerance("2021-11-17T23:30:00Z", "2021-11-18T01:00:00Z")).toBe(true);
  });
});

describe("findCrossSourceDuplicates", () => {
  const isin = "LU1737652237";

  it("matches a CSV buy against a PDF savings_plan of the same trade (action divergence)", () => {
    const committed = [
      { key: isin, action: "savings_plan", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05", source: "screenshot" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    const matches = findCrossSourceDuplicates(drafts, committed);
    expect(matches).toHaveLength(1);
    expect(matches[0].matched.source).toBe("screenshot");
  });

  it("matches across a ±1 day settlement skew and a precision divergence", () => {
    const committed = [
      { key: isin, action: "dividend", quantity: "0", price: "10.02", executedAt: "2021-11-17", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "dividend", quantity: "0", price: "10.020", executedAt: "2021-11-18" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(1);
  });

  it("is count-aware: two same-day buys with one prior import flag only one", () => {
    const committed = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    const matches = findCrossSourceDuplicates(drafts, committed);
    expect(matches).toHaveLength(1);
    expect(matches[0].draftIndex).toBe(0);
  });

  it("does not match two distinct same-day buys of different size", () => {
    const committed = [
      { key: isin, action: "buy", quantity: "3.1399", price: "72.614", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(0);
  });

  it("ignores records without an instrument identity (cash legs)", () => {
    const committed = [
      { key: null, action: "deposit", quantity: "0", price: "100", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: null, action: "deposit", quantity: "0", price: "100", executedAt: "2021-07-05" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(0);
  });
});
