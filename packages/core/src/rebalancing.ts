import { Decimal } from "decimal.js";
import type { AllocationSlice } from "./allocation.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A user-defined target weight for one allocation slice key. */
export interface TargetWeight {
  /** The slice key — must match the `key` values from `AllocationSlice`. */
  key: string;
  /** Target percentage, 0–100. A complete set sums to ≈100. */
  targetPct: number;
}

/** Actual vs. target drift for one allocation slice. */
export interface DriftRow {
  key: string;
  /** Display label (optional — callers may translate keys separately). */
  label?: string;
  /** Target percentage from the user's saved targets, 0–100. */
  targetPct: number;
  /** Actual percentage from the computed allocation, 0–100. */
  actualPct: number;
  /**
   * Signed drift: `actualPct − targetPct` in percentage points.
   * Positive = over target, negative = under target.
   */
  driftPct: number;
  /** Actual value in the display currency (decimal string). */
  actualValue: string;
  /**
   * Drift classification relative to the tolerance band.
   * `"on_target"` when `|driftPct| < bandPp`.
   */
  status: "over" | "under" | "on_target";
}

/** A recommended trade action to move toward the target allocation. */
export interface TradeAction {
  /** The slice key being acted on. */
  key: string;
  /** Display label (optional). */
  label?: string;
  /**
   * Absolute value to trade in the display currency (decimal string).
   * Always positive — `side` tells you the direction.
   */
  deltaValue: string;
  /** `"buy"` = add to this sleeve, `"sell"` = reduce this sleeve. */
  side: "buy" | "sell";
}

// ---------------------------------------------------------------------------
// Default constants
// ---------------------------------------------------------------------------

/** Default tolerance band in percentage points. Within this band a slice is
 *  classified as "on_target" even if there is a small drift (avoids noise
 *  from floating-point rounding and minor market moves). */
const DEFAULT_BAND_PP = 5;

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Join computed `AllocationSlice[]` against user-defined `TargetWeight[]` to
 * produce per-slice drift rows. Keys that appear only in the targets (with
 * zero actual) are included; keys that appear only in the actual allocation
 * (without a target) are **excluded** — the caller cannot infer intent for
 * un-targeted slices.
 *
 * @param slices  Computed allocation slices (from `allocationBreakdown`).
 * @param targets User-saved target weights. Must sum to ~100 as a set.
 * @param opts.bandPp Tolerance band in pp (default 5). Below this a slice is "on_target".
 */
export function rebalancingDrift(
  slices: AllocationSlice[],
  targets: TargetWeight[],
  opts?: { bandPp?: number },
): DriftRow[] {
  if (targets.length === 0) return [];

  const bandPp = opts?.bandPp ?? DEFAULT_BAND_PP;
  const sliceByKey = new Map(slices.map((s) => [s.key, s]));

  return targets.map((t) => {
    const actual = sliceByKey.get(t.key);
    const actualPct = actual?.pct ?? 0;
    const actualValue = actual?.value ?? "0";
    const driftPct = new Decimal(actualPct).minus(t.targetPct).toDecimalPlaces(4).toNumber();

    let status: DriftRow["status"];
    if (Math.abs(driftPct) < bandPp) {
      status = "on_target";
    } else if (driftPct > 0) {
      status = "over";
    } else {
      status = "under";
    }

    return {
      key: t.key,
      targetPct: t.targetPct,
      actualPct,
      driftPct,
      actualValue,
      status,
    };
  });
}

/**
 * Translate drift rows into concrete trade recommendations.
 *
 * **mode "trade"** — net-zero rebalancing: sell over-target sleeves and buy
 * under-target sleeves. The sell side funds the buy side; no external cash needed.
 * Total buys ≈ total sells (Σ `targetPct × totalValue` − `actualValue` across
 * each side).
 *
 * **mode "newCash"** — buy-only distribution of fresh capital across under-target
 * sleeves proportionally (no selling). `opts.newCash` must be supplied.
 * Each under-target sleeve receives `newCash × targetWeight / Σ targetWeights_under`.
 *
 * Slices with `status === "on_target"` are skipped (they are within the tolerance
 * band and do not warrant a trade).
 *
 * All values are decimal strings in the same display currency as the `actualValue`
 * fields on the drift rows.
 *
 * @param drift     Output from `rebalancingDrift`.
 * @param totalValue Total portfolio value in the display currency (decimal string).
 * @param opts.mode  `"trade"` or `"newCash"`.
 * @param opts.newCash Amount of fresh cash to deploy (required for `"newCash"` mode).
 */
