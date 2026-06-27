import { describe, it, expect } from "vitest";
import { detectAnomalies } from "../src/anomalies.js";
import type { CoreTransaction, CorporateAction } from "../src/types.js";

const tx = (
  overrides: Partial<CoreTransaction> & { type: CoreTransaction["type"] },
): CoreTransaction & { id?: string } => ({
  id: overrides.id,
  instrumentId: "INST",
  quantity: "10",
  price: "100",
  fees: "0",
  currency: "EUR",
  executedAt: new Date("2024-01-01"),
  ...overrides,
});

const splitCA = (ratio: string, exDate = "2024-06-01"): CorporateAction => ({
  instrumentId: "INST",
  type: "split",
  ratio,
  exDate: new Date(exDate),
});

const bonusCA = (ratio: string, exDate = "2024-06-01"): CorporateAction => ({
  instrumentId: "INST",
  type: "bonus",
  ratio,
  exDate: new Date(exDate),
});

// ── Quantity integrity ─────────────────────────────────────────────────────────

describe("oversell", () => {
  it("flags a sell exceeding available quantity", () => {
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "5", executedAt: new Date("2024-01-01") }),
      tx({ type: "sell", quantity: "10", id: "sell-1", executedAt: new Date("2024-02-01") }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "oversell",
      severity: "error",
      scope: "transaction",
      transactionId: "sell-1",
      instrumentId: "INST",
      meta: { available: "5", attempted: "10" },
    });
  });

  it("does NOT flag a sell exactly consuming available quantity", () => {
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "10", executedAt: new Date("2024-01-01") }),
      tx({ type: "sell", quantity: "10", executedAt: new Date("2024-02-01") }),
    ]);
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT flag an oversell after a 2:1 split", () => {
    // buy 10 → split 2:1 → 20 available → sell 15 is NOT an oversell
    const anomalies = detectAnomalies(
      [
        tx({ type: "buy", quantity: "10", executedAt: new Date("2024-01-01") }),
        tx({ type: "sell", quantity: "15", executedAt: new Date("2024-07-01") }),
      ],
      [splitCA("2")],
    );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT flag an oversell after a bonus issue", () => {
    // buy 10 → 1:10 bonus (+1 share per 10) → 11 available → sell 11 is fine
    const anomalies = detectAnomalies(
      [
        tx({ type: "buy", quantity: "10", executedAt: new Date("2024-01-01") }),
        tx({ type: "sell", quantity: "11", executedAt: new Date("2024-07-01") }),
      ],
      [bonusCA("0.1")],
    );
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT flag an oversell after a `bonus` share receipt", () => {
    // buy 5 → bonus 5 free shares → 10 available → sell 10 is fine (bonus counts as holdings)
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "5", executedAt: new Date("2024-01-01") }),
      tx({ type: "bonus", quantity: "5", price: "0", executedAt: new Date("2024-02-01") }),
      tx({ type: "sell", quantity: "10", executedAt: new Date("2024-03-01") }),
    ]);
    expect(anomalies).toHaveLength(0);
  });

  it("does NOT flag a zero-price `bonus` as a zero_price anomaly", () => {
    const anomalies = detectAnomalies([
      tx({ type: "bonus", quantity: "5", price: "0", executedAt: new Date("2024-01-01") }),
    ]);
    expect(anomalies).toHaveLength(0);
  });

  it("flags transfer_out exceeding available quantity", () => {
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "3", executedAt: new Date("2024-01-01") }),
      tx({ type: "transfer_out", quantity: "5", id: "out-1", executedAt: new Date("2024-02-01") }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ code: "oversell", transactionId: "out-1" });
  });
});

describe("sell_before_acquisition", () => {
  it("flags a sell when no shares have been acquired", () => {
    const anomalies = detectAnomalies([
      tx({ type: "sell", quantity: "5", id: "sell-early", executedAt: new Date("2024-01-01") }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "sell_before_acquisition",
      severity: "error",
      transactionId: "sell-early",
    });
  });

  it("flags sell_before_acquisition not oversell when qty=0", () => {
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "10", executedAt: new Date("2024-01-01") }),
      tx({ type: "sell", quantity: "10", executedAt: new Date("2024-02-01") }),
      tx({ type: "sell", quantity: "1", id: "second-sell", executedAt: new Date("2024-03-01") }),
    ]);
    expect(anomalies.map((a) => a.code)).toEqual(["sell_before_acquisition"]);
    expect(anomalies[0].transactionId).toBe("second-sell");
  });
});

// ── Missing basis / zero price ─────────────────────────────────────────────────

