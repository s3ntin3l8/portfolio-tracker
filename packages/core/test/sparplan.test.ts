import { describe, it, expect } from "vitest";
import { detectSparplans, mergeSparplanStats, type SparplanStats } from "../src/index.js";
import type { CoreTransaction } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tx(p: Partial<CoreTransaction> & { executedAt: Date }): CoreTransaction {
  return {
    instrumentId: "inst-etf",
    type: "savings_plan",
    quantity: "1",
    price: "100",
    fees: "0",
    currency: "EUR",
    ...p,
  };
}

/** No-op FX function (single-currency tests). */
const noFx = () => "1";

/** Fixed "today" so all active/stopped checks are deterministic. */
const NOW = new Date("2026-06-15T00:00:00.000Z");

// Monthly execution dates: first day of each month.
function monthlyDates(from: string, count: number): Date[] {
  const [y, m] = from.split("-").map(Number);
  const dates: Date[] = [];
  for (let i = 0; i < count; i++) {
    const mo = ((m - 1 + i) % 12) + 1;
    const yr = y + Math.floor((m - 1 + i) / 12);
    dates.push(new Date(`${yr}-${String(mo).padStart(2, "0")}-05T00:00:00.000Z`));
  }
  return dates;
}

// ---------------------------------------------------------------------------
// Tagged monthly plan — happy path
// ---------------------------------------------------------------------------

