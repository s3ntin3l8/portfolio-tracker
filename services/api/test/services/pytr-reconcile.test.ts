import { describe, it, expect } from "vitest";
import { reconcileCash } from "../../src/services/pytr/reconcile.js";
import type { TrExportSummary } from "../../src/services/pytr/runner.js";

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
