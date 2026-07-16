import { describe, it, expect } from "vitest";
import { rebalancingDrift, rebalancingTrades, contributionSplit } from "../src/rebalancing.js";
import type { AllocationSlice } from "../src/allocation.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function slice(key: string, value: number, pct: number): AllocationSlice {
  return { key, value: String(value), pct };
}

// ---------------------------------------------------------------------------
// rebalancingDrift
// ---------------------------------------------------------------------------

describe("rebalancingDrift", () => {
  it("returns empty array when no targets given", () => {
    const slices = [slice("equity", 7000, 70), slice("bond", 3000, 30)];
    expect(rebalancingDrift(slices, [])).toEqual([]);
  });

  it("classifies on_target within default band (5pp)", () => {
    const slices = [slice("equity", 7200, 72), slice("bond", 2800, 28)];
    const targets = [
      { key: "equity", targetPct: 70 },
      { key: "bond", targetPct: 30 },
    ];
    const drift = rebalancingDrift(slices, targets);
    // 72 − 70 = +2 pp → within default 5pp band → on_target
    expect(drift[0].status).toBe("on_target");
    // 28 − 30 = −2 pp → within default 5pp band → on_target
    expect(drift[1].status).toBe("on_target");
  });

  it("classifies over and under correctly outside band", () => {
    const slices = [slice("equity", 8000, 80), slice("bond", 2000, 20)];
    const targets = [
      { key: "equity", targetPct: 70 },
      { key: "bond", targetPct: 30 },
    ];
    const drift = rebalancingDrift(slices, targets);
    expect(drift[0].status).toBe("over");
    expect(drift[0].driftPct).toBeCloseTo(10, 3);
    expect(drift[1].status).toBe("under");
    expect(drift[1].driftPct).toBeCloseTo(-10, 3);
  });

  it("returns zero actualPct and actualValue for keys not in slices", () => {
    const slices = [slice("equity", 10000, 100)];
    const targets = [
      { key: "equity", targetPct: 70 },
      { key: "bond", targetPct: 30 }, // not present in slices
    ];
    const drift = rebalancingDrift(slices, targets);
    const bondRow = drift.find((r) => r.key === "bond")!;
    expect(bondRow.actualPct).toBe(0);
    expect(bondRow.actualValue).toBe("0");
    expect(bondRow.status).toBe("under");
  });

  it("respects custom band", () => {
    const slices = [slice("equity", 7200, 72), slice("bond", 2800, 28)];
    const targets = [
      { key: "equity", targetPct: 70 },
      { key: "bond", targetPct: 30 },
    ];
    const drift = rebalancingDrift(slices, targets, { bandPp: 1 });
    // 2pp drift > 1pp band → classified as over/under
    expect(drift[0].status).toBe("over");
    expect(drift[1].status).toBe("under");
  });

  it("includes correct actualValue from slices", () => {
    const slices = [slice("etf", 5000, 50), slice("cash", 5000, 50)];
    const targets = [
      { key: "etf", targetPct: 70 },
      { key: "cash", targetPct: 30 },
    ];
    const drift = rebalancingDrift(slices, targets);
    expect(drift.find((r) => r.key === "etf")!.actualValue).toBe("5000");
    expect(drift.find((r) => r.key === "cash")!.actualValue).toBe("5000");
  });
});

// ---------------------------------------------------------------------------
// rebalancingTrades — mode "trade"
// ---------------------------------------------------------------------------

describe("rebalancingTrades (trade mode)", () => {
  it("returns empty array when no drift rows", () => {
    expect(rebalancingTrades([], "10000", { mode: "trade" })).toEqual([]);
  });

  it("returns empty array when total is zero", () => {
    const drift = [
      {
        key: "equity",
        targetPct: 70,
        actualPct: 80,
        driftPct: 10,
        actualValue: "0",
        status: "over" as const,
      },
    ];
    expect(rebalancingTrades(drift, "0", { mode: "trade" })).toEqual([]);
  });

  it("skips on_target rows", () => {
    const drift = [
      {
        key: "equity",
        targetPct: 70,
        actualPct: 72,
        driftPct: 2,
        actualValue: "720",
        status: "on_target" as const,
      },
      {
        key: "bond",
        targetPct: 30,
        actualPct: 28,
        driftPct: -2,
        actualValue: "280",
        status: "on_target" as const,
      },
    ];
    expect(rebalancingTrades(drift, "1000", { mode: "trade" })).toEqual([]);
  });

  it("produces buy for under-target and sell for over-target", () => {
    const drift = [
      {
        key: "equity",
        targetPct: 70,
        actualPct: 80,
        driftPct: 10,
        actualValue: "8000",
        status: "over" as const,
      },
      {
        key: "bond",
        targetPct: 30,
        actualPct: 20,
        driftPct: -10,
        actualValue: "2000",
        status: "under" as const,
      },
    ];
    const actions = rebalancingTrades(drift, "10000", { mode: "trade" });
    const equityAction = actions.find((a) => a.key === "equity")!;
    const bondAction = actions.find((a) => a.key === "bond")!;
    expect(equityAction.side).toBe("sell");
    expect(bondAction.side).toBe("buy");
    // equity target = 7000, actual = 8000 → sell 1000
    expect(Number(equityAction.deltaValue)).toBeCloseTo(1000, 0);
    // bond target = 3000, actual = 2000 → buy 1000
    expect(Number(bondAction.deltaValue)).toBeCloseTo(1000, 0);
  });
});

