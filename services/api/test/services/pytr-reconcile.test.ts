import { describe, it, expect } from "vitest";
import { reconcileCash, netManualAdjustments } from "../../src/services/pytr/reconcile.js";
import type { TrExportSummary } from "../../src/services/pytr/runner.js";
import type { CoreTransaction, ReconciliationGap } from "@portfolio/core";

const summary = (amount: string): TrExportSummary => ({
  cash: [{ currency: "EUR", amount }],
});

describe("reconcileCash", () => {
  it("treats a saveback buy as cash-neutral, matching @portfolio/core's cashFlow()", () => {
    // SAVEBACK_AGGREGATE maps to a `savings_plan` buy with kind:"saveback". The reward
    // credit that funds it is never emitted as a separate event on TR's feed, so cashFlow()
    // special-cases kind:"saveback"/"crypto_bonus" to be fee-only. Before this fix,
    // reconcileCash stripped `kind` when building CoreTransaction, so the shortcut never
    // fired and this buy was counted as a full outflow — understating derived cash by
    // exactly the reward amount (here: 73).
    const events = [
      {
        id: "evt-saveback",
        timestamp: "2026-01-02T10:00:00.000Z",
        eventType: "SAVEBACK_AGGREGATE",
        status: "EXECUTED",
        amount: -73,
        shares: 1,
        isin: "IE00B5BMR087",
        currency: "EUR",
      },
    ];

    const rec = reconcileCash(events, summary("73.00"));
    expect(rec?.cash).toEqual([
      expect.objectContaining({ currency: "EUR", reported: "73.00", derived: "0", diff: "73.00" }),
    ]);
  });

  it("counts a plain buy (no reward kind) as a real cash outflow", () => {
    const events = [
      {
        id: "evt-buy",
        timestamp: "2026-01-02T10:00:00.000Z",
        eventType: "ORDER_EXECUTED",
        status: "EXECUTED",
        amount: -100,
        shares: 1,
        isin: "DE0007236101",
        currency: "EUR",
      },
    ];

    const rec = reconcileCash(events, summary("0"));
    expect(rec?.cash).toEqual([
      expect.objectContaining({ currency: "EUR", reported: "0", derived: "-100", diff: "100.00" }),
    ]);
  });

  it("treats a crypto-bonus buy as cash-neutral", () => {
    const events = [
      {
        id: "evt-crypto-bonus",
        timestamp: "2025-12-11T16:00:00.000Z",
        eventType: "ORDER_EXECUTED",
        status: "EXECUTED",
        amount: -20.11,
        shares: 1,
        isin: "XF000BTC0017",
        currency: "EUR",
        kind: "crypto_bonus",
      },
    ];

    const rec = reconcileCash(events, summary("0"));
    expect(rec?.cash).toEqual([
      expect.objectContaining({ currency: "EUR", reported: "0", derived: "0", diff: "0.00" }),
    ]);
  });
});

function adjustmentTx(p: Partial<CoreTransaction>): CoreTransaction {
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

describe("netManualAdjustments", () => {
  // reconcileCash is deliberately feed-only (mapTrEvents) and never sees stored rows — a
  // manual `adjustment` transaction must be folded in separately at read time, or booking
  // the true-up would fix holdings cash but leave reconciliation_gap firing forever.
  const gap: ReconciliationGap = {
    cash: [{ currency: "EUR", reported: "3437.40", derived: "3466.12", diff: "-28.72" }],
  };

  it("offsets derived/diff by the summed adjustment cashFlow, clearing the gap", () => {
    const result = netManualAdjustments(gap, [adjustmentTx({ price: "-26.70" })]);
    expect(result.cash).toEqual([
      expect.objectContaining({ currency: "EUR", reported: "3437.40", derived: "3439.42", diff: "-2.02" }),
    ]);
  });

  it("is a no-op when there are no adjustment transactions", () => {
    const result = netManualAdjustments(gap, [
      { ...adjustmentTx({ type: "buy", quantity: "1", price: "100" }) },
    ]);
    expect(result).toEqual(gap);
  });

  it("ignores a draft-status adjustment (unconfirmed, cashFlow zeroes it)", () => {
    const result = netManualAdjustments(gap, [
      adjustmentTx({ price: "-26.70", status: "draft" }),
    ]);
    expect(result).toEqual(gap);
  });

  it("only nets adjustments in the matching currency", () => {
    const usdGap: ReconciliationGap = {
      cash: [
        { currency: "EUR", reported: "100", derived: "100", diff: "0.00" },
        { currency: "USD", reported: "50", derived: "50", diff: "0.00" },
      ],
    };
    const result = netManualAdjustments(usdGap, [adjustmentTx({ price: "-10", currency: "USD" })]);
    expect(result.cash).toEqual([
      expect.objectContaining({ currency: "EUR", derived: "100", diff: "0.00" }),
      expect.objectContaining({ currency: "USD", derived: "40", diff: "10.00" }),
    ]);
  });
});
