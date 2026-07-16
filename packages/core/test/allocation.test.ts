import { describe, it, expect } from "vitest";
import {
  allocationBreakdown,
  concentration,
  normalizeSector,
  marketToRegion,
  countryToRegion,
  summarizePortfolio,
  type CoreTransaction,
  type AllocationInstrumentMeta,
  type PortfolioSummary,
  type TopHolding,
} from "../src/index.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const BBCA = "inst-bbca"; // IDX equity, IDR-quoted
const XETR = "inst-xetr"; // XETRA equity, EUR-quoted
const GOLD = "inst-gold"; // XAU gold, IDR-quoted
const BOND = "inst-bond"; // BEI bond, IDR-quoted
const ETF = "inst-etf"; // US ETF (e.g. S&P 500), USD-quoted

function tx(p: Partial<CoreTransaction> & { instrumentId?: string | null }): CoreTransaction {
  return {
    instrumentId: BBCA,
    type: "buy",
    quantity: "1",
    price: "0",
    fees: "0",
    currency: "IDR",
    executedAt: new Date("2026-01-01"),
    ...p,
  };
}

/** FX: 1 EUR = 16 000 IDR (round number for easy arithmetic). */
const fx = (from: string, to: string): string => {
  if (from === to) return "1";
  if (from === "EUR" && to === "IDR") return "16000";
  if (from === "IDR" && to === "EUR") return "0.0000625";
  return "1";
};

const instruments: Record<string, AllocationInstrumentMeta> = {
  [BBCA]: { assetClass: "equity", market: "IDX", sector: "Financials", name: "Bank Central Asia" },
  [XETR]: { assetClass: "equity", market: "XETRA", sector: "Technology", name: "SAP SE" },
  [GOLD]: { assetClass: "gold", market: "XAU", sector: null, name: "Gold" },
  [BOND]: { assetClass: "bond", market: "BEI", sector: null, name: "ORI023" },
};

/**
 * Build a valued PortfolioSummary. Market values (IDR display currency):
 *   BBCA  : 100 × 9 500             =   950 000 IDR
 *   XETR  : 10 × 110 EUR × 16 000   = 17 600 000 IDR
 *   GOLD  : 5 × 1 100 000           =  5 500 000 IDR
 *   BOND  : 50 × 100 000            =  5 000 000 IDR
 *   Cash  : 500 000 IDR             =    500 000 IDR
 *   Total :                           29 550 000 IDR
 *
 * Transactions are constructed so cash balances work out:
 *   IDR buys : BBCA 900 000 + GOLD 5 000 000 + BOND 5 000 000 = 10 900 000
 *   IDR deposit: 11 400 000  → 500 000 IDR net cash ✓
 *   EUR buy  : XETR 1 000 EUR → EUR deposit 1 000 → 0 EUR net cash
 */
function makeSummary(): PortfolioSummary {
  return summarizePortfolio({
    transactions: [
      // IDR deposit covering all IDR buys plus leaving 500 000 IDR cash
      tx({
        instrumentId: null,
        type: "deposit",
        price: "11400000",
        quantity: "1",
        fees: "0",
        currency: "IDR",
      }),
      // EUR deposit covering the XETR buy exactly (no EUR cash left)
      tx({
        instrumentId: null,
        type: "deposit",
        price: "1000",
        quantity: "1",
        fees: "0",
        currency: "EUR",
      }),

      tx({
        instrumentId: BBCA,
        type: "buy",
        quantity: "100",
        price: "9000",
        fees: "0",
        currency: "IDR",
      }),
      tx({
        instrumentId: XETR,
        type: "buy",
        quantity: "10",
        price: "100",
        fees: "0",
        currency: "EUR",
      }),
      tx({
        instrumentId: GOLD,
        type: "buy",
        quantity: "5",
        price: "1000000",
        fees: "0",
        currency: "IDR",
      }),
      tx({
        instrumentId: BOND,
        type: "buy",
        quantity: "50",
        price: "100000",
        fees: "0",
        currency: "IDR",
      }),
    ],
    prices: {
      [BBCA]: { price: "9500", currency: "IDR" },
      [XETR]: { price: "110", currency: "EUR" },
      [GOLD]: { price: "1100000", currency: "IDR" },
      [BOND]: { price: "100000", currency: "IDR" },
    },
    displayCurrency: "IDR",
    fx,
    cashCounted: true,
  });
}

