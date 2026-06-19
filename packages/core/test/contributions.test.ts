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

describe("contributionStats — cash INSIDE the boundary", () => {
  it("counts net external cash (deposits − withdrawals), ignoring buys", () => {
    const txns: CoreTransaction[] = [
      // Jan: a deposit funds the account; the buy that month is an internal reallocation.
      tx({ type: "deposit", price: "500", executedAt: new Date("2026-01-05") }),
      tx({ type: "buy", quantity: "4", price: "100", executedAt: new Date("2026-01-15") }),
      // Feb: another deposit.
      tx({ type: "deposit", price: "300", executedAt: new Date("2026-02-05") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "inside" });
    expect(s.totalContributed).toBe("800");
    expect(s.netContributed).toBe("800");
    expect(s.monthsActive).toBe(2);
    expect(s.series[0]).toEqual({ month: "2026-01", contributed: "500" });
    expect(s.series[1]).toEqual({ month: "2026-02", contributed: "300" });
  });

  it("nets a withdrawal within its month", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "deposit", price: "500", executedAt: new Date("2026-01-05") }),
      tx({ type: "withdrawal", price: "200", executedAt: new Date("2026-01-20") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "inside" });
    expect(s.totalContributed).toBe("500");
    expect(s.totalWithdrawn).toBe("200");
    expect(s.netContributed).toBe("300");
    expect(s.series[0].contributed).toBe("300");
  });

  it("lump-then-DCA counts the lump once, not the savings-plan buys it funds", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "deposit", price: "1200", executedAt: new Date("2026-01-05") }),
      tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: new Date("2026-02-15") }),
      tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: new Date("2026-03-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "inside" });
    // Only the €1200 entered the boundary; the Feb/Mar buys are internal — no double-count.
    expect(s.netContributed).toBe("1200");
    expect(s.monthsActive).toBe(1);
  });

  it("inside is the default boundary", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "deposit", price: "100", executedAt: new Date("2026-01-05") }),
      tx({ type: "buy", quantity: "1", price: "100", executedAt: new Date("2026-01-15") }),
    ];
    expect(contributionStats({ txns, displayCurrency: "EUR" }).netContributed).toBe("100");
  });
});

describe("contributionStats — cash OUTSIDE the boundary", () => {
  it("counts net invested capital (buys + savings_plan), ignoring deposits", () => {
    const txns: CoreTransaction[] = [
      // A deposit that "inside" would count — ignored here.
      tx({ type: "deposit", price: "9999", executedAt: new Date("2026-01-05") }),
      tx({ type: "buy", quantity: "5", price: "100", fees: "1", executedAt: new Date("2026-01-15") }),
      tx({ type: "savings_plan", quantity: "2", price: "100", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.totalContributed).toBe("701"); // 501 + 200; deposit ignored
    expect(s.series[0]).toEqual({ month: "2026-01", contributed: "501" });
    expect(s.series[1]).toEqual({ month: "2026-02", contributed: "200" });
  });

  it("invest-only snapshot (buys, no deposits) counts the buys", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "5", price: "100", executedAt: new Date("2026-01-15") }),
      tx({ type: "buy", quantity: "2", price: "100", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.netContributed).toBe("700");
    expect(s.monthsActive).toBe(2);
  });

  it("excludes saveback reinvestment but keeps round-ups", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "5", price: "100", executedAt: new Date("2026-01-10") }),
      // Broker-credited reinvestment — not the user's money, excluded.
      tx({ type: "savings_plan", quantity: "1", price: "50", kind: "saveback", executedAt: new Date("2026-01-12") }),
      // Round-up is the user's own spare change — kept.
      tx({ type: "buy", quantity: "1", price: "30", kind: "roundup", executedAt: new Date("2026-01-14") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.netContributed).toBe("530"); // 500 + 30; the 50 saveback excluded
  });

  it("subtracts sells at running average cost", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "10", price: "100", executedAt: new Date("2026-01-15") }),
      tx({ type: "sell", quantity: "4", price: "150", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    // avg cost 100 → cost-of-sold 400 (NOT the 600 proceeds, which would leak the gain).
    expect(s.totalContributed).toBe("1000");
    expect(s.totalWithdrawn).toBe("400");
    expect(s.netContributed).toBe("600");
  });

  it("counts a tagged transfer-in at its carried cost, not a bonus share", () => {
    const txns: CoreTransaction[] = [
      // Inbound securities transfer with a carried basis → contributed capital.
      tx({ type: "bonus", quantity: "5", price: "100", kind: "transfer_in", executedAt: new Date("2026-01-15") }),
      // Free bonus / corporate-action shares (no cost) → not a contribution.
      tx({ type: "bonus", quantity: "5", price: "0", executedAt: new Date("2026-02-15") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.netContributed).toBe("500");
    expect(s.monthsActive).toBe(1);
  });

  it("never counts received income as a contribution", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "dividend", quantity: "0", price: "40", executedAt: new Date("2026-01-15") }),
      tx({ type: "interest", instrumentId: null, quantity: "0", price: "10", executedAt: new Date("2026-01-20") }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.netContributed).toBe("0");
    expect(s.monthsActive).toBe(0);
  });
});

describe("contributionStats — shared", () => {
  it("FX-converts amounts to the display currency before summing", () => {
    const txns: CoreTransaction[] = [
      tx({ type: "buy", quantity: "2", price: "100", currency: "USD", executedAt: new Date("2026-01-15") }),
    ];
    const fx = (from: string, to: string) => (from === "USD" && to === "EUR" ? "0.9" : "1");
    const s = contributionStats({ txns, displayCurrency: "EUR", fx, boundary: "outside" });
    expect(s.totalContributed).toBe("180"); // 200 USD * 0.9
  });

  it("returns zeroes when there are no contributions", () => {
    const s = contributionStats({ txns: [], displayCurrency: "EUR", boundary: "outside" });
    expect(s.totalContributed).toBe("0");
    expect(s.monthsActive).toBe(0);
    expect(s.monthlyAverage).toBe("0");
    expect(s.series).toEqual([]);
  });
});
