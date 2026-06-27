/**
 * Unit tests for services/api/src/storage/naming.ts.
 *
 * Tests the pure helpers (slug, extFromMime, buildDocumentName, buildStructuredKey)
 * that don't require a DB connection, and the gatherDocumentNaming helper
 * via a minimal in-memory "app" with a PGlite-backed DB.
 */
import { describe, it, expect } from "vitest";
import {
  slug,
  extFromMime,
  buildDocumentName,
  buildStructuredKey,
  computeNamingParts,
} from "../../src/storage/naming.js";
import type { DocumentForNaming } from "../../src/storage/naming.js";

// ---------------------------------------------------------------------------
// slug
// ---------------------------------------------------------------------------

describe("slug", () => {
  it("preserves alphanumeric and hyphens", () => {
    expect(slug("Mandiri-Sekuritas")).toBe("Mandiri-Sekuritas");
  });

  it("replaces spaces with hyphens", () => {
    expect(slug("DKB Depot")).toBe("DKB-Depot");
  });

  it("collapses runs of special chars to a single hyphen", () => {
    expect(slug("My  Portfolio / 2024")).toBe("My-Portfolio-2024");
  });

  it("strips leading/trailing hyphens", () => {
    expect(slug("  -hello- ")).toBe("hello");
  });

  it("returns 'document' for empty / all-special strings", () => {
    expect(slug("")).toBe("document");
    expect(slug("!!!")).toBe("document");
  });

  it("caps at 64 chars", () => {
    const long = "a".repeat(100);
    expect(slug(long).length).toBe(64);
  });
});

// ---------------------------------------------------------------------------
// extFromMime
// ---------------------------------------------------------------------------

describe("extFromMime", () => {
  it("maps known types", () => {
    expect(extFromMime("application/pdf")).toBe(".pdf");
    expect(extFromMime("image/png")).toBe(".png");
    expect(extFromMime("image/jpeg")).toBe(".jpg");
    expect(extFromMime("text/csv")).toBe(".csv");
  });

  it("returns empty string for unknown types", () => {
    expect(extFromMime("application/octet-stream")).toBe("");
    expect(extFromMime("")).toBe("");
  });
});

// ---------------------------------------------------------------------------
// buildDocumentName
// ---------------------------------------------------------------------------

describe("buildDocumentName", () => {
  it("produces a date-first transaction name", () => {
    expect(
      buildDocumentName({
        scope: "transaction",
        portfolioSlug: "Mandiri-Sekuritas",
        date: "2024-03-15",
        year: "2024",
        type: "buy",
        symbol: "BBCA",
        ext: ".pdf",
        docId: "a1b2c3d4",
      }),
    ).toBe("2024-03-15_Mandiri-Sekuritas_buy_BBCA.pdf");
  });

  it("produces a period-first statement name", () => {
    expect(
      buildDocumentName({
        scope: "statement",
        portfolioSlug: "DKB-Depot",
        period: "2024-03",
        source: "dkb",
        ext: ".pdf",
        docId: "a1b2c3d4",
      }),
    ).toBe("2024-03_DKB-Depot_statement_dkb.pdf");
  });

  it("slugifies the type segment", () => {
    expect(
      buildDocumentName({
        scope: "transaction",
        portfolioSlug: "My-Portfolio",
        date: "2024-01-01",
        year: "2024",
        type: "savings plan",
        symbol: "VTI",
        ext: ".pdf",
        docId: "a1b2c3d4",
      }),
    ).toBe("2024-01-01_My-Portfolio_savings-plan_VTI.pdf");
  });

  it("handles missing extension gracefully", () => {
    expect(
      buildDocumentName({
        scope: "statement",
        portfolioSlug: "Portfolio",
        period: "2024-05",
        source: "screenshot",
        ext: "",
        docId: "a1b2c3d4",
      }),
    ).toBe("2024-05_Portfolio_statement_screenshot");
  });
});

// ---------------------------------------------------------------------------
// buildStructuredKey
// ---------------------------------------------------------------------------