// Total display-currency exposure: 950 000 + 17 600 000 + 5 500 000 + 5 000 000 + 500 000
const TOTAL = 29_550_000;
const TOLERANCE_IDR = 10; // ±10 IDR acceptable for decimal arithmetic

// ---------------------------------------------------------------------------
// allocationBreakdown — basic structure
// ---------------------------------------------------------------------------

describe("allocationBreakdown — structure", () => {
  it("returns all six top-level keys", () => {
    const result = allocationBreakdown(makeSummary(), instruments);

    expect(result.byAssetClass).toBeInstanceOf(Array);
    expect(result.byCurrency).toBeInstanceOf(Array);
    expect(result.byRegion).toBeInstanceOf(Array);
    expect(result.bySector).toBeInstanceOf(Array);
    expect(result.topHoldings).toBeInstanceOf(Array);
    expect(result.concentration).toBeDefined();
  });

  it("byAssetClass includes a 'cash' slice when cashTracked", () => {
    const keys = allocationBreakdown(makeSummary(), instruments).byAssetClass.map((s) => s.key);
    expect(keys).toContain("cash");
  });

  it("bySector does NOT include a 'cash' slice (cash has no sector)", () => {
    const keys = allocationBreakdown(makeSummary(), instruments).bySector.map((s) => s.key);
    expect(keys).not.toContain("cash");
  });

  it("all dimensions are sorted descending by pct", () => {
    const { byAssetClass, byCurrency, byRegion, bySector } = allocationBreakdown(
      makeSummary(),
      instruments,
    );
    const isDesc = (arr: { pct: number }[]) =>
      arr.every((s, i) => i === 0 || arr[i - 1].pct >= s.pct);
    expect(isDesc(byAssetClass)).toBe(true);
    expect(isDesc(byCurrency)).toBe(true);
    expect(isDesc(byRegion)).toBe(true);
    expect(isDesc(bySector)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — consistency guards
// ---------------------------------------------------------------------------

describe("allocationBreakdown — value consistency", () => {
  it("byAssetClass slice values sum to total exposure", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const sliceTotal = result.byAssetClass.reduce((s, sl) => s + Number(sl.value), 0);
    expect(Math.abs(sliceTotal - TOTAL)).toBeLessThan(TOLERANCE_IDR);
  });

  it("byRegion slice values sum to total exposure", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const sliceTotal = result.byRegion.reduce((s, sl) => s + Number(sl.value), 0);
    expect(Math.abs(sliceTotal - TOTAL)).toBeLessThan(TOLERANCE_IDR);
  });

  it("byCurrency slice values sum to total exposure", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const sliceTotal = result.byCurrency.reduce((s, sl) => s + Number(sl.value), 0);
    expect(Math.abs(sliceTotal - TOTAL)).toBeLessThan(TOLERANCE_IDR);
  });

  it("byAssetClass pcts sum to ~100", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const pctTotal = result.byAssetClass.reduce((s, sl) => s + sl.pct, 0);
    expect(pctTotal).toBeCloseTo(100, 1);
  });

  it("byCurrency pcts sum to ~100", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const pctTotal = result.byCurrency.reduce((s, sl) => s + sl.pct, 0);
    expect(pctTotal).toBeCloseTo(100, 1);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — asset class dimension
// ---------------------------------------------------------------------------

describe("allocationBreakdown — byAssetClass", () => {
  it("contains equity, gold, bond, and cash keys", () => {
    const keys = allocationBreakdown(makeSummary(), instruments).byAssetClass.map((s) => s.key);
    expect(keys).toContain("equity");
    expect(keys).toContain("gold");
    expect(keys).toContain("bond");
    expect(keys).toContain("cash");
  });

  it("equity total = BBCA (950 000) + XETR (17 600 000) = 18 550 000 IDR", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const equity = result.byAssetClass.find((s) => s.key === "equity");
    expect(equity).toBeDefined();
    expect(Math.abs(Number(equity!.value) - 18_550_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("gold total = 5 × 1 100 000 = 5 500 000 IDR", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const gold = result.byAssetClass.find((s) => s.key === "gold");
    expect(gold).toBeDefined();
    expect(Math.abs(Number(gold!.value) - 5_500_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("cash total = 500 000 IDR", () => {
    const result = allocationBreakdown(makeSummary(), instruments);
    const cash = result.byAssetClass.find((s) => s.key === "cash");
    expect(cash).toBeDefined();
    expect(Math.abs(Number(cash!.value) - 500_000)).toBeLessThan(TOLERANCE_IDR);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — region dimension
// ---------------------------------------------------------------------------

describe("allocationBreakdown — byRegion", () => {
  it("IDX and BEI (+ IDR cash) → ID region ≈ 6 450 000 IDR", () => {
    // BBCA 950000 + BOND 5000000 + IDR cash 500000 = 6 450 000
    const id = allocationBreakdown(makeSummary(), instruments).byRegion.find((s) => s.key === "ID");
    expect(id).toBeDefined();
    expect(Math.abs(Number(id!.value) - 6_450_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("XETRA → EU region ≈ 17 600 000 IDR", () => {
    const eu = allocationBreakdown(makeSummary(), instruments).byRegion.find((s) => s.key === "EU");
    expect(eu).toBeDefined();
    expect(Math.abs(Number(eu!.value) - 17_600_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("XAU → Commodity region ≈ 5 500 000 IDR", () => {
    const commodity = allocationBreakdown(makeSummary(), instruments).byRegion.find(
      (s) => s.key === "Commodity",
    );
    expect(commodity).toBeDefined();
    expect(Math.abs(Number(commodity!.value) - 5_500_000)).toBeLessThan(TOLERANCE_IDR);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — sector dimension
// ---------------------------------------------------------------------------

describe("allocationBreakdown — bySector", () => {
  it("GOLD and BOND (sector: null) → 'uncategorized' bucket ≈ 10 500 000 IDR", () => {
    const unc = allocationBreakdown(makeSummary(), instruments).bySector.find(
      (s) => s.key === "uncategorized",
    );
    expect(unc).toBeDefined();
    // 5 500 000 (GOLD) + 5 000 000 (BOND) = 10 500 000
    expect(Math.abs(Number(unc!.value) - 10_500_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("Financials sector ≈ 950 000 IDR (BBCA)", () => {
    const fin = allocationBreakdown(makeSummary(), instruments).bySector.find(
      (s) => s.key === "Financials",
    );
    expect(fin).toBeDefined();
    expect(Math.abs(Number(fin!.value) - 950_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("Technology sector ≈ 17 600 000 IDR (XETR)", () => {
    const tech = allocationBreakdown(makeSummary(), instruments).bySector.find(
      (s) => s.key === "Technology",
    );
    expect(tech).toBeDefined();
    expect(Math.abs(Number(tech!.value) - 17_600_000)).toBeLessThan(TOLERANCE_IDR);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — ETF proportional look-through
// ---------------------------------------------------------------------------

describe("allocationBreakdown — ETF sectorWeights look-through", () => {
  /**
   * ETF with value = 10 000 IDR, weights: Technology 60%, Financials 30%,
   * remainder 10% → "Other".
   * fx: 1 USD = 16 000 IDR (same as EUR for simplicity in this isolated test).
   */
  const ETF_WEIGHT_INSTRUMENTS: Record<string, AllocationInstrumentMeta> = {
    [ETF]: {
      assetClass: "etf",
      market: "US",
      sector: null,
      sectorWeights: { Technology: 0.6, Financials: 0.3 }, // sum = 0.9 → 0.1 remainder
      name: "SP500 ETF",
    },
  };

  function makeEtfSummary(): PortfolioSummary {
    return summarizePortfolio({
      transactions: [
        // Deposit then buy ETF so cash = 0
        {
          instrumentId: null,
          type: "deposit",
          price: "1",
          quantity: "1",
          fees: "0",
          currency: "IDR",
          executedAt: new Date("2026-01-01"),
        },
        {
          instrumentId: ETF,
          type: "buy",
          price: "1",
          quantity: "1",
          fees: "0",
          currency: "IDR",
          executedAt: new Date("2026-01-01"),
        },
      ],
      prices: { [ETF]: { price: "10000", currency: "IDR" } },
      displayCurrency: "IDR",
      cashCounted: true,
      fxRate: (_f, _t) => "1",
    });
  }

  it("Technology slice ≈ 6 000 IDR (60% of 10 000)", () => {
    const result = allocationBreakdown(makeEtfSummary(), ETF_WEIGHT_INSTRUMENTS);
    const tech = result.bySector.find((s) => s.key === "Technology");
    expect(tech).toBeDefined();
    expect(Math.abs(Number(tech!.value) - 6_000)).toBeLessThan(1);
  });

  it("Financials slice ≈ 3 000 IDR (30% of 10 000)", () => {
    const result = allocationBreakdown(makeEtfSummary(), ETF_WEIGHT_INSTRUMENTS);
    const fin = result.bySector.find((s) => s.key === "Financials");
    expect(fin).toBeDefined();
    expect(Math.abs(Number(fin!.value) - 3_000)).toBeLessThan(1);
  });

  it("'Other' remainder slice ≈ 1 000 IDR (10% gap)", () => {
    const result = allocationBreakdown(makeEtfSummary(), ETF_WEIGHT_INSTRUMENTS);
    const other = result.bySector.find((s) => s.key === "Other");
    expect(other).toBeDefined();
    expect(Math.abs(Number(other!.value) - 1_000)).toBeLessThan(1);
  });

  it("sector slices reconcile: Technology + Financials + Other = total holding value", () => {
    const result = allocationBreakdown(makeEtfSummary(), ETF_WEIGHT_INSTRUMENTS);
    const total = result.bySector.reduce((acc, s) => acc + Number(s.value), 0);
    // ETF market value is 10 000; allow tiny floating-point rounding
    expect(Math.abs(total - 10_000)).toBeLessThan(0.01);
  });

  it("ETF with weights summing to exactly 1 produces no 'Other' bucket", () => {
    const exactInst: Record<string, AllocationInstrumentMeta> = {
      [ETF]: {
        assetClass: "etf",
        market: "US",
        sectorWeights: { Technology: 0.5, Financials: 0.5 },
      },
    };
    const result = allocationBreakdown(makeEtfSummary(), exactInst);
    expect(result.bySector.find((s) => s.key === "Other")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// normalizeSector
// ---------------------------------------------------------------------------

describe("normalizeSector", () => {
  it("normalizes known ETF alias 'Financial Services' → 'Financials'", () => {
    expect(normalizeSector("Financial Services")).toBe("Financials");
  });

  it("normalizes 'Consumer Defensive' → 'Consumer Staples'", () => {
    expect(normalizeSector("Consumer Defensive")).toBe("Consumer Staples");
  });

  it("normalizes 'Consumer Cyclical' → 'Consumer Discretionary'", () => {
    expect(normalizeSector("Consumer Cyclical")).toBe("Consumer Discretionary");
  });

  it("normalizes 'Healthcare' → 'Health Care'", () => {
    expect(normalizeSector("Healthcare")).toBe("Health Care");
  });

  it("passes through unknown sector names unchanged", () => {
    expect(normalizeSector("Technology")).toBe("Technology");
    expect(normalizeSector("Energy")).toBe("Energy");
  });

  it("ETF 'Financial Services' and stock 'Financials' land in the same bucket", () => {
    // If an ETF has 'Financial Services' and a stock has 'Financials', they should
    // aggregate together after normalization.
    expect(normalizeSector("Financial Services")).toBe(normalizeSector("Financials"));
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — currency dimension
// ---------------------------------------------------------------------------

describe("allocationBreakdown — byCurrency", () => {
  it("IDR exposure = holdings priced in IDR + IDR cash ≈ 11 950 000", () => {
    // BBCA 950000 + GOLD 5500000 + BOND 5000000 + 500000 cash = 11 950 000
    const idr = allocationBreakdown(makeSummary(), instruments).byCurrency.find(
      (s) => s.key === "IDR",
    );
    expect(idr).toBeDefined();
    expect(Math.abs(Number(idr!.value) - 11_950_000)).toBeLessThan(TOLERANCE_IDR);
  });

  it("EUR exposure ≈ 17 600 000 IDR (XETR only, EUR cash = 0)", () => {
    const eur = allocationBreakdown(makeSummary(), instruments).byCurrency.find(
      (s) => s.key === "EUR",
    );
    expect(eur).toBeDefined();
    expect(Math.abs(Number(eur!.value) - 17_600_000)).toBeLessThan(TOLERANCE_IDR);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — Map<id, meta> input
// ---------------------------------------------------------------------------

describe("allocationBreakdown — Map input", () => {
  it("accepts a Map<string, meta> and produces identical results to a Record", () => {
    const summary = makeSummary();
    const mapInst = new Map(Object.entries(instruments));
    const recordResult = allocationBreakdown(summary, instruments);
    const mapResult = allocationBreakdown(summary, mapInst);

    expect(mapResult.byAssetClass.map((s) => s.key)).toEqual(
      recordResult.byAssetClass.map((s) => s.key),
    );
    expect(mapResult.byAssetClass.map((s) => s.pct)).toEqual(
      recordResult.byAssetClass.map((s) => s.pct),
    );
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — missing instrument metadata
// ---------------------------------------------------------------------------

describe("allocationBreakdown — missing metadata graceful fallback", () => {
  it("unknown instrument → 'unknown' asset class, 'uncategorized' sector, 'Other' region", () => {
    const summary = makeSummary();
    const result = allocationBreakdown(summary, {}); // no metadata at all
    const assetKeys = result.byAssetClass.map((s) => s.key);
    expect(assetKeys).toContain("unknown");
    expect(result.bySector.find((s) => s.key === "uncategorized")).toBeDefined();
    expect(result.byRegion.find((s) => s.key === "Other")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — unpriced holdings excluded
// ---------------------------------------------------------------------------

describe("allocationBreakdown — unpriced holdings", () => {
  it("holding without a price is excluded from all dimensions", () => {
    const summary = summarizePortfolio({
      transactions: [
        tx({ instrumentId: BBCA, type: "buy", quantity: "100", price: "9000", currency: "IDR" }),
        tx({ instrumentId: null, type: "deposit", price: "9000", quantity: "1", currency: "IDR" }),
      ],
      prices: {}, // no prices → BBCA unpriced
      displayCurrency: "IDR",
      cashCounted: true,
    });
    const result = allocationBreakdown(summary, instruments);
    // Only cash in the breakdown (holdings unpriced → excluded)
    expect(result.byAssetClass.map((s) => s.key)).not.toContain("equity");
    expect(result.topHoldings).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — empty portfolio
// ---------------------------------------------------------------------------

describe("allocationBreakdown — empty portfolio", () => {
  it("returns empty slices and zeroed concentration for an empty summary", () => {
    const empty = summarizePortfolio({ transactions: [], prices: {}, displayCurrency: "IDR" });
    const result = allocationBreakdown(empty, {});

    expect(result.byAssetClass).toHaveLength(0);
    expect(result.byCurrency).toHaveLength(0);
    expect(result.byRegion).toHaveLength(0);
    expect(result.bySector).toHaveLength(0);
    expect(result.topHoldings).toHaveLength(0);
    expect(result.concentration.hhi).toBe(0);
    expect(result.concentration.label).toBe("diversified");
  });
});

// ---------------------------------------------------------------------------
// concentration
// ---------------------------------------------------------------------------

describe("concentration", () => {
  const h = (pct: number): TopHolding => ({
    instrumentId: "x",
    value: String(pct * 100),
    pct,
  });

  it("single holding at 100% → HHI 10 000, concentrated", () => {
    const c = concentration([h(100)]);
    expect(c.hhi).toBe(10000);
    expect(c.label).toBe("concentrated");
    expect(c.top1Pct).toBe(100);
    expect(c.top5Pct).toBe(100);
  });

  it("10 equal holdings at 10% → HHI 1 000, diversified", () => {
    const c = concentration(Array.from({ length: 10 }, () => h(10)));
    expect(c.hhi).toBe(1000);
    expect(c.label).toBe("diversified");
    expect(c.top5Pct).toBe(50);
  });

  it("2 equal holdings at 50% → HHI 5 000, concentrated", () => {
    const c = concentration([h(50), h(50)]);
    expect(c.hhi).toBe(5000);
    expect(c.label).toBe("concentrated");
  });

  it("6 equal holdings at ~16.67% → HHI ~1 667, moderate", () => {
    const c = concentration(Array.from({ length: 6 }, () => h(100 / 6)));
    expect(c.hhi).toBeGreaterThanOrEqual(1500);
    expect(c.hhi).toBeLessThan(2500);
    expect(c.label).toBe("moderate");
  });

  it("empty list → HHI 0, diversified, all pcts 0", () => {
    const c = concentration([]);
    expect(c.hhi).toBe(0);
    expect(c.label).toBe("diversified");
    expect(c.top1Pct).toBe(0);
    expect(c.top5Pct).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// countryToRegion
// ---------------------------------------------------------------------------

describe("countryToRegion", () => {
  it("maps United States to North America", () => {
    expect(countryToRegion("United States")).toBe("North America");
  });

  it("maps Germany to Europe", () => {
    expect(countryToRegion("Germany")).toBe("Europe");
  });

  it("maps Japan to Asia", () => {
    expect(countryToRegion("Japan")).toBe("Asia");
  });

  it("maps unknown country to Other", () => {
    expect(countryToRegion("Atlantis")).toBe("Other");
  });
});

// ---------------------------------------------------------------------------
// marketToRegion
// ---------------------------------------------------------------------------

describe("marketToRegion", () => {
  it("maps IDX to ID", () => {
    expect(marketToRegion("IDX")).toBe("ID");
  });

  it("is case-insensitive", () => {
    expect(marketToRegion("xetra")).toBe("EU");
  });

  it("maps unknown market to Other", () => {
    expect(marketToRegion("UNKNOWN")).toBe("Other");
  });
});

// ---------------------------------------------------------------------------
// allocationBreakdown — ETF countryWeights look-through
// ---------------------------------------------------------------------------

describe("allocationBreakdown — ETF countryWeights look-through", () => {
  const ETF_CW = "inst-etf-cw";

  function makeEtfCwSummary(): PortfolioSummary {
    return summarizePortfolio({
      transactions: [
        {
          instrumentId: null,
          type: "deposit",
          price: "1",
          quantity: "1",
          fees: "0",
          currency: "USD",
          executedAt: new Date("2026-01-01"),
        },
        {
          instrumentId: ETF_CW,
          type: "buy",
          price: "1",
          quantity: "1",
          fees: "0",
          currency: "USD",
          executedAt: new Date("2026-01-01"),
        },
      ],
      prices: { [ETF_CW]: { price: "10000", currency: "USD" } },
      displayCurrency: "USD",
      cashCounted: true,
      fxRate: (_f, _t) => "1",
    });
  }

  it("decomposes ETF countryWeights into region breakdown", () => {
    const inst: Record<string, AllocationInstrumentMeta> = {
      [ETF_CW]: {
        assetClass: "etf",
        market: "XETRA",
        countryWeights: { "United States": 0.6, Germany: 0.2, Japan: 0.1 },
      },
    };
    const result = allocationBreakdown(makeEtfCwSummary(), inst);

    // US → North America: 6000, Germany → Europe: 2000, Japan → Asia: 1000
    const na = result.byRegion.find((s) => s.key === "North America");
    expect(na).toBeDefined();
    expect(Math.abs(Number(na!.value) - 6000)).toBeLessThan(1);

    const eu = result.byRegion.find((s) => s.key === "Europe");
    expect(eu).toBeDefined();
    expect(Math.abs(Number(eu!.value) - 2000)).toBeLessThan(1);

    const asia = result.byRegion.find((s) => s.key === "Asia");
    expect(asia).toBeDefined();
    expect(Math.abs(Number(asia!.value) - 1000)).toBeLessThan(1);
  });

  it("adds remainder to listing venue region when countryWeights < 1", () => {
    const inst: Record<string, AllocationInstrumentMeta> = {
      [ETF_CW]: {
        assetClass: "etf",
        market: "XETRA",
        countryWeights: { "United States": 0.7 },
      },
    };
    const result = allocationBreakdown(makeEtfCwSummary(), inst);

    // 70% US → North America = 7000, 30% remainder → EU (XETRA listing venue)
    const na = result.byRegion.find((s) => s.key === "North America");
    expect(na).toBeDefined();
    expect(Math.abs(Number(na!.value) - 7000)).toBeLessThan(1);

    const eu = result.byRegion.find((s) => s.key === "EU");
    expect(eu).toBeDefined();
    expect(Math.abs(Number(eu!.value) - 3000)).toBeLessThan(1);
  });

  it("region values sum to total when using countryWeights", () => {
    const inst: Record<string, AllocationInstrumentMeta> = {
      [ETF_CW]: {
        assetClass: "etf",
        market: "XETRA",
        countryWeights: { "United States": 0.5, Germany: 0.3 },
      },
    };
    const result = allocationBreakdown(makeEtfCwSummary(), inst);
    const regionTotal = result.byRegion.reduce((acc, s) => acc + Number(s.value), 0);
    expect(Math.abs(regionTotal - 10000)).toBeLessThan(0.01);
  });

  it("ETF with empty countryWeights falls back to listing venue", () => {
    const inst: Record<string, AllocationInstrumentMeta> = {
      [ETF_CW]: {
        assetClass: "etf",
        market: "XETRA",
        countryWeights: {},
      },
    };
    const result = allocationBreakdown(makeEtfCwSummary(), inst);
    const eu = result.byRegion.find((s) => s.key === "EU");
    expect(eu).toBeDefined();
    expect(Math.abs(Number(eu!.value) - 10000)).toBeLessThan(1);
  });
});
