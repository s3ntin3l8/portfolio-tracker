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
  instruments,
} from "@portfolio/db";
import { ensureDb, getDb, closeDb } from "../../src/db/client.js";
import {
  enrichTransactionFromDrafts,
  enrichTransactionsFromStoredDocuments,
  txIdsWithFullTaxDetail,
  sourcesForTransactions,
} from "../../src/services/enrichment.js";
import { buildDocumentName, slug } from "../../src/storage/naming.js";
import type { ParsedTransaction } from "@portfolio/schema";

/**
 * Compute the same synthesized display name `sourcesForTransactions` produces, from the
 * fixture's own known inputs — via the real `buildDocumentName`, not a hand-typed literal, so
 * these tests break if the naming format itself changes, not just if this file drifts from it.
 */
function expectedDisplayName(opts: {
  type: string;
  executedAt: Date;
  portfolioName: string;
  ext: string;
  symbol?: string;
}) {
  const dt = opts.executedAt;
  const date = `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, "0")}-${String(dt.getUTCDate()).padStart(2, "0")}`;
  return buildDocumentName({
    scope: "transaction",
    date,
    year: String(dt.getUTCFullYear()),
    portfolioSlug: slug(opts.portfolioName),
    type: opts.type,
    symbol: opts.symbol ?? "unknown",
    ext: opts.ext,
    docId: "",
  });
}

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
    const map = await sourcesForTransactions(app as never, [tx.id], portfolio.id);

    const rows = map.get(tx.id) ?? [];
    expect(rows).toHaveLength(2);
    const types = rows.map((r) => r.sourceType).sort();
    expect(types).toEqual(["csv", "pdf"]);
  });

  it("returns empty map for empty input", async () => {
    const app = { db: getDb(), log: { warn: vi.fn(), info: vi.fn() } };
    // portfolioId is unused on the empty-input early-return path.
    const map = await sourcesForTransactions(app as never, [], "");
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
    const [row] = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(row.hasDocument).toBe(true);
    expect(row.filename).toBe(
      expectedDisplayName({ type: "buy", executedAt: tx.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );
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
    const [row] = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(row.documentId).toBeNull();
    expect(row.hasDocument).toBe(true);
    expect(row.filename).toBe(
      expectedDisplayName({ type: "buy", executedAt: tx.executedAt, portfolioName: portfolio.name, ext: ".csv" }),
    );
  });

  it("pytr rows never resolve a document; each transaction's OWN retained receipt gets its own synthetic pdf entry, not an arbitrary sibling's, when many docs share a collector import (TR)", async () => {
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
    const [docA, docB] = await db
      .insert(documents)
      .values([
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
      ])
      .returning();
    await db.insert(transactionSources).values([
      { transactionId: txA.id, sourceType: "pytr", importId: imp.id, documentId: null },
      { transactionId: txB.id, sourceType: "pytr", importId: imp.id, documentId: null },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const map = await sourcesForTransactions(app as never, [txA.id, txB.id], portfolio.id);
    const rowsA = map.get(txA.id)!;
    const rowsB = map.get(txB.id)!;

    const pytrA = rowsA.find((r) => r.sourceType === "pytr")!;
    expect(pytrA.hasDocument).toBe(false);
    expect(pytrA.filename).toBeNull();

    // Each transaction's own receipt surfaces as its own synthetic pdf entry — not an
    // arbitrary/shared one from the other transaction. `documentId` is the unambiguous
    // anti-leak signal (physical doc identity); the synthesized `filename` is checked too, to
    // confirm the naming pass ran (both come out identical in shape since txA/txB share the
    // same fixture type/executedAt/portfolio and neither has an instrument — that's expected,
    // not a leak, since the underlying documentId still correctly differs per transaction).
    const syntheticA = rowsA.find((r) => r.id !== pytrA.id)!;
    expect(syntheticA.sourceType).toBe("pdf");
    expect(syntheticA.hasDocument).toBe(true);
    expect(syntheticA.documentId).toBe(docA.id);
    expect(syntheticA.filename).toBe(
      expectedDisplayName({ type: "buy", executedAt: txA.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );

    const pytrB = rowsB.find((r) => r.sourceType === "pytr")!;
    expect(pytrB.hasDocument).toBe(false);
    const syntheticB = rowsB.find((r) => r.id !== pytrB.id)!;
    expect(syntheticB.documentId).toBe(docB.id);
    expect(syntheticB.filename).toBe(
      expectedDisplayName({ type: "buy", executedAt: txB.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );
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
    const [row] = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(row.hasDocument).toBe(false);
    expect(row.filename).toBeNull();
  });

  it("does NOT leak a sibling's own document onto a row with no documentId of its own", async () => {
    // Reproduces the post-backfill duplicate-source display: a pytr sync row (no document of
    // its own) and a pdf-enrichment row (its own documentId, same underlying settlement PDF)
    // on one transaction. Before the fix, the pytr row's `hasDocument` fell back to the
    // transaction-scoped document — the SAME one the pdf row already claims — showing as two
    // sources both "linked" to one file.
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, { type: "dividend" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        transactionId: tx.id,
        storageKey: `receipts/${user.id}/settlement.pdf`,
        mimeType: "application/pdf",
        originalFilename: "settlement.pdf",
        status: "retained",
      })
      .returning();
    await db.insert(transactionSources).values([
      { transactionId: tx.id, sourceType: "pytr", documentId: null },
      { transactionId: tx.id, sourceType: "pdf", documentId: doc.id },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const rows = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    const pytrRow = rows.find((r) => r.sourceType === "pytr")!;
    const pdfRow = rows.find((r) => r.sourceType === "pdf")!;
    expect(pytrRow.hasDocument).toBe(false);
    expect(pytrRow.filename).toBeNull();
    expect(pdfRow.hasDocument).toBe(true);
    expect(pdfRow.filename).toBe(
      expectedDisplayName({ type: "dividend", executedAt: tx.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );
  });

  it("does not attribute an unrelated unclaimed document to a sibling once any row has its own document", async () => {
    // A TR trade transaction typically has 2-3 stored documents: one real settlement PDF
    // (claimed by the pdf row's own documentId) plus 1-2 non-settlement leftovers
    // (SAVINGS_PLAN_CREATED, COSTS_INFO_*, a rejected REKLASSIFIZIERUNG) that were never
    // detect+parsed into their own source row. Once the pdf row has claimed the real document,
    // an unclaimed *other* document on the same transaction must NOT be misattributed to the
    // documentId-less pytr row as if it were that row's provenance — even though it is
    // "genuinely different" from the claimed one, it is not the pytr row's document either.
    // (The true CSV/legacy fallback — no sibling row owns any document at all — is covered by
    // "falls back to the import-linked document when the source has no documentId" above.)
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, { type: "dividend" });
    const [claimedDoc] = await db
      .insert(documents)
      .values([
        {
          userId: user.id,
          transactionId: tx.id,
          storageKey: `receipts/${user.id}/claimed.pdf`,
          mimeType: "application/pdf",
          originalFilename: "claimed.pdf",
          status: "retained",
        },
        {
          userId: user.id,
          transactionId: tx.id,
          storageKey: `receipts/${user.id}/unclaimed.pdf`,
          mimeType: "application/pdf",
          originalFilename: "unclaimed.pdf",
          status: "retained",
        },
      ])
      .returning();
    await db.insert(transactionSources).values([
      { transactionId: tx.id, sourceType: "pdf", documentId: claimedDoc.id },
      { transactionId: tx.id, sourceType: "pytr", documentId: null },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const rows = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    const pytrRow = rows.find((r) => r.sourceType === "pytr")!;
    const pdfRow = rows.find((r) => r.sourceType === "pdf")!;
    expect(pytrRow.hasDocument).toBe(false);
    expect(pytrRow.filename).toBeNull();
    expect(pdfRow.hasDocument).toBe(true);
    // documentId is the unambiguous proof that the CLAIMED doc resolved, not the unclaimed one
    // (both share the same tx type/executedAt/portfolio, so the synthesized filename below would
    // be identical either way — it only confirms the naming pass ran, not which doc was picked).
    expect(pdfRow.documentId).toBe(claimedDoc.id);
    expect(pdfRow.filename).toBe(
      expectedDisplayName({ type: "dividend", executedAt: tx.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );
  });

  it("does not leak an unrelated transaction's pinned doc via the shared-import fallback (TR carrier import)", async () => {
    // The TR document backfill downloads all historical per-event receipts through one synthetic
    // "carrier import" (one screenshotImports row shared by hundreds of transactions), with each
    // document pinned to its OWN transaction via documents.transactionId. Before the fix, the
    // import-level fallback (docNameByImportId) ignored transactionId and resolved an essentially
    // arbitrary document from that shared import for ANY documentId-less row whose importId
    // matched — including a transaction with no document of its own. Gating that fallback to
    // transactionId IS NULL (a genuine import-level artifact, e.g. one CSV statement PDF) closes
    // this without touching the legitimate CSV case (covered by the "CSV case" test above).
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const txOther = await makeTx(db, portfolio.id);
    const txNoDoc = await makeTx(db, portfolio.id);
    const [imp] = await db
      .insert(screenshotImports)
      .values({ userId: user.id, portfolioId: portfolio.id })
      .returning();
    // A document pinned to a DIFFERENT transaction, sharing the same collector import.
    await db.insert(documents).values({
      userId: user.id,
      importId: imp.id,
      transactionId: txOther.id,
      storageKey: `receipts/${user.id}/other.pdf`,
      mimeType: "application/pdf",
      originalFilename: "other.pdf",
      status: "retained",
    });
    // txNoDoc has no document of its own, only a pytr row sharing the collector importId.
    await db
      .insert(transactionSources)
      .values({ transactionId: txNoDoc.id, sourceType: "pytr", importId: imp.id, documentId: null });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [txNoDoc.id], portfolio.id)).get(txNoDoc.id) ?? [];
    expect(row.hasDocument).toBe(false);
    expect(row.filename).toBeNull();
  });

  it("gives an unparsed/rejected stored document its own downloadable pdf entry (always-show-every-PDF)", async () => {
    // A REKLASSIFIZIERUNG / compound-Zinskonto / COSTS_INFO document that detectTrPdf rejects
    // never gets its own transaction_sources row — but it's still retained in S3, and per the
    // clarified provenance model every retained document must be independently downloadable,
    // whether or not it carried enrichment value.
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, { type: "dividend" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        transactionId: tx.id,
        storageKey: `receipts/${user.id}/reklassifizierung.pdf`,
        mimeType: "application/pdf",
        originalFilename: "reklassifizierung.pdf",
        status: "retained",
      })
      .returning();
    await db.insert(transactionSources).values({ transactionId: tx.id, sourceType: "pytr", documentId: null });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const rows = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(rows).toHaveLength(2);

    const pytrRow = rows.find((r) => r.sourceType === "pytr")!;
    expect(pytrRow.hasDocument).toBe(false);
    expect(pytrRow.filename).toBeNull();

    const syntheticRow = rows.find((r) => r.sourceType === "pdf")!;
    expect(syntheticRow.id).toBe(`doc:${doc.id}`);
    expect(syntheticRow.documentId).toBe(doc.id);
    expect(syntheticRow.hasDocument).toBe(true);
    expect(syntheticRow.filename).toBe(
      expectedDisplayName({ type: "dividend", executedAt: tx.executedAt, portfolioName: portfolio.name, ext: ".pdf" }),
    );
  });

  it("does not synthesize a duplicate entry for a document already claimed by a real pdf row", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, { type: "dividend" });
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        transactionId: tx.id,
        storageKey: `receipts/${user.id}/settlement.pdf`,
        mimeType: "application/pdf",
        originalFilename: "settlement.pdf",
        status: "retained",
      })
      .returning();
    await db.insert(transactionSources).values([
      { transactionId: tx.id, sourceType: "pytr", documentId: null },
      { transactionId: tx.id, sourceType: "pdf", documentId: doc.id },
    ]);

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const rows = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(rows).toHaveLength(2); // pytr + the one real pdf row — no synthetic third entry
    const pdfRows = rows.filter((r) => r.sourceType === "pdf");
    expect(pdfRows).toHaveLength(1);
    expect(pdfRows[0].id).not.toMatch(/^doc:/);
  });

  it("synthesizes a display name using the transaction's own instrument symbol when one is set", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const [instrument] = await db
      .insert(instruments)
      .values({
        symbol: "AAPL",
        market: "XNAS",
        assetClass: "equity",
        currency: "USD",
        name: "Apple Inc.",
      })
      .returning();
    const tx = await makeTx(db, portfolio.id, { instrumentId: instrument.id });
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        transactionId: tx.id,
        storageKey: `receipts/${user.id}/settlement.pdf`,
        mimeType: "application/pdf",
        originalFilename: "d0f17246-8fad-4a01-9324-9c184a774.pdf",
        status: "retained",
      })
      .returning();
    await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "pdf", documentId: doc.id });

    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [tx.id], portfolio.id)).get(tx.id) ?? [];
    expect(row.filename).toBe(
      expectedDisplayName({
        type: "buy",
        executedAt: tx.executedAt,
        portfolioName: portfolio.name,
        ext: ".pdf",
        symbol: "AAPL",
      }),
    );
    expect(row.filename).not.toContain(doc.id);
  });

  it("falls back to the raw stored filename when display-name synthesis fails (best-effort, never throws)", async () => {
    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id);
    const [doc] = await db
      .insert(documents)
      .values({
        userId: user.id,
        transactionId: tx.id,
        storageKey: `receipts/${user.id}/settlement.pdf`,
        mimeType: "application/pdf",
        originalFilename: "settlement.pdf",
        status: "retained",
      })
      .returning();
    await db
      .insert(transactionSources)
      .values({ transactionId: tx.id, sourceType: "pdf", documentId: doc.id });

    // `portfolios.id` is a uuid column — a malformed portfolioId makes gatherDocumentMetadata's
    // portfolio-name lookup throw at the DB layer, strictly after the main source-row/document
    // queries (which use the real, valid `tx.id`) have already succeeded. Exercises the same
    // real failure surface the try/catch guards against, without mocking DB internals.
    const app = { db, log: { warn: vi.fn(), info: vi.fn() } };
    const [row] = (await sourcesForTransactions(app as never, [tx.id], "not-a-valid-uuid")).get(tx.id) ?? [];
    expect(row.hasDocument).toBe(true);
    expect(row.filename).toBe("settlement.pdf"); // raw fallback, not a synthesized name
    expect(app.log.warn).toHaveBeenCalled();
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
    // EUR-per-USD, derived from the two Zwischensumme amounts (5.51 EUR ÷ 6.38 USD) — not
    // the printed "1.1567 USD/EUR" label/direction (see tr-pdf.ts's fxRate comment).
    expect(src.fxRate).toBe("0.863636");
    expect((src.taxComponents as { quellensteuer?: string }).quellensteuer).toBe("0.98");
  });

  it("labels a re-parsed PDF's source row 'pdf' even when the draft carries no tax (Fix: importSource)", async () => {
    // A tax-free dividend (no Quellensteuer/Kapitalertragsteuer/Soli lines at all — e.g. a
    // tax-free quarter or a fund distribution) has an empty taxComponents draft. Passing
    // importSource: "pytr" (the old behaviour) would make draftSourceType fall through to
    // "pytr" for this draft, producing a SECOND row confusingly labeled the same as the
    // original sync row instead of "pdf".
    const TAXFREE_DIV_TEXT =
      "Trade Republic Bank GmbH DATUM 27.09.2023 DEPOT 1234567890 AUSSCHÜTTUNG ABRECHNUNG " +
      "POSITION BETRAG Zwischensumme 0,88 USD Zwischensumme 1,0587 EUR/USD 0,83 EUR GESAMT " +
      "0,83 EUR BUCHUNG VERRECHNUNGSKONTO WERTSTELLUNG BETRAG DE00000000000000000000 " +
      "27.09.2023 0,83 EUR ÜBERSICHT Ausschüttung POSITION ANZAHL ERTRAG BETRAG iShs Core " +
      "S&P 500 ISIN: IE0031442068 5,98573 Stk. 0,1462 USD 0,88 USD GESAMT 0,88 USD";
    mockExtractPdfText.mockResolvedValueOnce(TAXFREE_DIV_TEXT);

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, {
      type: "dividend",
      documentRefs: [{ id: "doc-ausschuettung-001", type: "INCOME", date: "2023-09-27" }],
    });
    // Pre-existing row from the original pytr activity-log sync (no document, no tax detail —
    // the state every dividend was in before any PDF backfill/enrichment ran).
    await db.insert(transactionSources).values({
      transactionId: tx.id,
      sourceType: "pytr",
      externalId: "activity-log-event-001",
      documentId: null,
    });
    await db.insert(documents).values({
      userId: user.id,
      portfolioId: portfolio.id,
      transactionId: tx.id,
      storageKey: "receipts/ausschuettung-001.pdf",
      mimeType: "application/pdf",
      status: "retained",
    });
    const app = makeApp(db, new Map([["receipts/ausschuettung-001.pdf", Buffer.from("x")]]));

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const rows = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    expect(rows).toHaveLength(2);
    const original = rows.find((r) => r.externalId === "activity-log-event-001")!;
    const enriched = rows.find((r) => r.externalId !== "activity-log-event-001")!;
    expect(original.sourceType).toBe("pytr");
    expect(enriched.sourceType).toBe("pdf");
  });

  it("writes TWO pdf source rows when two stored documents share one dividend externalId (split distribution)", async () => {
    // Reproduces the Realty Income case: one activity-log event settles across two distinct
    // settlement PDFs for the same depot+isin+pay-date (an ordinary, taxed portion and a
    // tax-free return-of-capital portion). Both parse to the SAME base
    // `tr:div:<depot>:<isin>:<paydate>` externalId — before the per-document suffix fix, the
    // second document's row was silently dropped by onConflictDoNothing and its documentId
    // overwrote the first in `documentsByExternalId`.
    const DOC_A_TEXT =
      "MARKER_A Trade Republic Bank GmbH DATUM 15.12.2025 DEPOT 1234567890 DIVIDENDE ÜBERSICHT " +
      "POSITION ANZAHL ERTRAG BETRAG Realty Income Corp US7561091049 10 Stücke 0.20 USD 2.00 USD " +
      "GESAMT 2.00 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -0.30 USD " +
      "Zwischensumme 1.70 USD Zwischensumme 1.0000 USD/EUR 1.70 EUR GESAMT 1.70 EUR BUCHUNG " +
      "VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 15.12.2025 1.70 EUR";
    const DOC_B_TEXT =
      "MARKER_B Trade Republic Bank GmbH DATUM 15.12.2025 DEPOT 1234567890 DIVIDENDE ÜBERSICHT " +
      "POSITION ANZAHL ERTRAG BETRAG Realty Income Corp US7561091049 10 Stücke 0.10 USD 1.00 USD " +
      "GESAMT 1.00 USD ABRECHNUNG POSITION BETRAG Zwischensumme 1.00 USD Zwischensumme 1.0000 " +
      "USD/EUR 1.00 EUR GESAMT 1.00 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG " +
      "DE00000000000000000000 15.12.2025 1.00 EUR";
    // Both queued callbacks dispatch on the actual bytes fetched, so the result is correct
    // regardless of which document the (unordered) documents query happens to process first.
    const dispatchByMarker = async (buf: Buffer) =>
      buf.toString().includes("MARKER_A") ? DOC_A_TEXT : DOC_B_TEXT;
    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);
    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, {
      type: "dividend",
      documentRefs: [{ id: "doc-split-a", type: "INCOME", date: "2025-12-15" }],
    });
    await db.insert(documents).values([
      {
        userId: user.id,
        portfolioId: portfolio.id,
        transactionId: tx.id,
        storageKey: "receipts/split-a.pdf",
        mimeType: "application/pdf",
        status: "retained",
      },
      {
        userId: user.id,
        portfolioId: portfolio.id,
        transactionId: tx.id,
        storageKey: "receipts/split-b.pdf",
        mimeType: "application/pdf",
        status: "retained",
      },
    ]);
    const app = makeApp(
      db,
      new Map([
        ["receipts/split-a.pdf", Buffer.from("MARKER_A-bytes")],
        ["receipts/split-b.pdf", Buffer.from("MARKER_B-bytes")],
      ]),
    );

    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const rows = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));

    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.sourceType === "pdf")).toBe(true);
    // Distinct, doc-suffixed externalIds — not the colliding bare `tr:div:...` key.
    const externalIds = new Set(rows.map((r) => r.externalId));
    expect(externalIds.size).toBe(2);
    for (const id of externalIds) expect(id).toMatch(/^tr:div:1234567890:US7561091049:2025-12-15:/);
    // Each row links its OWN document (not both collapsed onto one).
    const documentIds = new Set(rows.map((r) => r.documentId));
    expect(documentIds.size).toBe(2);

    const [updated] = await db
      .select({ tax: transactions.tax, perShare: transactions.perShare, grossNative: transactions.grossNative })
      .from(transactions)
      .where(eq(transactions.id, tx.id));
    // Rollup sums both documents: tax 0.30, perShare 0.20+0.10, grossNative 2.00+1.00.
    expect(Number(updated.tax)).toBeCloseTo(0.3, 2);
    expect(Number(updated.perShare)).toBeCloseTo(0.3, 6);
    expect(Number(updated.grossNative)).toBeCloseTo(3.0, 2);
  });

  it("re-running enrichment on the same two split-distribution documents is idempotent", async () => {
    const DOC_A_TEXT =
      "MARKER_A Trade Republic Bank GmbH DATUM 15.12.2025 DEPOT 1234567890 DIVIDENDE ÜBERSICHT " +
      "POSITION ANZAHL ERTRAG BETRAG Realty Income Corp US7561091049 10 Stücke 0.20 USD 2.00 USD " +
      "GESAMT 2.00 USD ABRECHNUNG POSITION BETRAG Quellensteuer für US-Emittenten -0.30 USD " +
      "Zwischensumme 1.70 USD Zwischensumme 1.0000 USD/EUR 1.70 EUR GESAMT 1.70 EUR BUCHUNG " +
      "VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG DE00000000000000000000 15.12.2025 1.70 EUR";
    const DOC_B_TEXT =
      "MARKER_B Trade Republic Bank GmbH DATUM 15.12.2025 DEPOT 1234567890 DIVIDENDE ÜBERSICHT " +
      "POSITION ANZAHL ERTRAG BETRAG Realty Income Corp US7561091049 10 Stücke 0.10 USD 1.00 USD " +
      "GESAMT 1.00 USD ABRECHNUNG POSITION BETRAG Zwischensumme 1.00 USD Zwischensumme 1.0000 " +
      "USD/EUR 1.00 EUR GESAMT 1.00 EUR BUCHUNG VERRECHNUNGSKONTO DATUM DER ZAHLUNG BETRAG " +
      "DE00000000000000000000 15.12.2025 1.00 EUR";
    const dispatchByMarker = async (buf: Buffer) =>
      buf.toString().includes("MARKER_A") ? DOC_A_TEXT : DOC_B_TEXT;

    const db = getDb();
    const s = nextSuffix();
    const { user, portfolio } = await makeUserAndPortfolio(db, s);
    const tx = await makeTx(db, portfolio.id, {
      type: "dividend",
      documentRefs: [{ id: "doc-split-idem-a", type: "INCOME", date: "2025-12-15" }],
    });
    await db.insert(documents).values([
      {
        userId: user.id,
        portfolioId: portfolio.id,
        transactionId: tx.id,
        storageKey: "receipts/split-idem-a.pdf",
        mimeType: "application/pdf",
        status: "retained",
      },
      {
        userId: user.id,
        portfolioId: portfolio.id,
        transactionId: tx.id,
        storageKey: "receipts/split-idem-b.pdf",
        mimeType: "application/pdf",
        status: "retained",
      },
    ]);
    const app = makeApp(
      db,
      new Map([
        ["receipts/split-idem-a.pdf", Buffer.from("MARKER_A-bytes")],
        ["receipts/split-idem-b.pdf", Buffer.from("MARKER_B-bytes")],
      ]),
    );

    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);
    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);
    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);
    mockExtractPdfText.mockImplementationOnce(dispatchByMarker);
    await enrichTransactionsFromStoredDocuments(app as never, [tx.id]);

    const rows = await db
      .select()
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, tx.id));
    // Still exactly two rows — the second run is a fixed point, not a third/fourth row.
    expect(rows).toHaveLength(2);
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