// ---------------------------------------------------------------------------
// rebalancingTrades — mode "trade" with maxSellByKey (Phase D)
// ---------------------------------------------------------------------------

describe("rebalancingTrades (trade mode) with maxSellByKey", () => {
  const baseDrift = [
    {
      key: "equity",
      targetPct: 70,
      actualPct: 80,
      driftPct: 10,
      actualValue: "8000",
      status: "over" as const,
    },
    {
      key: "bond",
      targetPct: 30,
      actualPct: 20,
      driftPct: -10,
      actualValue: "2000",
      status: "under" as const,
    },
  ];

  it("caps sell to maxSellByKey when cap is smaller than computed delta", () => {
    // Uncapped: sell 1000. With cap = 400 → sell 400.
    const actions = rebalancingTrades(baseDrift, "10000", {
      mode: "trade",
      maxSellByKey: { equity: "400.00" },
    });
    const equityAction = actions.find((a) => a.key === "equity")!;
    expect(equityAction.side).toBe("sell");
    expect(Number(equityAction.deltaValue)).toBeCloseTo(400, 0);
    // Buy side is not affected by the sell cap.
    const bondAction = actions.find((a) => a.key === "bond")!;
    expect(bondAction.side).toBe("buy");
    expect(Number(bondAction.deltaValue)).toBeCloseTo(1000, 0);
  });

  it("does not cap sell when cap is larger than computed delta", () => {
    // Uncapped: sell 1000. With cap = 2000 → sell 1000 (no effect).
    const actions = rebalancingTrades(baseDrift, "10000", {
      mode: "trade",
      maxSellByKey: { equity: "2000.00" },
    });
    const equityAction = actions.find((a) => a.key === "equity")!;
    expect(Number(equityAction.deltaValue)).toBeCloseTo(1000, 0);
  });

  it("drops sell action when cap is zero", () => {
    // Cap of "0" means no harvesting headroom → sell action is dropped entirely.
    const actions = rebalancingTrades(baseDrift, "10000", {
      mode: "trade",
      maxSellByKey: { equity: "0" },
    });
    expect(actions.find((a) => a.key === "equity")).toBeUndefined();
    // Buy still present.
    expect(actions.find((a) => a.key === "bond")).toBeDefined();
  });

  it("does not affect buy actions via maxSellByKey", () => {
    // Providing a maxSellByKey for a buy-side key has no effect.
    const actions = rebalancingTrades(baseDrift, "10000", {
      mode: "trade",
      maxSellByKey: { bond: "50.00" }, // bond is a buy — cap is ignored
    });
    const bondAction = actions.find((a) => a.key === "bond")!;
    expect(Number(bondAction.deltaValue)).toBeCloseTo(1000, 0);
  });

  it("contributions-only path (no maxSellByKey) is unchanged", () => {
    // Baseline without any cap — same as the existing "produces buy and sell" test.
    const actions = rebalancingTrades(baseDrift, "10000", { mode: "trade" });
    const equityAction = actions.find((a) => a.key === "equity")!;
    expect(Number(equityAction.deltaValue)).toBeCloseTo(1000, 0);
  });
});

// ---------------------------------------------------------------------------
// rebalancingTrades — mode "newCash"
// ---------------------------------------------------------------------------

describe("rebalancingTrades (newCash mode)", () => {
  it("returns empty when newCash is zero or missing", () => {
    const drift = [
      {
        key: "equity",
        targetPct: 70,
        actualPct: 60,
        driftPct: -10,
        actualValue: "6000",
        status: "under" as const,
      },
    ];
    expect(rebalancingTrades(drift, "6000", { mode: "newCash", newCash: "0" })).toEqual([]);
  });

  it("distributes newCash only among under-target sleeves proportionally", () => {
    const drift = [
      {
        key: "equity",
        targetPct: 70,
        actualPct: 80,
        driftPct: 10,
        actualValue: "8000",
        status: "over" as const,
      },
      {
        key: "bond",
        targetPct: 20,
        actualPct: 10,
        driftPct: -10,
        actualValue: "1000",
        status: "under" as const,
      },
      {
        key: "cash",
        targetPct: 10,
        actualPct: 10,
        driftPct: 0,
        actualValue: "1000",
        status: "on_target" as const,
      },
    ];
    const actions = rebalancingTrades(drift, "10000", { mode: "newCash", newCash: "1000" });
    // Only bond should get a buy action (equity is over, cash is on_target).
    expect(actions.length).toBe(1);
    expect(actions[0].key).toBe("bond");
    expect(actions[0].side).toBe("buy");
    expect(Number(actions[0].deltaValue)).toBeCloseTo(1000, 0);
  });

  it("splits proportionally across multiple under-target sleeves", () => {
    const drift = [
      {
        key: "world",
        targetPct: 70,
        actualPct: 50,
        driftPct: -20,
        actualValue: "5000",
        status: "under" as const,
      },
      {
        key: "em",
        targetPct: 30,
        actualPct: 50,
        driftPct: 20,
        actualValue: "5000",
        status: "over" as const,
      },
    ];
    // Only "world" is under, gets all 1000.
    const actions = rebalancingTrades(drift, "10000", { mode: "newCash", newCash: "1000" });
    expect(actions[0].key).toBe("world");
    expect(Number(actions[0].deltaValue)).toBeCloseTo(1000, 0);
  });

  it("splits correctly when two sleeves are under-target", () => {
    const drift = [
      {
        key: "world",
        targetPct: 70,
        actualPct: 60,
        driftPct: -10,
        actualValue: "6000",
        status: "under" as const,
      },
      {
        key: "em",
        targetPct: 30,
        actualPct: 40,
        driftPct: 10,
        actualValue: "4000",
        status: "over" as const,
      },
      {
        key: "bond",
        targetPct: 0,
        actualPct: 0,
        driftPct: 0,
        actualValue: "0",
        status: "on_target" as const,
      },
    ];
    // Only "world" is under → gets all.
    const actions = rebalancingTrades(drift, "10000", { mode: "newCash", newCash: "700" });
    expect(actions.find((a) => a.key === "em")).toBeUndefined();
    expect(Number(actions.find((a) => a.key === "world")!.deltaValue)).toBeCloseTo(700, 0);
  });
});

