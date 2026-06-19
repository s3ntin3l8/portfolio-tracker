import { describe, it, expect } from "vitest";
import { contributionStats, type CoreTransaction } from "../src/index.js";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: "inst-etf",
    type: "savings_plan",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-01-15"),
    ...p,
  };
}

describe("contributionStats", () => {
  it("sums savings_plan notional (incl. fees) per distinct month", () => {
    const txns: CoreTransaction[] = [
      tx({ quantity: "2", price: "100", fees: "1", executedAt: new Date("2026-01-15") }),
      tx({ quantity: "2", price: "100", fees: "1", executedAt: new Date("2026-02-15") }),
      tx({ quantity: "3", price: "100", fees: "0", executedAt: new Date("2026-03-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR" });
    // 201 + 201 + 300 = 702 across 3 months.
    expect(s.totalContributed).toBe("702");
    expect(s.netContributed).toBe("702");
    expect(s.monthsActive).toBe(3);
    expect(s.monthlyAverage).toBe("234"); // 702/3
    expect(s.series.map((x) => x.month)).toEqual(["2026-01", "2026-02", "2026-03"]);
    expect(s.series[2].contributed).toBe("300");
  });

  it("prefers deposits over savings_plan within a month (no double-count)", () => {
    const txns: CoreTransaction[] = [
      // January: a deposit funds the account; the plan buy that month is internal.
      tx({ type: "deposit", price: "500", executedAt: new Date("2026-01-05") }),
      tx({ quantity: "4", price: "100", executedAt: new Date("2026-01-15") }),
      // February: no deposit — the savings_plan buy is the external money.
      tx({ quantity: "2", price: "100", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR" });
    // Jan counts the 500 deposit (not the 400 buy); Feb counts the 200 buy.
    expect(s.totalContributed).toBe("700");
    expect(s.monthsActive).toBe(2);
    expect(s.series[0]).toEqual({ month: "2026-01", contributed: "500" });
    expect(s.series[1]).toEqual({ month: "2026-02", contributed: "200" });
  });

  it("subtracts withdrawals from the matching month's net", () => {
    const txns: CoreTransaction[] = [
      tx({ quantity: "5", price: "100", executedAt: new Date("2026-01-15") }),
      tx({ type: "withdrawal", price: "200", fees: "0", executedAt: new Date("2026-01-20") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR" });
    expect(s.totalContributed).toBe("500");
    expect(s.totalWithdrawn).toBe("200");
    expect(s.netContributed).toBe("300");
    expect(s.series[0].contributed).toBe("300");
  });

  it("FX-converts amounts to the display currency before summing", () => {
    const txns: CoreTransaction[] = [
      tx({ quantity: "2", price: "100", currency: "USD", executedAt: new Date("2026-01-15") }),
    ];
    const fx = (from: string, to: string) => (from === "USD" && to === "EUR" ? "0.9" : "1");
    const s = contributionStats({ txns, displayCurrency: "EUR", fx });
    expect(s.totalContributed).toBe("180"); // 200 USD * 0.9
  });

  it("returns zeroes when there are no contributions", () => {
    const s = contributionStats({ txns: [], displayCurrency: "EUR" });
    expect(s.totalContributed).toBe("0");
    expect(s.monthsActive).toBe(0);
    expect(s.monthlyAverage).toBe("0");
    expect(s.series).toEqual([]);
  });

  it('"auto" mode ignores plain buys (a depot-snapshot import counts nothing)', () => {
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "5", price: "100", executedAt: new Date("2026-01-15") }),
      tx({ type: "buy", quantity: "2", price: "100", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR" });
    expect(s.totalContributed).toBe("0");
    expect(s.monthsActive).toBe(0);
  });

  it('"purchases" mode counts every buy + savings_plan, ignoring deposits', () => {
    const txns: CoreTransaction[] = [
      // A deposit that would, under "auto", suppress the same-month buy — ignored here.
      tx({ type: "deposit", price: "9999", executedAt: new Date("2026-01-05") }),
      tx({ type: "buy", quantity: "5", price: "100", fees: "1", executedAt: new Date("2026-01-15") }),
      tx({ type: "savings_plan", quantity: "2", price: "100", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", mode: "purchases" });
    // Jan buy 501 + Feb plan 200 = 701; the 9999 deposit is not counted.
    expect(s.totalContributed).toBe("701");
    expect(s.monthsActive).toBe(2);
    expect(s.series[0]).toEqual({ month: "2026-01", contributed: "501" });
    expect(s.series[1]).toEqual({ month: "2026-02", contributed: "200" });
  });
});
