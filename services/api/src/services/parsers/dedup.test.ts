import { describe, expect, it } from "vitest";
import {
  actionClass,
  aggregateByOrderRef,
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
});

// ---------------------------------------------------------------------------
// aggregateByOrderRef
// ---------------------------------------------------------------------------

function makeDraft(overrides: {
  orderRef?: string;
  quantity: string;
  tax?: string;
  fees?: string;
  price?: string;
  externalId?: string;
  isin?: string;
}) {
  return {
    action: "buy" as const,
    quantity: overrides.quantity,
    price: overrides.price ?? "100.00",
    fees: overrides.fees ?? "0",
    tax: overrides.tax,
    currency: "EUR" as const,
    executedAt: new Date("2025-02-25"),
    confidence: 1,
    unit: "shares" as const,
    isin: overrides.isin ?? "IE00B5BMR087",
    orderRef: overrides.orderRef,
    externalId: overrides.externalId,
  };
}

describe("aggregateByOrderRef", () => {
  it("passes through singletons with no orderRef unchanged", () => {
    const draft = makeDraft({ quantity: "10" });
    const { aggregated, legMap } = aggregateByOrderRef([draft]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].quantity).toBe("10");
    expect(legMap.get(0)).toEqual([0]);
  });

  it("passes through a singleton with a unique orderRef unchanged", () => {
    const draft = makeDraft({ quantity: "5", orderRef: "abc-123" });
    const { aggregated } = aggregateByOrderRef([draft]);
    expect(aggregated).toHaveLength(1);
    expect(aggregated[0].quantity).toBe("5");
  });

  it("aggregates two legs sharing an orderRef into one combined draft", () => {
    const leg1 = makeDraft({ orderRef: "ref-A", quantity: "27", tax: "3.00", fees: "1.00", externalId: "tr:exec:aaa" });
    const leg2 = makeDraft({ orderRef: "ref-A", quantity: "0.526515", tax: "0.05", fees: "0.00", externalId: "tr:exec:bbb" });
    const { aggregated, legMap } = aggregateByOrderRef([leg1, leg2]);
    expect(aggregated).toHaveLength(1);
    const combined = aggregated[0];
    // Quantity summed.
    expect(parseFloat(combined.quantity)).toBeCloseTo(27.526515, 4);
    // Tax and fees summed.
    expect(Number(combined.tax)).toBeCloseTo(3.05, 2);
    expect(Number(combined.fees)).toBeCloseTo(1.00, 2);
    // Price carried from the first leg (not recomputed).
    expect(combined.price).toBe("100.00");
    // legMap records both original indices.
    expect(legMap.get(0)?.sort()).toEqual([0, 1]);
  });

  it("does not mix legs with different orderRefs", () => {
    const leg1 = makeDraft({ orderRef: "ref-A", quantity: "10" });
    const leg2 = makeDraft({ orderRef: "ref-B", quantity: "5" });
    const { aggregated } = aggregateByOrderRef([leg1, leg2]);
    expect(aggregated).toHaveLength(2);
  });

  it("mixed: singleton + aggregated pair produces correct legMap entries", () => {
    const solo = makeDraft({ quantity: "3" }); // no orderRef
    const legA = makeDraft({ orderRef: "ord-1", quantity: "20", externalId: "tr:exec:x" });
    const legB = makeDraft({ orderRef: "ord-1", quantity: "0.1", externalId: "tr:exec:y" });
    const { aggregated, legMap } = aggregateByOrderRef([solo, legA, legB]);
    // Singleton + aggregated pair = 2 output drafts.
    expect(aggregated).toHaveLength(2);
    // The combined draft has summed quantity.
    const combined = aggregated.find((d) => parseFloat(d.quantity) > 3)!;
    expect(parseFloat(combined.quantity)).toBeCloseTo(20.1, 1);
    // legMap covers both output slots.
    let foundPair = false;
    for (const [, origIndices] of legMap) {
      if (origIndices.length === 2) foundPair = true;
    }
    expect(foundPair).toBe(true);
  });
});
