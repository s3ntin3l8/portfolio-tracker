/**
 * Tests for the first-class `adjustment` transaction type (3b remediation: manual signed
 * cash true-up for a known broker-feed-vs-reality gap with no automated fix — see
 * .claude/plans/can-we-investigate-my-warm-honey.md).
 * Covers: cashFlow (signed, both directions), cashBalances, valuation's cashTracked gate,
 * contributions/XIRR exclusion (it's a bookkeeping correction, never a contribution),
 * and detectAnomalies (participates in the cash pass, skips the per-instrument pass).
 */
import { describe, it, expect } from "vitest";
import {
  cashFlow,
  cashBalances,
  summarizePortfolio,
  contributionStats,
  detectAnomalies,
} from "../src/index.js";
import type { CoreTransaction } from "../src/index.js";

function tx(p: Partial<CoreTransaction>): CoreTransaction {
  return {
    instrumentId: null,
    type: "adjustment",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "EUR",
    executedAt: new Date("2026-07-08"),
    ...p,
  };
}

// ---------------------------------------------------------------------------
// cashFlow — the sign comes from the user's entered price, not the type
// ---------------------------------------------------------------------------
describe("cashFlow — adjustment", () => {
  it("negative price lowers cash by exactly that amount", () => {
    const t = tx({ price: "-26.70" });
    expect(cashFlow(t).toString()).toBe("-26.7");
  });

  it("positive price raises cash by exactly that amount", () => {
    const t = tx({ price: "26.70" });
    expect(cashFlow(t).toString()).toBe("26.7");
  });

  it("fees (if ever set) subtract from the signed amount", () => {
    const t = tx({ price: "-26.70", fees: "1" });
    expect(cashFlow(t).toString()).toBe("-27.7");
  });

  it("cashBalances nets an adjustment alongside a deposit in the same currency", () => {
    const txns = [tx({ type: "deposit", price: "1000" }), tx({ price: "-26.70" })];
    expect(cashBalances(txns).EUR).toBe("973.3");
  });
});

// ---------------------------------------------------------------------------
// summarizePortfolio — an adjustment alone switches on cash tracking (hasCashMovement)
// ---------------------------------------------------------------------------
describe("summarizePortfolio — adjustment counts as a cash movement", () => {
  it("an adjustment-only portfolio still tracks and counts cash", () => {
    const summary = summarizePortfolio({
      transactions: [tx({ price: "-26.70" })],
      prices: {},
      displayCurrency: "EUR",
      cashCounted: true,
    });
    expect(summary.cashTracked).toBe(true);
    expect(summary.cash.EUR).toBe("-26.7");
  });
});

// ---------------------------------------------------------------------------
// contributionStats — an adjustment is a bookkeeping correction, never a contribution
// ---------------------------------------------------------------------------
describe("contributionStats — adjustment is excluded from contributions", () => {
  it("inside boundary: a deposit + adjustment only contributes the deposit", () => {
    const txns = [tx({ type: "deposit", price: "1000" }), tx({ price: "-26.70" })];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "inside" });
    expect(s.totalContributed).toBe("1000");
    expect(s.totalWithdrawn).toBe("0");
  });

  it("outside boundary: a null-instrument adjustment contributes nothing", () => {
    const txns = [
      tx({ type: "buy", instrumentId: "inst-a", quantity: "10", price: "100" }),
      tx({ price: "-26.70" }),
    ];
    const s = contributionStats({ txns, displayCurrency: "EUR", boundary: "outside" });
    expect(s.totalContributed).toBe("1000");
    expect(s.totalWithdrawn).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// detectAnomalies — participates in the cash-integrity pass, skipped by the
// per-instrument pass (null instrumentId)
// ---------------------------------------------------------------------------
describe("detectAnomalies — adjustment", () => {
  it("a negative adjustment can trip negative_cash like any other outflow", () => {
    const txns = [tx({ price: "-50" })];
    const anomalies = detectAnomalies(txns, [], { cashCounted: true });
    expect(anomalies.some((a) => a.code === "negative_cash")).toBe(true);
  });

  it("a positive adjustment never trips zero_price/income_on_non_held (null instrument)", () => {
    const txns = [tx({ price: "26.70" })];
    const anomalies = detectAnomalies(txns, [], { cashCounted: true });
    expect(anomalies).toEqual([]);
  });
});