describe("missing_transfer_basis", () => {
  it("flags a transfer_in with price=0", () => {
    const anomalies = detectAnomalies([
      tx({ type: "transfer_in", price: "0", id: "tin-1" }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "missing_transfer_basis",
      severity: "warning",
      transactionId: "tin-1",
    });
  });

  it("does NOT flag a transfer_in with a real price", () => {
    const anomalies = detectAnomalies([
      tx({ type: "transfer_in", price: "42.50", id: "tin-2" }),
    ]);
    expect(anomalies).toHaveLength(0);
  });
});

describe("zero_price", () => {
  it("flags a buy with price=0", () => {
    const anomalies = detectAnomalies([tx({ type: "buy", price: "0", id: "buy-0" })]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ code: "zero_price", severity: "warning", transactionId: "buy-0" });
  });

  it("does NOT flag a zero_price on transfer_in (has its own code)", () => {
    const anomalies = detectAnomalies([tx({ type: "transfer_in", price: "0", id: "tin" })]);
    const codes = anomalies.map((a) => a.code);
    expect(codes).not.toContain("zero_price");
    expect(codes).toContain("missing_transfer_basis");
  });
});

// ── Income on non-held ─────────────────────────────────────────────────────────

describe("income_on_non_held", () => {
  it("flags a dividend when quantity is 0", () => {
    const anomalies = detectAnomalies([
      tx({ type: "dividend", id: "div-1", executedAt: new Date("2024-01-01") }),
    ]);
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ code: "income_on_non_held", transactionId: "div-1" });
  });

  it("does NOT flag a dividend when shares are held", () => {
    const anomalies = detectAnomalies([
      tx({ type: "buy", quantity: "5", executedAt: new Date("2024-01-01") }),
      tx({ type: "dividend", id: "div-2", executedAt: new Date("2024-02-01") }),
    ]);
    expect(anomalies).toHaveLength(0);
  });
});

// ── Cash integrity ─────────────────────────────────────────────────────────────

describe("negative_cash", () => {
  it("flags the first transaction that drives cash negative (cash-inside only)", () => {
    const txns = [
      tx({
        type: "deposit",
        instrumentId: null,
        quantity: "1",
        price: "100",
        id: "dep",
        executedAt: new Date("2024-01-01"),
      }),
      tx({
        type: "withdrawal",
        instrumentId: null,
        quantity: "1",
        price: "200",
        id: "wdraw",
        executedAt: new Date("2024-02-01"),
      }),
    ];
    const anomalies = detectAnomalies(txns, [], { cashCounted: true });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "negative_cash",
      severity: "error",
      transactionId: "wdraw",
      meta: { currency: "EUR" },
    });
  });

  it("does NOT flag negative cash when cashCounted=false", () => {
    const txns = [
      tx({
        type: "withdrawal",
        instrumentId: null,
        quantity: "1",
        price: "999",
        id: "wdraw",
        executedAt: new Date("2024-01-01"),
      }),
    ];
    const anomalies = detectAnomalies(txns, [], { cashCounted: false });
    expect(anomalies).toHaveLength(0);
  });

  it("only flags the first crossing, not subsequent deeper dips", () => {
    const txns = [
      tx({ type: "deposit", instrumentId: null, quantity: "1", price: "10", id: "dep", executedAt: new Date("2024-01-01") }),
      tx({ type: "withdrawal", instrumentId: null, quantity: "1", price: "15", id: "w1", executedAt: new Date("2024-02-01") }),
      tx({ type: "withdrawal", instrumentId: null, quantity: "1", price: "5", id: "w2", executedAt: new Date("2024-03-01") }),
    ];
    const anomalies = detectAnomalies(txns, [], { cashCounted: true });
    const negs = anomalies.filter((a) => a.code === "negative_cash");
    expect(negs).toHaveLength(1);
    expect(negs[0].transactionId).toBe("w1");
  });
});

// ── Reconciliation gap ─────────────────────────────────────────────────────────

describe("reconciliation_gap", () => {
  it("flags a gap exceeding the threshold", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [{ currency: "EUR", reported: "1000.00", derived: "934.29", diff: "65.71" }],
      },
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "reconciliation_gap",
      severity: "warning",
      scope: "portfolio",
      meta: { currency: "EUR", diff: "65.71" },
    });
  });

  it("tolerates a sub-euro standing gap under the absolute threshold", () => {
    // A small standing gap (below €1, no fresh drift since the previous sync) must not raise
    // the absolute-gap warning. The incremental drift guard handles new divergence separately.
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [{ currency: "EUR", reported: "1000.00", derived: "999.17", diff: "0.83" }],
      },
    });
    expect(anomalies).toHaveLength(0);
  });

  it("still flags a gap above €1 (a genuinely missed/extra transaction)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [{ currency: "EUR", reported: "100.00", derived: "98.50", diff: "1.50" }],
      },
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({ code: "reconciliation_gap", meta: { diff: "1.50" } });
  });

  it("ignores null reconciliationGap", () => {
    const anomalies = detectAnomalies([], [], { reconciliationGap: null });
    expect(anomalies).toHaveLength(0);
  });
});

