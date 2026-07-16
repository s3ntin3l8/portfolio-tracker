import { describe, it, expect } from "vitest";
import {
  buildDailyValueFlows,
  chainIndex,
  aggregateValueFlows,
  splitAdjustmentFactor,
  type DailyValueFlow,
  type PriceSeriesKind,
} from "../src/index.js";
import type { CoreTransaction, CorporateAction } from "../src/index.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const noFx = () => (_from: string, _to: string) => "1";

function tx(p: Partial<CoreTransaction> & { instrumentId: string }): CoreTransaction {
  return {
    type: "buy",
    quantity: "0",
    price: "0",
    fees: "0",
    currency: "IDR",
    executedAt: new Date("2026-01-01"),
    ...p,
  };
}

/**
 * Build a minimal pipeline: transactions → DailyValueFlows → IndexPoints.
 * priceMap: { [instrumentId]: { [date]: string } }
 * kindsMap: { [instrumentId]: PriceSeriesKind }
 * cas: corporate actions (optional)
 * flowDateOf: optional override
 */
function pipeline(opts: {
  transactions: CoreTransaction[];
  priceMap: Record<string, Record<string, string>>;
  dates: string[];
  kindsMap?: Record<string, PriceSeriesKind>;
  cas?: CorporateAction[];
  flowDateOf?: (tx: CoreTransaction) => string;
}) {
  const { transactions, priceMap, dates, kindsMap = {}, cas = [], flowDateOf } = opts;

  const flows = buildDailyValueFlows({
    transactions,
    corporateActions: cas,
    dates,
    priceAt: (instrumentId, date) => {
      const dayClose = priceMap[instrumentId]?.[date];
      if (dayClose == null) return null;
      return { close: dayClose, currency: "IDR" };
    },
    fxAt: noFx,
    baseCurrency: "IDR",
    kindOf: (id) => kindsMap[id] ?? "realSeries",
    ...(flowDateOf ? { flowDateOf } : {}),
  });

  return { flows, index: chainIndex(flows) };
}

// ---------------------------------------------------------------------------
// 1. splitAdjustmentFactor unit tests
// ---------------------------------------------------------------------------