// ---------------------------------------------------------------------------
// contributionSplit
// ---------------------------------------------------------------------------

describe("contributionSplit", () => {
  it("returns zeros when monthlyTotal is zero", () => {
    const sleeves = [
      { key: "world", value: "7000", targetPct: 70 },
      { key: "em", value: "3000", targetPct: 30 },
    ];
    const result = contributionSplit(sleeves, "0");
    expect(result.every((r) => r.amount === "0")).toBe(true);
    expect(result.every((r) => r.sharePct === 0)).toBe(true);
  });

  it("returns zeros when sleeves is empty", () => {
    expect(contributionSplit([], "1000")).toEqual([]);
  });

  it("gives all of the contribution to the underweight sleeve", () => {
    // Current: world=9000 (90%), em=1000 (10%). Target: world=70%, em=30%.
    // After C=1000: total=11000. em target=3300, actual=1000, shortfall=2300.
    // world target=7700, actual=9000, shortfall=0.
    // So em gets all 1000.
    const sleeves = [
      { key: "world", value: "9000", targetPct: 70 },
      { key: "em", value: "1000", targetPct: 30 },
    ];
    const result = contributionSplit(sleeves, "1000");
    const worldRow = result.find((r) => r.key === "world")!;
    const emRow = result.find((r) => r.key === "em")!;
    expect(Number(emRow.amount)).toBeCloseTo(1000, 1);
    expect(Number(worldRow.amount)).toBeCloseTo(0, 1);
  });

  it("proportionally splits when both sleeves are underweight after contribution", () => {
    // Currently perfectly balanced at 70/30. After any contribution, both sleeves
    // retain their shares (shortfalls proportional to target weights).
    const sleeves = [
      { key: "world", value: "7000", targetPct: 70 },
      { key: "em", value: "3000", targetPct: 30 },
    ];
    const result = contributionSplit(sleeves, "1000");
    const worldRow = result.find((r) => r.key === "world")!;
    const emRow = result.find((r) => r.key === "em")!;
    // After contribution: total=11000, world target=7700 (need 700), em target=3300 (need 300).
    // Shortfall ratio: 700:300 = 7:3 → world gets 700, em gets 300.
    expect(Number(worldRow.amount)).toBeCloseTo(700, 0);
    expect(Number(emRow.amount)).toBeCloseTo(300, 0);
  });

  it("sum of amounts equals monthlyTotal (rounding handles centavos)", () => {
    const sleeves = [
      { key: "world", value: "6543.21", targetPct: 70 },
      { key: "em", value: "2101.11", targetPct: 30 },
    ];
    const result = contributionSplit(sleeves, "333.33");
    const total = result.reduce((acc, r) => acc + Number(r.amount), 0);
    // Allow up to 0.02 rounding difference.
    expect(total).toBeCloseTo(333.33, 1);
  });

  it("over-target sleeve gets 0 contribution", () => {
    // em is WAY over target. world is under.
    const sleeves = [
      { key: "world", value: "3000", targetPct: 70 },
      { key: "em", value: "7000", targetPct: 30 },
    ];
    const result = contributionSplit(sleeves, "500");
    const emRow = result.find((r) => r.key === "em")!;
    // em is over target (actual 70%, target 30%). After contribution (total=10500),
    // em target=3150, actual=7000, shortfall=0. World target=7350, actual=3000, shortfall=4350.
    // world gets all 500.
    expect(Number(emRow.amount)).toBeCloseTo(0, 1);
    const worldRow = result.find((r) => r.key === "world")!;
    expect(Number(worldRow.amount)).toBeCloseTo(500, 1);
  });
});