describe("reconciliation_drift (incremental guard)", () => {
  it("flags a fresh drift since the previous sync even when the absolute gap is tiny", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        // Absolute gap (0.60) is below the €1 gap threshold, so no reconciliation_gap — but it
        // moved 0.60 since last sync, above the €0.50 drift bound → a drift warning.
        cash: [
          { currency: "EUR", reported: "100.00", derived: "99.40", diff: "0.60", driftSincePrev: "0.60" },
        ],
      },
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "reconciliation_drift",
      severity: "warning",
      scope: "portfolio",
      meta: { currency: "EUR", diff: "0.60", driftSincePrev: "0.60" },
    });
  });

  it("does NOT flag a large but STABLE gap (big diff, no movement since last sync)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        // A €26.70 standing gap that did not move this sync: the absolute-gap warning fires,
        // but the incremental drift guard stays quiet (driftSincePrev within the bound).
        cash: [
          { currency: "EUR", reported: "100.00", derived: "73.30", diff: "26.70", driftSincePrev: "0.00" },
        ],
      },
    });
    expect(anomalies.map((a) => a.code)).toEqual(["reconciliation_gap"]);
  });

  it("does not flag when drift is below the bound", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [
          { currency: "EUR", reported: "100.00", derived: "99.70", diff: "0.30", driftSincePrev: "0.30" },
        ],
      },
    });
    expect(anomalies).toHaveLength(0);
  });

  it("does not flag on the first sync (no prior baseline → driftSincePrev absent)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [{ currency: "EUR", reported: "100.00", derived: "99.40", diff: "0.60" }],
      },
    });
    expect(anomalies).toHaveLength(0); // 0.60 < €1 gap, and no drift baseline to compare
  });

  it("flags both a standing gap and fresh drift independently", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [
          { currency: "EUR", reported: "100.00", derived: "97.50", diff: "2.50", driftSincePrev: "1.00" },
        ],
      },
    });
    expect(anomalies.map((a) => a.code).sort()).toEqual([
      "reconciliation_drift",
      "reconciliation_gap",
    ]);
  });
});

// ── Position gap ─────────────────────────────────────────────────────────────

describe("position_gap", () => {
  it("flags a position gap exceeding the threshold (0.0001 shares)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [],
        positions: [{ isin: "DE000A0D9PT0", reported: "10.000000", derived: "9.000000", diff: "1.000000" }],
      },
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]).toMatchObject({
      code: "position_gap",
      severity: "warning",
      scope: "portfolio",
      meta: { isin: "DE000A0D9PT0", reported: "10.000000", derived: "9.000000", diff: "1.000000" },
    });
  });

  it("does NOT flag a position gap within the threshold (< 0.0001 shares)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [],
        positions: [{ isin: "DE000A0D9PT0", reported: "10.000000", derived: "10.000050", diff: "0.000050" }],
      },
    });
    expect(anomalies).toHaveLength(0);
  });

  it("flags multiple position gaps independently", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [],
        positions: [
          { isin: "IE00B4L5Y983", reported: "5.500000", derived: "5.000000", diff: "0.500000" },
          { isin: "US5949181045", reported: "0.000000", derived: "2.000000", diff: "-2.000000" },
          { isin: "DE000A0D9PT0", reported: "1.000000", derived: "1.000001", diff: "0.000001" },
        ],
      },
    });
    const gaps = anomalies.filter((a) => a.code === "position_gap");
    expect(gaps).toHaveLength(2);
    expect(gaps.map((g) => (g.meta as Record<string, unknown>).isin)).toEqual(
      expect.arrayContaining(["IE00B4L5Y983", "US5949181045"]),
    );
  });

  it("handles missing positions field on reconciliationGap (backward compat)", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: {
        cash: [{ currency: "EUR", reported: "100.00", derived: "100.00", diff: "0.00" }],
        // positions absent — older sync record
      },
    });
    expect(anomalies).toHaveLength(0);
  });

  it("ignores null positions field", () => {
    const anomalies = detectAnomalies([], [], {
      reconciliationGap: { cash: [], positions: null },
    });
    expect(anomalies).toHaveLength(0);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe("edge cases", () => {
  it("returns empty array for empty transactions", () => {
    expect(detectAnomalies([])).toEqual([]);
  });

  it("ignores cash transactions (null instrumentId) in the qty pass", () => {
    const anomalies = detectAnomalies([
      tx({ type: "deposit", instrumentId: null, quantity: "1", price: "1000" }),
    ]);
    expect(anomalies).toHaveLength(0);
  });

  it("handles multiple instruments independently", () => {
    const anomalies = detectAnomalies([
      { ...tx({ type: "buy", quantity: "10" }), instrumentId: "A", executedAt: new Date("2024-01-01") },
      { ...tx({ type: "sell", quantity: "5" }), instrumentId: "A", executedAt: new Date("2024-02-01") },
      { ...tx({ type: "sell", quantity: "3", id: "b-sell" }), instrumentId: "B", executedAt: new Date("2024-01-01") },
    ]);
    const codes = anomalies.map((a) => a.code);
    expect(codes).toEqual(["sell_before_acquisition"]);
    expect(anomalies[0].instrumentId).toBe("B");
  });
});