describe("detectSparplans — tagged monthly plan", () => {
  it("detects a basic tagged plan: one level, active", () => {
    const dates = monthlyDates("2026-01", 6);
    const txns = dates.map((d) =>
      tx({ type: "savings_plan", quantity: "1.5", price: "100", executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });

    expect(stats.plans).toHaveLength(1);
    const p = stats.plans[0];
    expect(p.source).toBe("tagged");
    expect(p.cadenceMonths).toBe(1);
    expect(p.status).toBe("active");
    expect(p.executionCount).toBe(6);
    expect(Number(p.currentAmount)).toBeCloseTo(150, 0);
    expect(p.levels).toHaveLength(1);
    expect(p.levels[0].executionCount).toBe(6);
    expect(p.levels[0].until).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Step-increase detection
// ---------------------------------------------------------------------------

describe("detectSparplans — step increase", () => {
  it("detects a level increase from €100 to €150", () => {
    const dates100 = monthlyDates("2025-09", 4); // 4 months @ €100
    const dates150 = monthlyDates("2026-01", 4); // 4 months @ €150
    const txns = [
      ...dates100.map((d) => tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: d })),
      ...dates150.map((d) => tx({ type: "savings_plan", quantity: "1", price: "150", executedAt: d })),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    const p = stats.plans[0];
    expect(p.levels).toHaveLength(2);
    expect(Number(p.levels[0].amount)).toBeCloseTo(100, 0);
    expect(p.levels[0].until).not.toBeNull();
    expect(Number(p.levels[1].amount)).toBeCloseTo(150, 0);
    expect(p.levels[1].until).toBeNull();
    expect(Number(p.currentAmount)).toBeCloseTo(150, 0);
  });

  it("folds a lone-execution level sandwiched between equal levels", () => {
    // 3× €100, then 1× €200 (one-off top-up), then 3× €100 → stays as one level
    const dates = monthlyDates("2025-10", 7);
    const prices = [100, 100, 100, 200, 100, 100, 100];
    const txns = dates.map((d, i) =>
      tx({ type: "savings_plan", quantity: "1", price: String(prices[i]), executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    const p = stats.plans[0];
    // The lone €200 should be folded back; result is 1 level at €100.
    expect(p.levels).toHaveLength(1);
    expect(Number(p.currentAmount)).toBeCloseTo(100, 0);
  });
});

// ---------------------------------------------------------------------------
// TR same-day split fills
// ---------------------------------------------------------------------------

describe("detectSparplans — TR same-day split fills", () => {
  it("collapses same-day fills into one execution", () => {
    const day = new Date("2026-05-15T00:00:00.000Z");
    const txns = [
      // Main fill: €50
      tx({ type: "savings_plan", quantity: "0.081433", price: "614.00", executedAt: day }),
      // Fractional fills on the same day — total ≈ €4.59
      tx({ type: "savings_plan", quantity: "0.003440", price: "610.36", executedAt: new Date("2026-05-15T14:00:00.000Z") }),
      tx({ type: "savings_plan", quantity: "0.000655", price: "610.36", executedAt: new Date("2026-05-15T15:00:00.000Z") }),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    // Should be one execution (one day collapsed), not three.
    expect(stats.plans[0].executionCount).toBe(1);
    // Total ≈ 50.0 + 2.1 + 0.4 ≈ 52.5 — one combined execution.
    expect(Number(stats.plans[0].currentAmount)).toBeGreaterThan(50);
  });

  it("treats different days as separate executions", () => {
    const dates = monthlyDates("2026-01", 3);
    const txns = dates.flatMap((d) => [
      tx({ type: "savings_plan", quantity: "0.081", price: "617.00", executedAt: d }),
      tx({ type: "savings_plan", quantity: "0.001", price: "617.00", executedAt: d }),
    ]);
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans[0].executionCount).toBe(3); // 3 days, not 6 rows
  });
});

// ---------------------------------------------------------------------------
// saveback / roundup exclusion
// ---------------------------------------------------------------------------

describe("detectSparplans — saveback/roundup exclusion", () => {
  it("excludes saveback rows from amount and cadence", () => {
    // A saveback row (type: savings_plan, kind: saveback) should be ignored.
    const dates = monthlyDates("2026-01", 4);
    const txns = [
      ...dates.map((d) => tx({ type: "savings_plan", quantity: "1", price: "150", executedAt: d })),
      // Saveback row — should not be detected.
      tx({
        type: "savings_plan",
        kind: "saveback",
        quantity: "0.5",
        price: "150",
        executedAt: new Date("2026-03-20T00:00:00.000Z"),
      }),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].executionCount).toBe(4); // not 5
    expect(Number(stats.plans[0].currentAmount)).toBeCloseTo(150, 0);
  });

  it("excludes roundup rows", () => {
    const dates = monthlyDates("2026-01", 3);
    const txns = [
      ...dates.map((d) => tx({ type: "buy", quantity: "0.1", price: "100", executedAt: d })),
      // Roundup row — should not be detected as part of any plan.
      tx({
        type: "buy",
        kind: "roundup",
        quantity: "0.01",
        price: "100",
        executedAt: new Date("2026-02-10T00:00:00.000Z"),
      }),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    // Heuristic detection: only 3 plain buy rows (roundup excluded).
    const plan = stats.plans[0];
    expect(plan).toBeDefined();
    expect(plan.source).toBe("heuristic");
    expect(plan.executionCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Heuristic detection
// ---------------------------------------------------------------------------

describe("detectSparplans — heuristic", () => {
  it("detects 3 evenly-spaced plain buys as heuristic", () => {
    const dates = monthlyDates("2026-01", 3);
    const txns = dates.map((d) =>
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].source).toBe("heuristic");
  });

  it("does NOT detect 2 plain buys (below threshold)", () => {
    const dates = monthlyDates("2026-01", 2);
    const txns = dates.map((d) =>
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(0);
  });

  it("does NOT detect irregularly-spaced buys", () => {
    // Gaps: 1, 6, 1 months — not roughly even.
    const txns = [
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: new Date("2026-01-05T00:00:00.000Z") }),
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: new Date("2026-02-05T00:00:00.000Z") }),
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: new Date("2026-08-05T00:00:00.000Z") }),
      tx({ type: "buy", quantity: "0.5", price: "100", executedAt: new Date("2026-09-05T00:00:00.000Z") }),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tagged precedence
// ---------------------------------------------------------------------------

describe("detectSparplans — tagged precedence", () => {
  it("uses only tagged rows when tagged rows exist, ignoring the lump buy", () => {
    const dates = monthlyDates("2026-01", 4);
    const txns = [
      ...dates.map((d) =>
        tx({ type: "savings_plan", quantity: "1", price: "150", executedAt: d }),
      ),
      // A €1000 lump buy on a different day — should NOT pollute the plan's levels.
      tx({
        type: "buy",
        quantity: "6",
        price: "166.67",
        executedAt: new Date("2026-03-20T00:00:00.000Z"),
      }),
    ];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].levels).toHaveLength(1);
    expect(Number(stats.plans[0].currentAmount)).toBeCloseTo(150, 0);
    expect(stats.plans[0].executionCount).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Active / stopped status
// ---------------------------------------------------------------------------

describe("detectSparplans — active/stopped", () => {
  it("marks a plan as stopped when last execution is >1.5x cadence in the past", () => {
    // Monthly plan, last execution 4 months ago (> 1.5 months).
    const dates = monthlyDates("2025-09", 4); // last = 2025-12
    const txns = dates.map((d) =>
      tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans[0].status).toBe("stopped");
    expect(stats.activePlanCount).toBe(0);
    expect(Number(stats.activeMonthlyTotalDisplay)).toBe(0);
  });

  it("marks a plan as active when last execution is within 1.5x cadence", () => {
    const dates = monthlyDates("2026-01", 5); // last = 2026-05
    const txns = dates.map((d) =>
      tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: d }),
    );
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans[0].status).toBe("active");
    expect(stats.activePlanCount).toBe(1);
    expect(Number(stats.activeMonthlyTotalDisplay)).toBeCloseTo(100, 0);
  });
});

// ---------------------------------------------------------------------------
// FX — no phantom steps from currency drift
// ---------------------------------------------------------------------------

describe("detectSparplans — FX handling", () => {
  it("detects levels in native EUR, not in display IDR", () => {
    // 6 executions at €150 — in IDR at rates that drift, but no step increase in EUR.
    const dates = monthlyDates("2026-01", 6);
    const txns = dates.map((d) =>
      tx({ type: "savings_plan", quantity: "1", price: "150", currency: "EUR", executedAt: d }),
    );
    // FX drifts from 17000 to 17500 over the period — should NOT cause level splits.
    const stats = detectSparplans({
      txns,
      displayCurrency: "IDR",
      fx: (from, to) => (from === "EUR" && to === "IDR" ? "17200" : "1"),
      now: NOW,
    });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].levels).toHaveLength(1);
    expect(stats.plans[0].currency).toBe("EUR");
    expect(Number(stats.plans[0].currentAmount)).toBeCloseTo(150, 0);
    expect(Number(stats.plans[0].currentAmountDisplay)).toBeCloseTo(150 * 17200, -3);
  });
});

// ---------------------------------------------------------------------------
// Single execution (tagged)
// ---------------------------------------------------------------------------

describe("detectSparplans — single execution", () => {
  it("tagged single execution defaults to monthly cadence", () => {
    const txns = [tx({ type: "savings_plan", quantity: "1", price: "100", executedAt: NOW })];
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].cadenceMonths).toBe(1);
    expect(stats.plans[0].executionCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Restarted plan / long gap
// ---------------------------------------------------------------------------

describe("detectSparplans — restarted plan", () => {
  it("treats a plan with a >14-month gap as one plan with one level", () => {
    // €150 for 3 months, then 18-month gap, then €150 for 3 more months.
    const earlyDates = monthlyDates("2024-01", 3);
    const lateDates = monthlyDates("2025-07", 3); // 18 months later
    const txns = [
      ...earlyDates.map((d) =>
        tx({ type: "savings_plan", quantity: "1", price: "150", executedAt: d }),
      ),
      ...lateDates.map((d) =>
        tx({ type: "savings_plan", quantity: "1", price: "150", executedAt: d }),
      ),
    ];
    // inferIntervalMonths drops the >14-month gap so it still reads as monthly.
    const stats = detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    expect(stats.plans).toHaveLength(1);
    expect(stats.plans[0].levels).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// mergeSparplanStats — aggregate double-counting guard
// ---------------------------------------------------------------------------

describe("mergeSparplanStats", () => {
  it("sums two portfolios' identical plans, not deduplicates", () => {
    const dates = monthlyDates("2026-01", 5);
    const make = (id: string): SparplanStats => {
      const txns = dates.map((d) =>
        tx({ instrumentId: id, type: "savings_plan", quantity: "1", price: "150", executedAt: d }),
      );
      return detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    };

    // Portfolio A: VWCE €150/mo; Portfolio B: also VWCE €150/mo (different portfolio).
    const a = make("vwce");
    const b = make("vwce");
    const merged = mergeSparplanStats([a, b], "EUR");

    // Total should be €300, NOT €150 (not deduplicated across portfolios).
    expect(Number(merged.activeMonthlyTotalDisplay)).toBeCloseTo(300, 0);
    expect(merged.activePlanCount).toBe(2);
    // Both plans appear in the list (separately, not merged).
    expect(merged.plans).toHaveLength(2);
  });

  it("sums two portfolios' different instruments", () => {
    const dates = monthlyDates("2026-01", 5);
    const makeStats = (instId: string, amount: number): SparplanStats => {
      const txns = dates.map((d) =>
        tx({ instrumentId: instId, type: "savings_plan", quantity: "1", price: String(amount), executedAt: d }),
      );
      return detectSparplans({ txns, displayCurrency: "EUR", fx: noFx, now: NOW });
    };
    const a = makeStats("vwce", 150);
    const b = makeStats("eimi", 25);
    const merged = mergeSparplanStats([a, b], "EUR");
    expect(Number(merged.activeMonthlyTotalDisplay)).toBeCloseTo(175, 0);
    expect(merged.plans).toHaveLength(2);
  });

  it("empty input returns zero totals", () => {
    const merged = mergeSparplanStats([], "EUR");
    expect(merged.plans).toHaveLength(0);
    expect(Number(merged.activeMonthlyTotalDisplay)).toBe(0);
    expect(merged.activePlanCount).toBe(0);
  });
});