describe("buildStructuredKey", () => {
  const userId = "user-123";

  it("produces a year-prefixed path for transaction scope", () => {
    expect(
      buildStructuredKey(userId, {
        scope: "transaction",
        portfolioSlug: "DKB-Depot",
        date: "2024-03-15",
        year: "2024",
        type: "buy",
        symbol: "VTI",
        ext: ".pdf",
        docId: "deadbeef",
      }),
    ).toBe("receipts/user-123/DKB-Depot/2024/2024-03-15_buy_VTI_deadbeef.pdf");
  });

  it("produces a flat period path for statement scope", () => {
    expect(
      buildStructuredKey(userId, {
        scope: "statement",
        portfolioSlug: "DKB-Depot",
        period: "2024-03",
        source: "dkb",
        ext: ".pdf",
        docId: "deadbeef",
      }),
    ).toBe("receipts/user-123/DKB-Depot/2024-03_statement_dkb_deadbeef.pdf");
  });

  it("two docs with the same date/type/symbol get unique keys via docId", () => {
    const base = {
      scope: "transaction" as const,
      portfolioSlug: "Portfolio",
      date: "2024-03-15",
      year: "2024",
      type: "buy",
      symbol: "BBCA",
      ext: ".pdf",
    };
    const key1 = buildStructuredKey(userId, { ...base, docId: "11111111" });
    const key2 = buildStructuredKey(userId, { ...base, docId: "22222222" });
    expect(key1).not.toBe(key2);
    expect(key1.endsWith("_11111111.pdf")).toBe(true);
    expect(key2.endsWith("_22222222.pdf")).toBe(true);
  });

  it("always starts with receipts/", () => {
    const key = buildStructuredKey(userId, {
      scope: "statement",
      portfolioSlug: "P",
      period: "2024-01",
      source: "csv",
      ext: ".csv",
      docId: "aaaabbbb",
    });
    expect(key.startsWith("receipts/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// computeNamingParts (pure — the DB resolution lives in gatherDocumentMetadata)
// ---------------------------------------------------------------------------

describe("computeNamingParts", () => {
  const baseDoc: DocumentForNaming = {
    id: "a1b2c3d4-1111-2222-3333-444455556666",
    mimeType: "application/pdf",
    source: "pytr",
    storedAt: new Date("2024-05-20T00:00:00Z"),
    importId: null,
    transactionId: "tx-1",
  };

  it("transaction scope: tx date/type + instrument symbol", () => {
    expect(
      computeNamingParts(baseDoc, {
        portfolioName: "Mandiri Sekuritas",
        tx: { type: "buy", executedAt: new Date("2024-03-15T10:00:00Z"), instrumentId: "inst-1" },
        instrumentSymbol: "BBCA",
        importMinDate: null,
      }),
    ).toEqual({
      scope: "transaction",
      portfolioSlug: "Mandiri-Sekuritas",
      date: "2024-03-15",
      year: "2024",
      type: "buy",
      symbol: "BBCA",
      ext: ".pdf",
      docId: "a1b2c3d4",
    });
  });

  it("transaction scope: symbol 'unknown' when the instrument is missing", () => {
    expect(
      computeNamingParts(baseDoc, {
        portfolioName: "P",
        tx: { type: "sell", executedAt: new Date("2024-03-15T00:00:00Z"), instrumentId: null },
        instrumentSymbol: null,
        importMinDate: null,
      }),
    ).toMatchObject({ scope: "transaction", symbol: "unknown" });
  });

  it("statement scope: period from importMinDate, source label mapped", () => {
    const doc = { ...baseDoc, transactionId: null, importId: "imp-1" };
    expect(
      computeNamingParts(doc, {
        portfolioName: "DKB Depot",
        tx: null,
        instrumentSymbol: null,
        importMinDate: new Date("2024-02-10T00:00:00Z"),
      }),
    ).toEqual({
      scope: "statement",
      portfolioSlug: "DKB-Depot",
      period: "2024-02",
      source: "tr", // pytr → tr
      ext: ".pdf",
      docId: "a1b2c3d4",
    });
  });

  it("statement scope: falls back to storedAt when the import has no transactions", () => {
    const doc = { ...baseDoc, transactionId: null, importId: "imp-1" };
    expect(
      computeNamingParts(doc, {
        portfolioName: "P",
        tx: null,
        instrumentSymbol: null,
        importMinDate: null,
      }),
    ).toMatchObject({ scope: "statement", period: "2024-05" }); // storedAt
  });

  it("portfolioSlug defaults to 'portfolio' when the name is null", () => {
    const doc = { ...baseDoc, transactionId: null, importId: null };
    expect(
      computeNamingParts(doc, {
        portfolioName: null,
        tx: null,
        instrumentSymbol: null,
        importMinDate: null,
      }),
    ).toMatchObject({ portfolioSlug: "portfolio" });
  });
});
