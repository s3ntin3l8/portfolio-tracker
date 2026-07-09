import { describe, expect, it } from "vitest";
import {
  actionClass,
  decimalsClose,
  findCrossSourceDuplicates,
  parseLooseDecimal,
  recomputeRollup,
  withinDayTolerance,
} from "./dedup.js";
import type { SourceRow } from "./dedup.js";

describe("actionClass", () => {
  it("collapses buy and savings_plan to one acquisition class", () => {
    expect(actionClass("buy")).toBe(actionClass("savings_plan"));
  });

  it("keeps unrelated actions distinct (sell is never an acquisition peer)", () => {
    expect(actionClass("sell")).toBe("sell");
    expect(actionClass("dividend")).toBe("dividend");
    expect(actionClass("sell")).not.toBe(actionClass("buy"));
  });
});

describe("parseLooseDecimal", () => {
  it("parses English and German decimal marks identically", () => {
    expect(parseLooseDecimal("74.506")).toBe(74.506);
    expect(parseLooseDecimal("74,506")).toBe(74.506);
  });

  it("handles thousands separators on both conventions", () => {
    expect(parseLooseDecimal("1.234,56")).toBe(1234.56);
    expect(parseLooseDecimal("1,234.56")).toBe(1234.56);
  });

  it("returns null for non-numeric input", () => {
    expect(parseLooseDecimal("abc")).toBeNull();
    expect(parseLooseDecimal("")).toBeNull();
    expect(parseLooseDecimal(null)).toBeNull();
  });
});

describe("decimalsClose", () => {
  it("treats a precision/rounding divergence as equal (C3)", () => {
    // PDF rounds a fund quantity the CSV carries to full precision.
    expect(decimalsClose("74.506", "74.51")).toBe(true);
    expect(decimalsClose("74.50600000", "74.506")).toBe(true);
  });

  it("matches across decimal-mark locales", () => {
    expect(decimalsClose("74,506", "74.506")).toBe(true);
  });

  it("keeps genuinely different same-instrument quantities apart", () => {
    // The two real A2H9QY buys on 2021-07-05 — 1.3358 vs 3.1399 units.
    expect(decimalsClose("1.3358", "3.1399")).toBe(false);
  });

  it("uses an absolute floor for sub-unit values", () => {
    expect(decimalsClose("0.3355", "0.3357")).toBe(true);
    expect(decimalsClose("0.3355", "0.9")).toBe(false);
  });
});

describe("withinDayTolerance", () => {
  it("accepts an adjacent trade-date vs settlement-date (C4)", () => {
    expect(withinDayTolerance("2021-11-17", "2021-11-18")).toBe(true);
  });

  it("rejects a two-day gap", () => {
    expect(withinDayTolerance("2021-11-17", "2021-11-19")).toBe(false);
  });

  it("absorbs an intraday timezone difference around midnight", () => {
    expect(withinDayTolerance("2021-11-17T23:30:00Z", "2021-11-18T01:00:00Z")).toBe(true);
  });
});