describe("splitAdjustmentFactor", () => {
  const STOCK = "inst-stock";

  it("returns 1 when there are no corporate actions", () => {
    const factor = splitAdjustmentFactor([], STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(1);
  });

  it("returns the split ratio for a CA whose exDate is after the query date", () => {
    const cas: CorporateAction[] = [
      { instrumentId: STOCK, type: "split", ratio: "2", exDate: new Date("2026-01-02") },
    ];
    // Querying day 01 — split ex-date 02 is AFTER → factor = 2
    const factor = splitAdjustmentFactor(cas, STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(2);
  });

  it("returns 1 for a CA whose exDate equals the query date (not strictly after)", () => {
    const cas: CorporateAction[] = [
      { instrumentId: STOCK, type: "split", ratio: "2", exDate: new Date("2026-01-01") },
    ];
    const factor = splitAdjustmentFactor(cas, STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(1);
  });

  it("returns 1 for a CA whose exDate is before the query date", () => {
    const cas: CorporateAction[] = [
      { instrumentId: STOCK, type: "split", ratio: "2", exDate: new Date("2025-12-31") },
    ];
    const factor = splitAdjustmentFactor(cas, STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(1);
  });

  it("chains multiple splits multiplicatively", () => {
    const cas: CorporateAction[] = [
      { instrumentId: STOCK, type: "split", ratio: "2", exDate: new Date("2026-02-01") },
      { instrumentId: STOCK, type: "split", ratio: "3", exDate: new Date("2026-03-01") },
    ];
    // Both exDates after 2026-01-01 → factor = 2 × 3 = 6
    const factor = splitAdjustmentFactor(cas, STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(6);
  });

  it("ignores corporate actions for other instruments", () => {
    const cas: CorporateAction[] = [
      { instrumentId: "other-inst", type: "split", ratio: "5", exDate: new Date("2026-02-01") },
    ];
    const factor = splitAdjustmentFactor(cas, STOCK, "2026-01-01");
    expect(factor.toNumber()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Flat price → constant index
// ---------------------------------------------------------------------------

describe("TWR: flat price keeps index at 100", () => {
  it("index stays at 100 when price does not move", () => {
    // Buy 100 shares at 100 IDR; price stays at 100 for 3 days.
    const INST = "inst-flat";
    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "100",
        price: "100",
        executedAt: new Date("2026-01-01"),
      }),
    ];
    const priceMap = {
      [INST]: { "2026-01-01": "100", "2026-01-02": "100", "2026-01-03": "100" },
    };
    const { index } = pipeline({
      transactions: txs,
      priceMap,
      dates: ["2026-01-01", "2026-01-02", "2026-01-03"],
    });

    expect(index).toHaveLength(3);
    // First day: index base = 100
    expect(index[0].index).toBe("100");
    // Subsequent days: price flat → no return → index stays at 100
    expect(Number(index[1].index)).toBeCloseTo(100, 6);
    expect(Number(index[2].index)).toBeCloseTo(100, 6);
    expect(Number(index[0].pct)).toBeCloseTo(0, 6);
    expect(Number(index[1].pct)).toBeCloseTo(0, 6);
    expect(Number(index[2].pct)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// 3. Split-adjustment: 2:1 split does not show as a gain
// ---------------------------------------------------------------------------

describe("TWR: 2:1 split does not dent or inflate the index", () => {
  it("index stays flat when raw prices are back-adjusted through a 2:1 split", () => {
    /**
     * Setup:
     *   Day 01: buy 100 shares at 1000 IDR. computeHoldings always returns
     *           post-split qty (200) regardless of asOf — so priceAt must
     *           return adjusted prices to keep MV consistent.
     *   Day 01: raw close 1000 → splitAdjFactor (exDate=02 > 01) = 2
     *            → adjustedClose = 1000/2 = 500, MV = 200 × 500 = 100000
     *   Day 02 (split ex-date): raw 500 → splitAdjFactor (exDate=02 not > 02) = 1
     *            → adjustedClose = 500, MV = 200 × 500 = 100000
     *   Day 03: raw 500 → adjustedClose = 500, MV = 200 × 500 = 100000
     *   No performance change → index stays at 100.
     */
    const INST = "inst-split";
    const cas: CorporateAction[] = [
      { instrumentId: INST, type: "split", ratio: "2", exDate: new Date("2026-01-02") },
    ];

    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "100",
        price: "1000",
        executedAt: new Date("2026-01-01"),
      }),
    ];

    const dates = ["2026-01-01", "2026-01-02", "2026-01-03"];

    // Prices injected are ALREADY split-adjusted by the caller (as the production
    // code expects): adjustedClose(d) = rawClose(d) / splitAdjustmentFactor(cas, id, d)
    // Day 01: raw 1000 / factor(2) = 500
    // Day 02: raw 500  / factor(1) = 500
    // Day 03: raw 500  / factor(1) = 500
    const priceMap = {
      [INST]: { "2026-01-01": "500", "2026-01-02": "500", "2026-01-03": "500" },
    };

    const { index } = pipeline({ transactions: txs, priceMap, dates, cas });

    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    expect(Number(index[1].index)).toBeCloseTo(100, 6);
    expect(Number(index[2].index)).toBeCloseTo(100, 6);
    expect(Number(index[0].pct)).toBeCloseTo(0, 6);
    expect(Number(index[1].pct)).toBeCloseTo(0, 6);
    expect(Number(index[2].pct)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// 4. Sell doesn't dent the performance line
// ---------------------------------------------------------------------------

describe("TWR: sell does not drop the performance index", () => {
  it("index shows +10% gain after price rises, and holds after selling all shares", () => {
    /**
     * Day 01: buy 100 shares at 100. MV = 10000. effectiveFlow = +10000 (cost).
     *         prevMv = null → index = 100.
     * Day 02: price 110. MV = 11000. effectiveFlow = 0.
     *         rt = (11000 - 0) / 10000 - 1 = 0.10. index = 110.
     * Day 03: sell 100 shares at 110. MV = 0.
     *         effectiveFlow = -(-cashFlow(sell)) = -11000 (proceeds subtracted → flow negative).
     *         Actually: cashFlow(sell) = +11000; flow = -cashFlow = -11000.
     *         rt = (0 - (-11000)) / 11000 - 1 = 11000/11000 - 1 = 0. index = 110.
     */
    const INST = "inst-sell";
    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "100",
        price: "100",
        executedAt: new Date("2026-01-01"),
      }),
      tx({
        instrumentId: INST,
        type: "sell",
        quantity: "100",
        price: "110",
        executedAt: new Date("2026-01-03"),
      }),
    ];
    const priceMap = {
      [INST]: { "2026-01-01": "100", "2026-01-02": "110" },
      // Day 03: after sell, holding is zero — priceAt returns null is fine
    };
    const { index } = pipeline({
      transactions: txs,
      priceMap,
      dates: ["2026-01-01", "2026-01-02", "2026-01-03"],
    });

    // Day 01: base = 100
    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    // Day 02: +10%
    expect(Number(index[1].index)).toBeCloseTo(110, 6);
    // Day 03: sell does NOT drop index back to 100
    expect(Number(index[2].index)).toBeCloseTo(110, 6);
    expect(Number(index[2].pct)).toBeCloseTo(10, 6);
  });
});

// ---------------------------------------------------------------------------
// 5. Dividend (realSeries) → flat on ex-date
// ---------------------------------------------------------------------------

describe("TWR: dividend on ex-date keeps index flat for realSeries", () => {
  it("price drop on ex-date is neutralised by netting the dividend income", () => {
    /**
     * Day 01: buy 100 shares at 1000. MV = 100000. Flow = +100000.
     *         prevMv = null → index = 100.
     * Day 02 (ex-date): price 990 (reflects 10 IDR/share × 100 = 1000 total dividend).
     *         Dividend txn (quantity=0, price=1000, total=1000) attributed to day 02.
     *         For realSeries: flow = -cashFlow(dividend) = -1000 (income subtracted from flow).
     *         effectiveFlow = 0 (no buy/sell) + (-1000) = -1000.
     *         MV = 100 × 990 = 99000.
     *         rt = (99000 - (-1000)) / 100000 - 1 = 100000/100000 - 1 = 0 → index = 100.
     */
    const INST = "inst-dividend";
    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "100",
        price: "1000",
        executedAt: new Date("2026-01-01"),
      }),
      // Dividend of 1000 IDR total (10/share × 100 shares). executedAt = ex-date.
      tx({
        instrumentId: INST,
        type: "dividend",
        quantity: "0",
        price: "1000",
        executedAt: new Date("2026-01-02"),
      }),
    ];
    const priceMap = {
      [INST]: { "2026-01-01": "1000", "2026-01-02": "990" },
    };
    const { index } = pipeline({
      transactions: txs,
      priceMap,
      dates: ["2026-01-01", "2026-01-02"],
      kindsMap: { [INST]: "realSeries" },
    });

    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    // Ex-date: dividend + price drop cancel out → index stays flat
    expect(Number(index[1].index)).toBeCloseTo(100, 6);
    expect(Number(index[1].pct)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// 6. Bond flat-proxy + coupon → index does NOT jump
// ---------------------------------------------------------------------------

describe("TWR: coupon on a flatProxy bond does not inflate the index", () => {
  it("index stays flat when a coupon is received but the bond price does not drop", () => {
    /**
     * Bond with face value 1,000,000 IDR; kindOf = "flatProxy".
     * Day 01: buy 1 bond at 1000000. MV = 1000000.
     * Day 02: price still 1000000 (NAV/flat proxy — no ex-date drop).
     *         Coupon txn 25000 IDR. For flatProxy: NOT netted in effectiveFlow.
     *         effectiveFlow = 0. rt = 1000000/1000000 - 1 = 0. index = 100.
     *
     * If coupon WERE netted (realSeries): flow = -25000,
     *         rt = (1000000 - (-25000)) / 1000000 - 1 = +2.5% → index = 102.5.
     * We assert the index is NOT 102.5.
     */
    const INST = "inst-bond";
    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "1",
        price: "1000000",
        executedAt: new Date("2026-01-01"),
      }),
      tx({
        instrumentId: INST,
        type: "coupon",
        quantity: "0",
        price: "25000",
        executedAt: new Date("2026-01-02"),
      }),
    ];
    const priceMap = {
      [INST]: { "2026-01-01": "1000000", "2026-01-02": "1000000" },
    };
    const { index } = pipeline({
      transactions: txs,
      priceMap,
      dates: ["2026-01-01", "2026-01-02"],
      kindsMap: { [INST]: "flatProxy" },
    });

    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    // Must NOT be +2.5%
    expect(Number(index[1].index)).toBeCloseTo(100, 6);
    expect(Number(index[1].pct)).toBeCloseTo(0, 6);
  });
});

// ---------------------------------------------------------------------------
// 7. V₋₁ = 0 reset: buy after zero state carries forward without divide-by-zero
// ---------------------------------------------------------------------------

describe("TWR: V_{t-1} = 0 carry-forward (no divide-by-zero)", () => {
  it("index stays at 100 and is finite when portfolio starts from zero", () => {
    /**
     * Day 01: no holdings → MV = 0. Index base = 100 (first day, no prev).
     *         prevMv = 0.
     * Day 02: buy 100 shares at 100 (executedAt=01-01 but processed on 01-02 via flow date).
     *         Actually, buy at 01-01 so computeHoldings gives 100 shares from day 01.
     *
     * Easier: use priceAt returning null on day 01 → MV = 0.
     *         Day 01: priceAt returns null → MV = 0. Index = 100 (first). prevMv = 0.
     *         Day 02: priceAt returns 100 → MV = 10000.
     *         prevMv = 0 → carry-forward: index stays at 100.
     */
    const INST = "inst-zero";
    const txs = [
      tx({
        instrumentId: INST,
        type: "buy",
        quantity: "100",
        price: "100",
        executedAt: new Date("2026-01-01"),
      }),
    ];
    const priceMap = {
      // Day 01: no price yet → priceAt returns null → MV=0
      [INST]: { "2026-01-02": "100", "2026-01-03": "110" },
    };
    const { index } = pipeline({
      transactions: txs,
      priceMap,
      dates: ["2026-01-01", "2026-01-02", "2026-01-03"],
    });

    // All index values must be finite numbers
    for (const pt of index) {
      expect(Number.isFinite(Number(pt.index))).toBe(true);
      expect(Number.isNaN(Number(pt.index))).toBe(false);
    }

    // Day 01: first point, index = 100 (base)
    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    // Day 02: prevMv = 0 → carry-forward, index still 100
    expect(Number(index[1].index)).toBeCloseTo(100, 6);
    // Day 03: price rises from 100 to 110, prevMv = 10000 (non-zero now)
    //         rt = 11000/10000 - 1 = 0.10 → index = 110
    expect(Number(index[2].index)).toBeCloseTo(110, 6);
  });
});

// ---------------------------------------------------------------------------
// 8b. Price-gap collapse: a single unpriced day for a held instrument must not
//     permanently zero the index (the real-world bug behind a phantom -100%
//     drawdown / "-176% vs benchmark").
// ---------------------------------------------------------------------------

describe("TWR: a single MV=0/flow=0 gap day does not permanently zero the index", () => {
  it("carries the index forward through a price-gap day instead of collapsing to 0", () => {
    /**
     * Reproduces a snapshot-generation gap: a held instrument's price goes missing for
     * one day (recorded upstream as marketValue=0, effectiveFlow=0) with no compensating
     * flow, then the price returns.
     *   Day 01: mv=1000, flow=1000 (initial buy) → index = 100 (first point).
     *   Day 02: mv=1100, flow=0 → +10% → index = 110.
     *   Day 03 (gap): mv=0, flow=0 → naive rt = (0-0)/1100 - 1 = -1 → would zero the index.
     *   Day 04 (recovered): mv=1150, flow=0.
     */
    const series: DailyValueFlow[] = [
      { date: "2026-01-01", marketValue: "1000", effectiveFlow: "1000" },
      { date: "2026-01-02", marketValue: "1100", effectiveFlow: "0" },
      { date: "2026-01-03", marketValue: "0", effectiveFlow: "0" }, // gap day
      { date: "2026-01-04", marketValue: "1150", effectiveFlow: "0" },
    ];

    const index = chainIndex(series);

    expect(Number(index[0].index)).toBeCloseTo(100, 6);
    expect(Number(index[1].index)).toBeCloseTo(110, 6);
    // Gap day: index carries forward at 110, NOT collapsed to 0 (-100%).
    expect(Number(index[2].index)).toBeCloseTo(110, 6);
    expect(Number(index[2].pct)).toBeCloseTo(10, 6);
    // Recovery day: prevMv is 0 (the gap day's mv) → carries forward again, matching the
    // existing V_{t-1}=0 reset-proof semantics (see test 7) rather than computing a
    // spurious jump from 0 to 1150.
    expect(Number(index[3].index)).toBeCloseTo(110, 6);

    // Every point stays finite and never goes to (or through) zero.
    for (const pt of index) {
      expect(Number.isFinite(Number(pt.index))).toBe(true);
      expect(Number(pt.index)).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 8. Aggregate ≠ average of per-portfolio indices (dollar-weighted)
// ---------------------------------------------------------------------------

describe("TWR: aggregateValueFlows then chainIndex ≠ average of per-portfolio indices", () => {
  it("uses unequal-size portfolios to show aggregate ≠ arithmetic average", () => {
    /**
     * Portfolio A (large): MV 10000 → 11000 (= +10%)
     * Portfolio B (small): MV 1000  → 900  (= -10%)
     *
     * Per-portfolio indices (chained from a setup day):
     *   A: day 2 index = 110
     *   B: day 2 index = 90
     *   Arithmetic average = (110 + 90) / 2 = 100
     *
     * Aggregate:
     *   Summed MV day 1 = 11000, summed MV day 2 = 11900
     *   rt = 11900/11000 - 1 = 8.18...%
     *   Aggregate index day 2 ≈ 108.18 ≠ 100
     */
    // Build DailyValueFlow series directly (bypasses pipeline for clarity)
    const seriesA: DailyValueFlow[] = [
      { date: "2026-01-01", marketValue: "10000", effectiveFlow: "10000" }, // setup day
      { date: "2026-01-02", marketValue: "11000", effectiveFlow: "0" },
    ];
    const seriesB: DailyValueFlow[] = [
      { date: "2026-01-01", marketValue: "1000", effectiveFlow: "1000" }, // setup day
      { date: "2026-01-02", marketValue: "900", effectiveFlow: "0" },
    ];

    const indexA = chainIndex(seriesA);
    const indexB = chainIndex(seriesB);

    // Per-portfolio day-2 indices
    const idxA2 = Number(indexA[1].index); // ≈ 110
    const idxB2 = Number(indexB[1].index); // ≈ 90
    const arithmeticAvg = (idxA2 + idxB2) / 2; // = 100

    // Aggregate path
    const aggregated = aggregateValueFlows([seriesA, seriesB]);
    const aggregateIndex = chainIndex(aggregated);
    const aggIdx2 = Number(aggregateIndex[1].index); // ≈ 108.18

    // Sanity: confirm per-portfolio returns
    expect(idxA2).toBeCloseTo(110, 4);
    expect(idxB2).toBeCloseTo(90, 4);
    expect(arithmeticAvg).toBeCloseTo(100, 4);

    // Aggregate must NOT equal the arithmetic average
    expect(aggIdx2).not.toBeCloseTo(arithmeticAvg, 4);
    // Aggregate is ≈ 108.18 (dollar-weighted toward the large portfolio)
    expect(aggIdx2).toBeCloseTo(108.18, 1);
    // And the aggregate pct
    expect(Number(aggregateIndex[1].pct)).toBeCloseTo(8.18, 1);
  });
});
