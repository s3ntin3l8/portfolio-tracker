/**
 * Integration tests for enrichTransactionFromDrafts and related helpers.
 *
 * Tests run against PGlite (in-process Postgres) — no external DB needed.
 * The status-filter test for enrichTransactionsFromStoredDocuments uses vi.mock
 * to intercept extractPdfText, removing the need for real PDF bytes.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { eq } from "drizzle-orm";
import {
  users,
  portfolios,
  transactions,
  transactionSources,
  documents,
  screenshotImports,
} from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  enrichTransactionFromDrafts,
  enrichTransactionsFromStoredDocuments,
  txIdsWithFullTaxDetail,
  sourcesForTransactions,
} from "../../src/services/enrichment.js";
import type { ParsedTransaction } from "@portfolio/schema";

// ---------------------------------------------------------------------------
// Mock extractPdfText so enrichTransactionsFromStoredDocuments tests don't
// require real PDF bytes. detectTrPdf and parseTrPdf run on the returned text.
// vi.hoisted is required: vi.mock factories are hoisted to the top of the file,
// so regular top-level const declarations are not yet initialised when they run.
// ---------------------------------------------------------------------------

const { _MINIMAL_TR_TEXT, mockExtractPdfText } = vi.hoisted(() => {
  const text = [
    "Trade Republic Bank GmbH",
    "DATUM 25.02.2025 AUFTRAG abc1-2345 AUSFÜHRUNG def6-7890 DEPOT 1234567890",
    "WERTPAPIERABRECHNUNG",
    "ÜBERSICHT Kauf an der Tradegate Exchange",
    "POSITION ANZAHL PREIS BETRAG",
    "BETRAG iShares Core MSCI World UCITS ETF ISIN: IE00B5BMR087 10 Stk. 100,00 EUR 999,00 EUR",
    "ABRECHNUNG",
    "Fremdkostenzuschlag -1,00 EUR",
    "Kapitalertragsteuer 3,75 EUR",
    "Solidaritätszuschlag 0,21 EUR",
    "BUCHUNG",
    "WERTSTELLUNG 2025-02-25 999,00 EUR",
  ].join("\n");
  return { _MINIMAL_TR_TEXT: text, mockExtractPdfText: vi.fn().mockResolvedValue(text) };
});

vi.mock("../../src/services/parsers/pdf-text.js", () => ({
  extractPdfText: mockExtractPdfText,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type DB = ReturnType<typeof getDb>;

let uid = 0;
function nextSuffix() {
  return `enrich-${++uid}`;
}

async function makeUserAndPortfolio(db: DB, suffix: string) {
  const [user] = await db
    .insert(users)
    .values({ authSub: `enrich|${suffix}`, email: `${suffix}@enrich.test` })
    .returning();
  const [portfolio] = await db
    .insert(portfolios)
    .values({ userId: user.id, name: "Enrich Test", baseCurrency: "EUR" })
    .returning();
  return { user, portfolio };
}

async function makeTx(
  db: DB,
  portfolioId: string,
  overrides: Partial<typeof transactions.$inferInsert> = {},
) {
  const [tx] = await db
    .insert(transactions)
    .values({
      portfolioId,
      type: "buy",
      source: "csv",
      quantity: "10",
      price: "100.00",
      currency: "EUR",
      executedAt: new Date("2025-02-25"),
      ...overrides,
    })
    .returning();
  return tx;
}

function draft(overrides: Partial<ParsedTransaction> & Pick<ParsedTransaction, "action">): ParsedTransaction {
  return {
    isin: "IE00B5BMR087",
    name: "iShares Core MSCI World",
    quantity: "10",
    price: "100.00",
    currency: "EUR",
    executedAt: new Date("2025-02-25"),
    confidence: 1,
    unit: "shares",
    ...overrides,
  } as ParsedTransaction;
}

// ---------------------------------------------------------------------------
// Suite setup
// ---------------------------------------------------------------------------

beforeAll(async () => {
  await ensureDb();
}, 30_000);

afterAll(async () => {
  await closeDb();
});

// ---------------------------------------------------------------------------
// enrichTransactionFromDrafts
// ---------------------------------------------------------------------------

describe("enrichTransactionFromDrafts — basic write + rollup", () => {
  it("writes a source row and updates tx.tax from one pdf draft", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);

    const d = draft({
      action: "buy",
      externalId: "tr:exec:aaa-001",
      tax: "3.96",
      fees: "1.00",
      taxComponents: { kapitalertragsteuer: "3.75", solidaritaetszuschlag: "0.21" },
    });

    await enrichTransactionFromDrafts(tx.id, db, [d], { importSource: "pdf" });

    const [updated] = await db
      .select({ tax: transactions.tax, fees: transactions.fees })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    expect(Number(updated.tax)).toBeCloseTo(3.96, 2);
    expect(Number(updated.fees)).toBeCloseTo(1.0, 2);

    const sources = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));

    expect(sources).toHaveLength(1);
    expect(sources[0].sourceType).toBe("pdf");
    expect(sources[0].externalId).toBe("tr:exec:aaa-001");
    expect(Number(sources[0].tax)).toBeCloseTo(3.96, 2);
    expect(sources[0].taxComponents).toMatchObject({ kapitalertragsteuer: "3.75" });
  });

  it("second call with leg2 sums tax across both pdf rows (proves read-all-rows)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);

    const leg1 = draft({
      action: "buy",
      externalId: "tr:exec:leg1-001",
      tax: "3.00",
      fees: "1.00",
    });
    const leg2 = draft({
      action: "buy",
      externalId: "tr:exec:leg2-002",
      tax: "1.50",
      fees: "0.50",
    });

    await enrichTransactionFromDrafts(tx.id, db, [leg1], { importSource: "pdf" });
    await enrichTransactionFromDrafts(tx.id, db, [leg2], { importSource: "pdf" });

    const [updated] = await db
      .select({ tax: transactions.tax, fees: transactions.fees })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    expect(Number(updated.tax)).toBeCloseTo(4.5, 2);
    expect(Number(updated.fees)).toBeCloseTo(1.5, 2);

    const sources = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));

    expect(sources).toHaveLength(2);
  });

  it("re-running with the same draft is idempotent (no duplicate source rows)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);

    const d = draft({
      action: "buy",
      externalId: "tr:exec:idem-001",
      tax: "4.80",
      fees: "1.00",
    });

    await enrichTransactionFromDrafts(tx.id, db, [d], { importSource: "pdf" });
    await enrichTransactionFromDrafts(tx.id, db, [d], { importSource: "pdf" });

    const sources = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));

    expect(sources).toHaveLength(1);

    const [updated] = await db
      .select({ tax: transactions.tax })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    expect(Number(updated.tax)).toBeCloseTo(4.8, 2);
  });

  it("csv after pdf does not downgrade the tax rollup", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);

    // PDF draft carries taxComponents → draftSourceType resolves to "pdf" (rank 40).
    const pdfDraft = draft({
      action: "buy",
      externalId: "tr:exec:nodown-001",
      tax: "4.80",
      fees: "1.00",
      taxComponents: { kapitalertragsteuer: "3.75", solidaritaetszuschlag: "0.21" },
    });
    // CSV draft has no taxComponents → draftSourceType resolves to "csv" (rank 20).
    const csvDraft = draft({
      action: "buy",
      externalId: "csv:nodown-001",
      tax: "5.00",
      fees: "0.50",
    });

    await enrichTransactionFromDrafts(tx.id, db, [pdfDraft], { importSource: "pdf" });
    await enrichTransactionFromDrafts(tx.id, db, [csvDraft], { importSource: "csv" });

    const [updated] = await db
      .select({ tax: transactions.tax, fees: transactions.fees })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    // PDF rank (40) beats CSV rank (20) — rollup unchanged after adding the csv row.
    expect(Number(updated.tax)).toBeCloseTo(4.8, 2);
    expect(Number(updated.fees)).toBeCloseTo(1.0, 2);
  });

  it("manual source row prevents scalar update", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, { tax: "7.00" });

    // Write a manual source row directly (simulates a hand-edit).
    await db.insert(transactionSources).values({
      transactionId: tx.id,
      sourceType: "manual",
      tax: "7.00",
    });

    const d = draft({
      action: "buy",
      externalId: "tr:exec:manual-001",
      tax: "4.00",
    });

    await enrichTransactionFromDrafts(tx.id, db, [d], { importSource: "pdf" });

    const [updated] = await db
      .select({ tax: transactions.tax })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    // Manual wins — tax stays at the original 7.00.
    expect(Number(updated.tax)).toBeCloseTo(7.0, 2);
  });
});

// ---------------------------------------------------------------------------
// txIdsWithFullTaxDetail
// ---------------------------------------------------------------------------

describe("txIdsWithFullTaxDetail", () => {
  it("returns ids where at least one source row has non-null taxComponents", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const txA = await makeTx(db, portfolio.id);
    const txB = await makeTx(db, portfolio.id);

    // txA: pdf source with taxComponents
    await db.insert(transactionSources).values({
      transactionId: txA.id,
      sourceType: "pdf",
      taxComponents: { kapitalertragsteuer: "3.75" },
    });

    // txB: csv source, no taxComponents
    await db.insert(transactionSources).values({
      transactionId: txB.id,
      sourceType: "csv",
      taxComponents: null,
    });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const result = await txIdsWithFullTaxDetail(app as never, [txA.id, txB.id]);

    expect(result.has(txA.id)).toBe(true);
    expect(result.has(txB.id)).toBe(false);
  });

  it("returns empty set for empty input", async () => {
    const app = { db: getDb(), log: { warn: vi.fn(), info: vi.fn() } };
    const result = await txIdsWithFullTaxDetail(app as never, []);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// sourcesForTransactions
// ---------------------------------------------------------------------------

describe("sourcesForTransactions", () => {
  it("returns source rows grouped by transactionId", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);

    await db.insert(transactionSources).values([
      { transactionId: tx.id, sourceType: "csv", externalId: "csv:grp-001" },
      { transactionId: tx.id, sourceType: "pdf", externalId: "tr:exec:grp-002", taxComponents: { kapitalertragsteuer: "3.75" } },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const map = await sourcesForTransactions(app as never, [tx.id]);

    const rows = map.get(tx.id) ?? [];
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.sourceType).sort();
    expect(types).toEqual(["csv", "pdf"]);
  });

  it("returns empty map for empty input", async () => {
    const app = { db: getDb(), log: { warn: vi.fn(), info: vi.fn() } };
    const map = await sourcesForTransactions(app as never, []);
    expect(map.size).toBe(0);
  });

  it("resolves filename + hasDocument from a per-source documentId (retained PDF)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        storageKey: `receipts/${user.id}/settlement.pdf`,
        mimeType: "application/pdf",
        originalFilename: "settlement.pdf",
        status: "retained",
      })
      .returning();
    await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "pdf", documentId: doc.id });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [tx.id])).get(tx.id) ?? [];
    expect(row.hasDocument).toBe(true);
    expect(row.filename).toBe("settlement.pdf");
  });

  it("falls back to the import-linked document when the source has no documentId (CSV case)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId: user.id, portfolioId: portfolio.id })
      .returning();
    await db.insert(documents).values({
      userId: user.id,
      importId: imp.id,
      storageKey: `receipts/${user.id}/statement.csv`,
      mimeType: "text/csv",
      originalFilename: "statement.csv",
      status: "retained",
    });
    // CSV source row: documentId is null, file linked via importId.
    await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "csv", importId: imp.id, documentId: null });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [tx.id])).get(tx.id) ?? [];
    expect(row.documentId).toBeNull();
    expect(row.hasDocument).toBe(true);
    expect(row.filename).toBe("statement.csv");
  });

  it("resolves the transaction-scoped doc, not an arbitrary one, when many docs share a collector import (TR)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const txA = await makeTx(db, portfolio.id);
    const txB = await makeTx(db, portfolio.id);
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId: user.id, portfolioId: portfolio.id })
      .returning();
    // Two docs share the collector importId but each is linked to its own transaction.
    await db.insert(documents).values([
      {
        userId: user.id,
        importId: imp.id,
        transactionId: txA.id,
        storageKey: `receipts/${user.id}/a.pdf`,
        mimeType: "application/pdf",
        originalFilename: "receipt-A.pdf",
        status: "retained",
      },
      {
        userId: user.id,
        importId: imp.id,
        transactionId: txB.id,
        storageKey: `receipts/${user.id}/b.pdf`,
        mimeType: "application/pdf",
        originalFilename: "receipt-B.pdf",
        status: "retained",
      },
    ]);
    await db.insert(transactionSources).values([
      { transactionId: txA.id, sourceType: "pytr", importId: imp.id, documentId: null },
      { transactionId: txB.id, sourceType: "pytr", importId: imp.id, documentId: null },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const map = await sourcesForTransactions(app as never, [txA.id, txB.id]);
    // Each transaction resolves its OWN per-transaction receipt, not a shared/arbitrary one.
    expect(map.get(txA.id)![0].filename).toBe("receipt-A.pdf");
    expect(map.get(txB.id)![0].filename).toBe("receipt-B.pdf");
  });

  it("reports hasDocument=false + null filename when no document is retained", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);
    await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "manual", documentId: null });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [tx.id])).get(tx.id) ?? [];
    expect(row.hasDocument).toBe(false);
    expect(row.filename).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// enrichTransactionsFromStoredDocuments — status filter
//
// This suite catches the bug where the document query filtered by status="retained"
// only, making auto-enrichment a guaranteed no-op at confirm time (docs are still
// "staged" before finalizeReceipts runs).
// ---------------------------------------------------------------------------

describe("enrichTransactionsFromStoredDocuments — status filter", () => {
  function makeApp(db: DB, storageData: Map<string, Buffer>) {
    return {
      db,
      log: { warn: vi.fn(), info: vi.fn() } as unknown as ReturnType<typeof getDb>,
      storage: {
        get: async (key: string) => storageData.get(key) ?? null,
        put: async () => {},
        delete: async () => {},
        exists: async (key: string) => storageData.has(key),
        getSignedUrl: async (key: string) => `https://fake/${key}`,
      },
    };
  }

  it("processes staged documents (pre-finalizeReceipts path) — the confirm-time case", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);

    // Transaction with a documentRefs pointing at a settlement PDF.
    const tx = await makeTx(db, portfolio.id, {
      documentRefs: [{ id: "doc-staged-001", type: "SECURITIES_SETTLEMENT", date: "2025-02-25" }],
    });

    // Insert the document in "staged" status (default — finalizeReceipts hasn't run).
    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/staged-001.pdf",
      mimeType: "application/pdf",
      status: "staged",
    });

    // Storage returns fake bytes; extractPdfText is mocked to return MINIMAL_TR_TEXT.
    const storageData = new Map<string, Buffer>([
      ["receipts/staged-001.pdf", Buffer.from("fake-pdf-bytes")],
    ]);
    const app = makeApp(db, storageData);

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    // The tx should now have tax set from the parsed MINIMAL_TR_TEXT (tax = 3.75 + 0.21).
    const [updated] = await db
      .select({ tax: transactions.tax })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    expect(Number(updated.tax)).toBeGreaterThan(0);
  });

  it("also processes retained documents (backfill path)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);

    const tx = await makeTx(db, portfolio.id, {
      documentRefs: [{ id: "doc-retained-001", type: "SECURITIES_SETTLEMENT", date: "2025-02-25" }],
    });

    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/retained-001.pdf",
      mimeType: "application/pdf",
      status: "retained",
    });

    const storageData = new Map<string, Buffer>([
      ["receipts/retained-001.pdf", Buffer.from("fake-pdf-bytes")],
    ]);
    const app = makeApp(db, storageData);

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const [updated] = await db
      .select({ tax: transactions.tax })
      .from(transactions)
      .where(eq(transactions.id, tx.id));

    expect(Number(updated.tax)).toBeGreaterThan(0);
  });

  it("writes executedPrice and signed sell tax (Steueroptimierung) to the source row", async () => {
    const SELL_TEXT =
      "Trade Republic Bank GmbH DATUM 30.05.2024 ORDER aa-bb AUSFÜHRUNG cc-dd DEPOT 1234567890 " +
      "WERTPAPIERABRECHNUNG ABRECHNUNG POSITION BETRAG Fremdkostenzuschlag -1,00 EUR " +
      "Kapitalertragsteuer Optimierung 3,38 EUR Solidaritätszuschlag Optimierung 0,18 EUR " +
      "GESAMT 1.287,40 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 " +
      "03.06.2024 1.287,40 EUR ÜBERSICHT Verkauf POSITION ANZAHL PREIS BETRAG AbbVie Inc. " +
      "ISIN: US00287Y1091 9 Stk. 142,76 EUR 1.284,84 EUR GESAMT 1.284,84 EUR";
    mockExtractPdfText.mockResolvedValueOnce(SELL_TEXT);

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, {
      type: "sell",
      documentRefs: [{ id: "doc-sell-001", type: "SECURITIES_SETTLEMENT", date: "2024-05-30" }],
    });
    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/sell-001.pdf",
      mimeType: "application/pdf",
      status: "retained",
    });
    const app = makeApp(db, new Map([["receipts/sell-001.pdf", Buffer.from("x")]]));

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const [src] = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    // RC#3: executedPrice now propagates from the parsed draft.
    expect(src.executedPrice).toBe("142.76");
    // RC#5: Steueroptimierung refund → negative realised tax + signed breakdown.
    expect(src.tax).toBe("-3.56");
    expect((src.taxComponents as { kapitalertragsteuer?: string }).kapitalertragsteuer).toBe("-3.38");
  });

  it("enriches a dividend whose documentRef type is NOT in the old settlement allowlist", async () => {
    // RC#1: the SETTLEMENT_TYPES pre-filter is gone — an "INCOME" dividend doc (previously
    // skipped) is now fed to detectTrPdf/parseTrPdf and yields the withholding tax + FX.
    const DIV_TEXT =
      "Trade Republic Bank GmbH DATUM 16.06.2026 DEPOT 1234567890 DIVIDENDE ÜBERSICHT POSITION " +
      "ANZAHL ERTRAG BETRAG Main Street Capital US56035L1044 28.876429 Stücke 0.26 USD 7.51 USD " +
      "GESAMT 7.51 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -1.13 USD " +
      "Zwischensumme 6.38 USD Zwischensumme 1.1567 USD/EUR 5.51 EUR GESAMT 5.51 EUR BUCHUNG " +
      "VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 15.06.2026 5.51 EUR";
    mockExtractPdfText.mockResolvedValueOnce(DIV_TEXT);

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, {
      type: "dividend",
      documentRefs: [{ id: "doc-income-001", type: "INCOME", date: "2026-06-16" }],
    });
    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/income-001.pdf",
      mimeType: "application/pdf",
      status: "retained",
    });
    const app = makeApp(db, new Map([["receipts/income-001.pdf", Buffer.from("x")]]));

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const [src] = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    expect(src.fxRate).toBe("1.1567");
    expect((src.taxComponents as { quellensteuer?: string }).quellensteuer).toBe("0.98");
  });

  it("skips documents that extractPdfText produces non-TR text for", async () => {
    mockExtractPdfText.mockResolvedValueOnce("This is a DKB PDF, not a TR settlement.");

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);

    const tx = await makeTx(db, portfolio.id, {
      documentRefs: [{ id: "doc-non-tr-001", type: "SECURITIES_SETTLEMENT", date: "2025-02-25" }],
    });

    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/non-tr-001.pdf",
      mimeType: "application/pdf",
      status: "staged",
    });

    const storageData = new Map<string, Buffer>([
      ["receipts/non-tr-001.pdf", Buffer.from("fake-pdf-bytes")],
    ]);
    const app = makeApp(db, storageData);

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    // detectTrPdf returned false — no source row should be written.
    const sources = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));

    expect(sources).toHaveLength(0);
  });
});