describe("findCrossSourceDuplicates", () => {
  const isin = "LU1737652237";

  it("matches a CSV buy against a PDF savings_plan of the same trade (action divergence)", () => {
    const committed = [
      { key: isin, action: "savings_plan", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05", source: "screenshot" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    const matches = findCrossSourceDuplicates(drafts, committed);
    expect(matches).toHaveLength(1);
    expect(matches[0].matched.source).toBe("screenshot");
  });

  it("matches across a ±1 day settlement skew and a precision divergence", () => {
    const committed = [
      { key: isin, action: "dividend", quantity: "0", price: "10.02", executedAt: "2021-11-17", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "dividend", quantity: "0", price: "10.020", executedAt: "2021-11-18" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(1);
  });

  it("is count-aware: two same-day buys with one prior import flag only one", () => {
    const committed = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    const matches = findCrossSourceDuplicates(drafts, committed);
    expect(matches).toHaveLength(1);
    expect(matches[0].draftIndex).toBe(0);
  });

  it("does not match two distinct same-day buys of different size", () => {
    const committed = [
      { key: isin, action: "buy", quantity: "3.1399", price: "72.614", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: isin, action: "buy", quantity: "1.3358", price: "72.614", executedAt: "2021-07-05" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(0);
  });

  it("ignores records without an instrument identity (cash legs)", () => {
    const committed = [
      { key: null, action: "deposit", quantity: "0", price: "100", executedAt: "2021-07-05", source: "csv" },
    ];
    const drafts = [
      { key: null, action: "deposit", quantity: "0", price: "100", executedAt: "2021-07-05" },
    ];
    expect(findCrossSourceDuplicates(drafts, committed)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// recomputeRollup
// ---------------------------------------------------------------------------

function src(overrides: Partial<SourceRow> & { sourceType: string }): SourceRow {
  return { tax: null, fees: null, executedPrice: null, fxRate: null, venue: null, ...overrides };
}

describe("recomputeRollup", () => {
  it("returns all nulls for an empty set of rows", () => {
    const r = recomputeRollup([]);
    expect(r.tax).toBeNull();
    expect(r.fees).toBeNull();
    expect(r.hasManual).toBe(false);
  });

  it("pdf rank beats csv rank for all scalar fields", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "csv", tax: "5.00", fees: "0.50", executedPrice: "100.00", venue: "XETRA" }),
      src({ sourceType: "pdf", tax: "4.80", fees: "1.00", executedPrice: "99.50", venue: "Lang & Schwarz" }),
    ];
    const r = recomputeRollup(rows);
    expect(r.tax).toBe("4.80");
    expect(r.fees).toBe("1.00");
    expect(r.executedPrice).toBe("99.50");
    expect(r.venue).toBe("Lang & Schwarz");
  });

  it("adding a lower-rank csv row after pdf leaves the rollup unchanged (no-downgrade)", () => {
    const pdf = src({ sourceType: "pdf", tax: "4.80", fees: "1.00" });
    const csv = src({ sourceType: "csv", tax: "5.00", fees: "0.50" });
    expect(recomputeRollup([pdf, csv]).tax).toBe("4.80");
    expect(recomputeRollup([csv, pdf]).tax).toBe("4.80"); // order-independent
  });

  it("sums tax and fees across two pdf rows (split-order legs)", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", tax: "3.00", fees: "1.00" }),
      src({ sourceType: "pdf", tax: "1.50", fees: "0.50" }),
    ];
    const r = recomputeRollup(rows);
    expect(r.tax).toBe("4.50");
    expect(r.fees).toBe("1.50");
  });

  it("does not sum tax across different ranks — lower rank is ignored", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", tax: "4.80" }),
      src({ sourceType: "csv", tax: "5.00" }),
    ];
    // Only the pdf tax counts (pdf rank=40 > csv rank=20).
    expect(recomputeRollup(rows).tax).toBe("4.80");
  });

  it("sets hasManual when a manual source row exists", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "manual", tax: "3.00" }),
      src({ sourceType: "pdf", tax: "4.00" }),
    ];
    const r = recomputeRollup(rows);
    expect(r.hasManual).toBe(true);
  });

  it("is idempotent — re-running on the same rows is a fixed point", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", tax: "4.80", fees: "1.00" }),
      src({ sourceType: "csv", tax: "5.00", fees: "0.50" }),
    ];
    const r1 = recomputeRollup(rows);
    const r2 = recomputeRollup(rows);
    expect(r1.tax).toBe(r2.tax);
    expect(r1.fees).toBe(r2.fees);
  });

  it("merges taxComponents from all rows (union)", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", taxComponents: { kapitalertragsteuer: "3.75" } }),
      src({ sourceType: "pdf", taxComponents: { solidaritaetszuschlag: "0.21" } }),
    ];
    const r = recomputeRollup(rows);
    expect(r.mergedTaxComponents.kapitalertragsteuer).toBe("3.75");
    expect(r.mergedTaxComponents.solidaritaetszuschlag).toBe("0.21");
  });

  // -------------------------------------------------------------------------
  // Split distributions: one activity-log event settling across two PDFs
  // (e.g. Realty Income's ordinary + return-of-capital documents).
  // -------------------------------------------------------------------------

  it("sums perShare and grossNative across two pdf rows at full decimal precision", () => {
    const rows: SourceRow[] = [
      src({
        sourceType: "pdf",
        tax: "0.86",
        perShare: "0.17886715",
        grossNative: "6.76",
        shares: "37.8",
        nativeCurrency: "USD",
      }),
      src({
        sourceType: "pdf",
        tax: "0",
        perShare: "0.09063285",
        grossNative: "3.42",
        shares: "37.8",
        nativeCurrency: "USD",
      }),
    ];
    const r = recomputeRollup(rows);
    // 0.17886715 + 0.09063285 = 0.26950000 exactly — a naive parseFloat/cents sum would corrupt
    // this to "0.27" (Math.round(n*100) truncates the 6 trailing significant digits).
    expect(r.perShare).toBe("0.26950000");
    expect(r.grossNative).toBe("10.18");
    expect(r.tax).toBe("0.86");
  });

  it("keeps shares and nativeCurrency picked, not summed, across the split rows", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", shares: "37.8", nativeCurrency: "USD", perShare: "0.10" }),
      src({ sourceType: "pdf", shares: "37.8", nativeCurrency: "USD", perShare: "0.05" }),
    ];
    const r = recomputeRollup(rows);
    expect(r.shares).toBe("37.8"); // not "75.6" — summing would double-count the position
    expect(r.nativeCurrency).toBe("USD");
  });

  it("a normal single-pdf-row transaction is unaffected by the sum (no-regression)", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", perShare: "0.4520", grossNative: "12.34", shares: "27.3" }),
    ];
    const r = recomputeRollup(rows);
    expect(r.perShare).toBe("0.4520");
    expect(r.grossNative).toBe("12.34");
  });

  it("does not sum perShare across different ranks — lower rank is ignored", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", perShare: "0.20" }),
      src({ sourceType: "pytr", perShare: "999.99" }),
    ];
    expect(recomputeRollup(rows).perShare).toBe("0.20");
  });

  it("fxRate is a grossNative-weighted average across the split rows", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", fxRate: "0.852174", grossNative: "6.76" }),
      src({ sourceType: "pdf", fxRate: "0.853801", grossNative: "3.42" }),
    ];
    const r = recomputeRollup(rows);
    const expected = (0.852174 * 6.76 + 0.853801 * 3.42) / (6.76 + 3.42);
    expect(Number(r.fxRate)).toBeCloseTo(expected, 6);
  });

  it("fxRate falls back to the first value when no row carries a positive weight", () => {
    const rows: SourceRow[] = [src({ sourceType: "pdf", fxRate: "0.85" })];
    expect(recomputeRollup(rows).fxRate).toBe("0.85");
  });

  it("is idempotent for perShare/grossNative — re-running is a fixed point", () => {
    const rows: SourceRow[] = [
      src({ sourceType: "pdf", perShare: "0.17886715", grossNative: "6.76" }),
      src({ sourceType: "pdf", perShare: "0.09063285", grossNative: "3.42" }),
    ];
    const r1 = recomputeRollup(rows);
    const r2 = recomputeRollup(rows);
    expect(r1.perShare).toBe(r2.perShare);
    expect(r1.grossNative).toBe(r2.grossNative);
  });
});

// aggregateByOrderRef was removed (fix 4.2). A TR split order imports as two separate
// transactions — one per settlement PDF — which is correct because each represents a real
// fill. See the NOTE in dedup.ts and services/enrichment.ts for background.