export function rebalancingTrades(
  drift: DriftRow[],
  totalValue: string,
  opts: {
    mode: "trade" | "newCash";
    newCash?: string;
    /** Per-key maximum sell value (display currency). When provided, sell
     *  actions are capped at this amount. Used to bound sells within the
     *  remaining Sparerpauschbetrag headroom. */
    maxSellByKey?: Record<string, string>;
  },
): TradeAction[] {
  const { mode } = opts;
  const total = new Decimal(totalValue);

  if (total.isZero() || drift.length === 0) return [];

  if (mode === "trade") {
    return drift
      .filter((d) => d.status !== "on_target")
      .map((d) => {
        // targetValue = totalValue × (targetPct / 100)
        // delta = targetValue − actualValue (positive = need to buy, negative = sell)
        const targetValue = total.mul(d.targetPct).div(100);
        const actualValue = new Decimal(d.actualValue);
        const delta = targetValue.minus(actualValue).abs().toDecimalPlaces(2);

        const action: TradeAction = {
          key: d.key,
          deltaValue: delta.toString(),
          side: (d.status === "under" ? "buy" : "sell") as "buy" | "sell",
        };

        // Cap sell actions to the provided maximum (e.g. harvestable amount within
        // the remaining Sparerpauschbetrag). A cap of "0" drops the action after
        // the filter below.
        if (action.side === "sell" && opts.maxSellByKey?.[action.key] !== undefined) {
          const cap = new Decimal(opts.maxSellByKey[action.key]);
          action.deltaValue = Decimal.min(new Decimal(action.deltaValue), cap)
            .toDecimalPlaces(2)
            .toString();
        }

        return action;
      })
      .filter((a) => new Decimal(a.deltaValue).gt(0));
  }

  // mode === "newCash"
  const cash = new Decimal(opts.newCash ?? "0");
  if (cash.isZero()) return [];

  const underTargetSlices = drift.filter((d) => d.status === "under");
  if (underTargetSlices.length === 0) return [];

  const totalUnderPct = underTargetSlices.reduce((acc, d) => acc.add(d.targetPct), new Decimal(0));
  if (totalUnderPct.isZero()) return [];

  return underTargetSlices.map((d) => ({
    key: d.key,
    deltaValue: cash.mul(d.targetPct).div(totalUnderPct).toDecimalPlaces(2).toString(),
    side: "buy" as const,
  }));
}

/**
 * Compute the optimal split of a recurring monthly contribution across savings-plan
 * sleeves to converge toward their target weights.
 *
 * **Algorithm:** each period's entire contribution goes to whichever sleeve is
 * furthest from its target (greedy, buy-only). Returns the per-sleeve share of
 * the *next single contribution period* (`monthlyTotal`).
 *
 * Sleeves that are at or above their target receive `amount = "0"` (nothing this
 * period). Sleeves below receive a proportional share of the contribution scaled
 * by how far below target they are relative to the total shortfall.
 *
 * @param sleeves       Per-instrument sleeve state: current value + target.
 * @param monthlyTotal  The total contribution to distribute this period (decimal string).
 */
export function contributionSplit(
  sleeves: { key: string; value: string; targetPct: number }[],
  monthlyTotal: string,
): { key: string; amount: string; sharePct: number }[] {
  const C = new Decimal(monthlyTotal);
  if (C.isZero() || sleeves.length === 0) {
    return sleeves.map((s) => ({ key: s.key, amount: "0", sharePct: 0 }));
  }

  const totalValue = sleeves.reduce((acc, s) => acc.add(new Decimal(s.value)), new Decimal(0));
  // After contribution, total = totalValue + C.
  const newTotal = totalValue.add(C);

  // Compute each sleeve's shortfall: max(0, targetValue_after − currentValue).
  const shortfalls = sleeves.map((s) => {
    const target = newTotal.mul(s.targetPct).div(100);
    const shortfall = Decimal.max(0, target.minus(new Decimal(s.value)));
    return { key: s.key, shortfall };
  });

  const totalShortfall = shortfalls.reduce((acc, s) => acc.add(s.shortfall), new Decimal(0));

  if (totalShortfall.isZero()) {
    // All sleeves already at or above target — distribute proportionally to targets.
    const totalTargetPct = sleeves.reduce((acc, s) => acc + s.targetPct, 0);
    return sleeves.map((s) => {
      const share = totalTargetPct > 0 ? s.targetPct / totalTargetPct : 0;
      const amount = C.mul(share).toDecimalPlaces(2);
      return { key: s.key, amount: amount.toString(), sharePct: share * 100 };
    });
  }

  return shortfalls.map((s) => {
    const share = s.shortfall.div(totalShortfall);
    const amount = C.mul(share).toDecimalPlaces(2);
    return {
      key: s.key,
      amount: amount.toString(),
      sharePct: share.mul(100).toDecimalPlaces(4).toNumber(),
    };
  });
}
