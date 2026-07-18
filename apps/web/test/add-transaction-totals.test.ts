import { describe, it, expect } from "vitest";
import {
  computeTxTotal,
  formatMoney,
  stripGrouping,
} from "../src/components/add-transaction-form/totals";

describe("stripGrouping", () => {
  it("parses a grouped string back to a number", () => {
    expect(stripGrouping("1,234.5")).toBe(1234.5);
  });
  it("returns NaN for blank input", () => {
    expect(stripGrouping("")).toBeNaN();
    expect(stripGrouping(null)).toBeNaN();
  });
});

describe("computeTxTotal", () => {
  it("buy: subtotal + fees + tax, labeled as a trade-buy", () => {
    const total = computeTxTotal("buy", "10", "100", "5", "2");
    expect(total).toEqual({ kind: "trade-buy", subtotal: 1000, fees: 5, tax: 2, total: 1007 });
  });

  it("savings_plan is treated as a buy (not sell) for sign purposes", () => {
    const total = computeTxTotal("savings_plan", "10", "100", "5", "0");
    expect(total?.kind).toBe("trade-buy");
    expect(total?.total).toBe(1005);
  });

  it("sell: subtotal − fees − tax, labeled as estimated proceeds", () => {
    const total = computeTxTotal("sell", "10", "100", "5", "2");
    expect(total).toEqual({ kind: "trade-sell", subtotal: 1000, fees: 5, tax: 2, total: 993 });
  });

  it("transfer: quantity × cost basis, no fee/tax breakdown", () => {
    const total = computeTxTotal("transfer_in", "10", "50", "999", "999");
    expect(total).toEqual({ kind: "transfer", subtotal: 500, fees: 0, tax: 0, total: 500 });
  });

  it("income: amount − tax", () => {
    const total = computeTxTotal("dividend", "", "250", "0", "37.5");
    expect(total).toEqual({ kind: "income", subtotal: 250, fees: 0, tax: 37.5, total: 212.5 });
  });

  it("treats missing fees/tax as zero", () => {
    const total = computeTxTotal("buy", "10", "100", "", "");
    expect(total?.total).toBe(1000);
  });

  it("returns null when required fields aren't filled in yet", () => {
    expect(computeTxTotal("buy", "10", "", "0", "0")).toBeNull();
    expect(computeTxTotal("dividend", "", "", "0", "0")).toBeNull();
  });

  it("returns null for types with no total concept (cash/share-receipt)", () => {
    expect(computeTxTotal("deposit", "", "100", "0", "0")).toBeNull();
    expect(computeTxTotal("split", "10", "0", "0", "0")).toBeNull();
  });

  it("accepts grouped (comma-separated) field values", () => {
    const total = computeTxTotal("buy", "1,000", "9,500", "0", "0");
    expect(total?.subtotal).toBe(9_500_000);
  });
});

describe("formatMoney", () => {
  it("IDR has no decimal places", () => {
    expect(formatMoney(1234, "IDR")).toBe("IDR 1,234");
  });
  it("other currencies show 2 decimal places", () => {
    expect(formatMoney(1234.5, "USD")).toBe("USD 1,234.50");
  });
  it("returns an empty string for non-finite input", () => {
    expect(formatMoney(NaN, "USD")).toBe("");
  });
});
