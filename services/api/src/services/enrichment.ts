/**
 * Transaction enrichment (issue #230) — DB-side write path.
 *
 * A transaction can carry ≥2 source records (transaction_sources rows).  When a
 * richer PDF is imported after a CSV/timeline row, `enrichTransactionFromDrafts`
 * writes the per-source rows and recomputes the transaction's tax/fees/price rollup
 * from all accumulated sources via `recomputeRollup`.
 *
 * Two callers:
 *  - **Auto/TR path**: `enrichTransactionsFromStoredDocuments` — invoked at confirm
 *    time (after `linkTrReceiptsToTransactions`), reads the stored settlement PDFs
 *    linked to each newly-confirmed transaction and folds their detail in. Best-effort.
 *  - **Manual route**: `POST /imports/:importId/enrich` — user explicitly selects
 *    "Enrich existing" after the 409 duplicate surfaced a match.
 */

import type { FastifyInstance } from "fastify";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { transactionSources, transactions, documents } from "@portfolio/db";
import type { TransactionSource } from "@portfolio/db";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import { LOW_CONFIDENCE_THRESHOLD } from "@portfolio/schema";
import type { DB } from "../db/client.js";
import { recomputeRollup, type SourceRow } from "./parsers/dedup.js";
import { extractPdfText } from "./parsers/pdf-text.js";
import { detectTrPdf, parseTrPdf } from "./parsers/tr-pdf.js";
import {
  gatherDocumentMetadata,
  namingContextFor,
  computeNamingParts,
  buildDocumentName,
  type NamingRequest,
  type DocumentForNaming,
} from "../storage/naming.js";

type AppLike = Pick<FastifyInstance, "db" | "log">;
type AppWithStorage = Pick<FastifyInstance, "db" | "log" | "storage">;

function db(app: AppLike): DB {
  return app.db as DB;
}

// ---------------------------------------------------------------------------
// sourceType helper
// ---------------------------------------------------------------------------

/**
 * Derive the sourceType for a transaction_sources row from the draft.
 *  - Draft carries taxComponents (from a PDF parser) → "pdf".
 *  - Otherwise: fall back to the import's source label.
 */
function draftSourceType(
  draft: ParsedTransaction,
  importSource: string,
): TransactionSource["sourceType"] {
  if (draft.taxComponents && Object.keys(draft.taxComponents).length > 0) return "pdf";
  // Map transaction sources to the txSourceTypeEnum values.
  if (importSource === "pytr") return "pytr";
  if (importSource === "ibkr") return "ibkr";
  if (importSource === "manual") return "manual";
  if (importSource === "screenshot") return "screenshot";
  if (importSource === "pdf") return "pdf";
  return "csv";
}

// ---------------------------------------------------------------------------
// Core enrichment function
// ---------------------------------------------------------------------------

/**
 * Write source rows for the given drafts onto `transactionId`, then recompute and
 * update the transaction's tax/fees/executedPrice/fxRate/venue from all its source
 * rows via `recomputeRollup`.
 *
 * - Writes ONE source row per draft (keyed by AUSFÜHRUNG externalId).
 * - `onConflictDoNothing` on the partial unique index → idempotent for re-runs.
 * - Skips the rollup update when a `manual` source row is present (user-edited data wins).
 * - Links `documentId` to each source row when the draft's externalId matches a retained
 *   document.
 *
 * Returns the ids of source rows written (may be empty when all rows already existed).
 */
export async function enrichTransactionFromDrafts(
  transactionId: string,
  dbClient: DB,
  drafts: ParsedTransaction[],
  opts: {
    importId?: string;
    importSource?: string;
    /** Map from draft externalId → documentId (for linking settlement PDFs). */
    documentsByExternalId?: Map<string, string>;
  } = {},
): Promise<string[]> {
  if (drafts.length === 0) return [];

  const { importId, importSource = "csv", documentsByExternalId } = opts;

  // Write a source row per draft (by AUSFÜHRUNG externalId — the per-leg idempotency key).
  // Split-order legs (same AUFTRAG, different AUSFÜHRUNG) each create their own source row.
  // `recomputeRollup` sums tax/fees across same-rank rows for the informational rollup.
  // TR split orders intentionally import as two separate transactions (one per settlement
  // PDF), which is correct — each represents a real fill at its stated price/quantity.

  const writtenIds: string[] = [];

  for (const draft of drafts) {
    const sourceType = draftSourceType(draft, importSource);
    const externalId = draft.externalId ?? null;
    const documentId = externalId && documentsByExternalId
      ? (documentsByExternalId.get(externalId) ?? null)
      : null;

    const taxComponents =
      draft.taxComponents && Object.keys(draft.taxComponents).length > 0
        ? (draft.taxComponents as Record<string, unknown>)
        : null;

    const [row] = await dbClient
      .insert(transactionSources)
      .values({
        transactionId,
        sourceType,
        importId: importId ?? null,
        documentId,
        externalId,
        orderRef: draft.orderRef ?? null,
        // Store scalars so recomputeRollup can derive the tx-level rollup from source rows
        // alone — without reading currentTx (which would collapse rank information).
        tax: draft.tax ?? null,
        fees: draft.fees ?? null,
        executedPrice: draft.executedPrice ?? null,
        fxRate: draft.fxRate ?? null,
        venue: draft.venue ?? null,
        perShare: draft.perShare ?? null,
        shares: draft.shares ?? null,
        nativeCurrency: draft.nativeCurrency ?? null,
        grossNative: draft.grossNative ?? null,
        taxComponents,
        rawData: null,
      })
      .onConflictDoNothing()
      .returning({ id: transactionSources.id });

    if (row) writtenIds.push(row.id);
  }

  // Recompute the rollup from ALL source rows for this transaction (derived, not stateful).
  // Reading all rows (not just incoming) makes this idempotent and order-independent:
  // - Split-order leg2 enriched in a separate call: reads leg1 row already in the DB → sums.
  // - Re-import of lower-rank CSV after PDF: reads PDF row still present → PDF wins; no downgrade.
  // - Re-enrichment with same PDF: idempotent (onConflictDoNothing above → same rows → same rollup).
  const [txRow] = await dbClient
    .select({ id: transactions.id, type: transactions.type })
    .from(transactions)
    .where(eq(transactions.id, transactionId));
  if (!txRow) return writtenIds; // tx deleted during enrichment — skip

  const allSourceRows = await dbClient
    .select({
      sourceType: transactionSources.sourceType,
      tax: transactionSources.tax,
      fees: transactionSources.fees,
      executedPrice: transactionSources.executedPrice,
      fxRate: transactionSources.fxRate,
      venue: transactionSources.venue,
      perShare: transactionSources.perShare,
      shares: transactionSources.shares,
      nativeCurrency: transactionSources.nativeCurrency,
      grossNative: transactionSources.grossNative,
      taxComponents: transactionSources.taxComponents,
    })
    .from(transactionSources)
    .where(eq(transactionSources.transactionId, transactionId));

  const rollupRows: SourceRow[] = allSourceRows.map((r) => ({
    sourceType: r.sourceType,
    tax: r.tax,
    fees: r.fees,
    executedPrice: r.executedPrice,
    fxRate: r.fxRate,
    venue: r.venue,
    perShare: r.perShare,
    shares: r.shares,
    nativeCurrency: r.nativeCurrency,
    grossNative: r.grossNative,
    taxComponents: r.taxComponents as TaxComponents | null,
  }));

  const rollup = recomputeRollup(rollupRows);

  if (!rollup.hasManual) {
    // Only update non-null fields from the rollup to avoid clobbering existing data
    // with null when a source doesn't provide that field.
    const patch: Partial<typeof transactions.$inferInsert> = {};
    if (rollup.tax !== null) patch.tax = rollup.tax;
    if (rollup.fees !== null) patch.fees = rollup.fees;
    if (rollup.executedPrice !== null) {
      patch.executedPrice = rollup.executedPrice;
      // Keep `price` paired with `executedPrice` for sells — cashFlow reads `price` directly
      // (packages/core/src/cash.ts), and a sell's cash-relevant price is authoritative from the
      // execution fill (mirrors the mapper.ts fix; see tr_cash.md for the bug this prevents: a
      // later tax correction silently inflating/deflating cash if price is left stale). Buys and
      // savings-plan executions use a different, fee-net price semantic that doesn't equal
      // executedPrice, so leave those untouched.
      if (txRow.type === "sell") {
        patch.price = rollup.executedPrice;
      }
    }
    if (rollup.fxRate !== null) patch.fxRate = rollup.fxRate;
    if (rollup.venue !== null) patch.venue = rollup.venue;
    if (rollup.perShare !== null) patch.perShare = rollup.perShare;
    if (rollup.shares !== null) patch.shares = rollup.shares;
    if (rollup.nativeCurrency !== null) patch.nativeCurrency = rollup.nativeCurrency;
    if (rollup.grossNative !== null) patch.grossNative = rollup.grossNative;

    if (Object.keys(patch).length > 0) {
      await dbClient.update(transactions).set(patch).where(eq(transactions.id, transactionId));
    }
  }

  return writtenIds;
}

// ---------------------------------------------------------------------------
// Auto TR enrichment from stored documents
// ---------------------------------------------------------------------------

/**
 * For each transaction in `txIds`, read its `documentRefs`, filter to settlement
 * confirmation PDFs (via `detectTrPdf`), fetch the stored bytes, parse with
 * `parseTrPdf`, and fold the detail in via `enrichTransactionFromDrafts`.
 *
 * Called at confirm time right after `linkTrReceiptsToTransactions`.
 * Best-effort: errors are logged and swallowed so enrichment failure never blocks confirm.
 *
 * `postboxType` is used as a cheap pre-filter (known settlement types) but
 * `detectTrPdf` performs the authoritative structure check.
 */
export async function enrichTransactionsFromStoredDocuments(
  app: AppWithStorage,
  txIds: string[],
): Promise<void> {
  if (txIds.length === 0) return;

  // Fetch the transactions with their documentRefs.
  const txRows = await db(app)
    .select({
      id: transactions.id,
      documentRefs: transactions.documentRefs,
      source: transactions.source,
    })
    .from(transactions)
    .where(inArray(transactions.id, txIds));

  // Batch-fetch every linked document for these transactions in one query (vs. one query
  // per transaction), grouped by transactionId. Match both "staged" (at confirm time, before
  // finalizeReceipts) and "retained" (backfill over already-confirmed transactions) so
  // enrichment works in both paths.
  const enrichTxIds = txRows
    .filter((tx) => ((tx.documentRefs as unknown[] | null) ?? []).length > 0)
    .map((tx) => tx.id);
  const docsByTxId = new Map<
    string,
    { id: string; storageKey: string; sourceEventId: string | null }[]
  >();
  if (enrichTxIds.length > 0) {
    const allDocRows = await db(app)
      .select({
        transactionId: documents.transactionId,
        id: documents.id,
        storageKey: documents.storageKey,
        sourceEventId: documents.sourceEventId,
      })
      .from(documents)
      .where(
        and(
          inArray(documents.transactionId, enrichTxIds),
          inArray(documents.status, ["staged", "retained"]),
        ),
      );
    for (const d of allDocRows) {
      if (!d.transactionId) continue;
      const entry = { id: d.id, storageKey: d.storageKey, sourceEventId: d.sourceEventId };
      const bucket = docsByTxId.get(d.transactionId);
      if (bucket) bucket.push(entry);
      else docsByTxId.set(d.transactionId, [entry]);
    }
  }

  for (const tx of txRows) {
    const refs = (tx.documentRefs as { id?: string; type?: string; date?: string }[] | null) ?? [];
    if (refs.length === 0) continue;

    // No postboxType allowlist: the TR doc `type` label is unreliable (interest docs
    // appear both as INTEREST_PAYOUT_INVOICE and empty-type; one SECURITIES_SETTLEMENT
    // type spans buy + sell), and `detectTrPdf` is the authoritative gate — it accepts
    // settlement / dividend / interest / tax-optimisation abrechnungen and rejects KID,
    // cost-info, order-confirmation and transfer-confirmation pages. So feed every linked
    // doc to detect/parse below and let it decide.
    const docRows = docsByTxId.get(tx.id) ?? [];
    if (docRows.length === 0) continue;

    const drafts: ParsedTransaction[] = [];
    const documentsByExternalId = new Map<string, string>();

    for (const doc of docRows) {
      try {
        // Fetch bytes from storage.
        const bytes = await app.storage.get(doc.storageKey);
        if (!bytes) continue;
        const text = await extractPdfText(Buffer.from(bytes));
        if (!detectTrPdf(text)) continue;

        const { drafts: parsed } = parseTrPdf(text);
        for (const d of parsed) {
          // Dividend/interest externalIds are keyed by depot+isin/account+pay-date
          // (`tr:div:...` / `tr:int:...`, tr-pdf.ts), with no per-document discriminator —
          // one activity-log event can legitimately settle across TWO distinct PDFs (e.g. a
          // split ordinary/return-of-capital distribution), and both would otherwise collide
          // on the same externalId: the second document's id would silently overwrite the
          // first in `documentsByExternalId`, and its source row would be dropped by
          // `onConflictDoNothing` on (transactionId, sourceType, externalId) below — losing
          // that document's tax/amount entirely. Suffix with the owning document's (stable)
          // id so distinct documents get distinct keys, while re-parsing the SAME document
          // still yields the SAME key (idempotent, order-independent — no reliance on the
          // order documents are fetched in). Trade executions (`tr:exec:<ausfuehrung>`) are
          // already per-fill-unique and don't need this.
          const externalId =
            d.externalId && (d.action === "dividend" || d.action === "interest")
              ? `${d.externalId}:${doc.id}`
              : d.externalId;
          const keyedDraft = externalId === d.externalId ? d : { ...d, externalId };
          drafts.push(keyedDraft);
          if (externalId) documentsByExternalId.set(externalId, doc.id);
        }
      } catch (err) {
        app.log.warn({ err, docId: doc.id, txId: tx.id }, "enrichment: failed to parse stored doc");
      }
    }

    if (drafts.length === 0) continue;

    try {
      // importSource: "pdf" — every draft here comes from re-parsing a stored settlement PDF
      // (not the original activity-log sync), regardless of whether it happens to carry tax
      // components. `draftSourceType`'s tax-components heuristic exists for its OTHER caller
      // (a direct upload, where there's no better signal); here we know the true source, so
      // pass it explicitly rather than falling through to "pytr" for tax-free documents (a
      // tax-free dividend/interest PDF would otherwise mislabel its source row "pytr" — a
      // second, confusingly-identical "Trade Republic" row instead of "PDF").
      await enrichTransactionFromDrafts(tx.id, db(app), drafts, {
        importSource: "pdf",
        documentsByExternalId,
      });
      app.log.info(
        { txId: tx.id, draftCount: drafts.length },
        "enrichment: tx enriched from stored settlement PDFs",
      );
    } catch (err) {
      app.log.warn({ err, txId: tx.id }, "enrichment: enrichTransactionFromDrafts failed (non-fatal)");
    }
  }
}

// ---------------------------------------------------------------------------
// Batch helpers for exposing sources on the transactions list
// ---------------------------------------------------------------------------

export interface SourceSummary {
  id: string;
  sourceType: string;
  externalId: string | null;
  orderRef: string | null;
  documentId: string | null;
  taxComponents: TaxComponents | null;
  createdAt: Date;
  /** Human-readable display name for the document this row resolves to (null when none is
   * retained) — the same `{date}_{portfolio}_{type}_{symbol}` name `buildDocumentName` produces
   * for the actual download, not the literal stored filename (which for TR postbox docs is an
   * opaque UUID). Falls back to the raw stored filename if synthesis fails for any reason. */
  filename: string | null;
  /** True when a document can be downloaded for this row — either its own `documentId`,
   * or (for upload imports) a retained document linked via the row's `importId`. */
  hasDocument: boolean;
}

/**
 * Fetch all source rows for the given transaction ids, keyed by transactionId.
 * Used by the transactions list endpoint to expose sources in bulk. `portfolioId` scopes the
 * display-name synthesis pass (every transaction in `txIds` must belong to this portfolio).
 *
 * `pytr` rows are pure sync-provenance markers and never resolve a document — the TR API
 * sync never reads a PDF. Every OTHER source row resolves its own `documentId` when set
 * (retained PDF imports), else the import-linked document (the CSV/legacy case, one statement
 * PDF shared across many transactions, `documents.transactionId IS NULL`). On top of the real
 * rows, every retained document actually stored for a transaction — parsed into its own `pdf`
 * row or not (a rejected compound statement, a REKLASSIFIZIERUNG, a COSTS_INFO leftover) —
 * gets a synthetic `pdf` entry so every stored PDF is independently downloadable, matching
 * `getDocumentForTransaction`'s own resolution order at actual download time.
 *
 * Every entry that resolves a document also gets its `filename` overwritten with a synthesized,
 * human-readable display name (reusing the same `storage/naming.ts` machinery the download
 * endpoint already uses), forcing "transaction" scope via each entry's own `transactionId` — so
 * the list label always matches what the file will be named on download, even for a statement
 * PDF shared across several transactions. Best-effort: falls back to the raw stored filename
 * if the naming pass fails, and never throws out of this function.
 */
export async function sourcesForTransactions(
  app: AppLike,
  txIds: string[],
  portfolioId: string,
): Promise<Map<string, SourceSummary[]>> {
  if (txIds.length === 0) return new Map();

  const rows = await db(app)
    .select({
      id: transactionSources.id,
      transactionId: transactionSources.transactionId,
      sourceType: transactionSources.sourceType,
      externalId: transactionSources.externalId,
      orderRef: transactionSources.orderRef,
      documentId: transactionSources.documentId,
      importId: transactionSources.importId,
      taxComponents: transactionSources.taxComponents,
      createdAt: transactionSources.createdAt,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  // Resolve filenames + downloadability in bulk to avoid N+1 lookups.
  const fallbackRows = rows.filter((r) => !r.documentId && r.sourceType !== "pytr");
  const docIds = [...new Set(rows.map((r) => r.documentId).filter((d): d is string => !!d))];
  const importIds = [
    ...new Set(fallbackRows.map((r) => r.importId).filter((i): i is string => !!i)),
  ];
  const claimedDocIds = new Set(docIds);

  // Collected alongside each entry that resolves a document — the display-name synthesis pass
  // (below, after both loops) forces "transaction" scope via `txId`, so the other
  // `DocumentForNaming` fields (source/importId/storedAt/transactionId) are never read; only
  // `id` + `mimeType` matter here.
  const namingRequests: { entry: SourceSummary; request: NamingRequest }[] = [];

  const docNameById = new Map<string, { originalFilename: string | null; mimeType: string }>();
  if (docIds.length > 0) {
    const docRows = await db(app)
      .select({
        id: documents.id,
        originalFilename: documents.originalFilename,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(and(inArray(documents.id, docIds), eq(documents.status, "retained")));
    for (const d of docRows) {
      docNameById.set(d.id, { originalFilename: d.originalFilename, mimeType: d.mimeType });
    }
  }

  // Import-level fallback: the CSV/legacy case, where one statement PDF is linked at
  // `documents.importId` (not pinned to any single transaction, `transactionId IS NULL`) and
  // covers many transactions from that import. Gated to `transactionId IS NULL` so it never
  // resolves a transaction-pinned document (a TR per-event receipt) belonging to some *other*
  // transaction that merely shares the same collector import (the TR backfill's "carrier
  // import" holds 1000+ per-event docs under one importId) — that cross-transaction leak is
  // what let an arbitrary sibling's PDF appear on unrelated documentId-less rows.
  const docNameByImportId = new Map<
    string,
    { id: string; originalFilename: string | null; mimeType: string }
  >();
  if (importIds.length > 0) {
    const impRows = await db(app)
      .select({
        id: documents.id,
        importId: documents.importId,
        originalFilename: documents.originalFilename,
        mimeType: documents.mimeType,
      })
      .from(documents)
      .where(
        and(
          inArray(documents.importId, importIds),
          eq(documents.status, "retained"),
          isNull(documents.transactionId),
        ),
      );
    for (const d of impRows) {
      if (d.importId && !docNameByImportId.has(d.importId)) {
        docNameByImportId.set(d.importId, {
          id: d.id,
          originalFilename: d.originalFilename,
          mimeType: d.mimeType,
        });
      }
    }
  }

  const out = new Map<string, SourceSummary[]>();
  for (const r of rows) {
    let filename: string | null = null;
    let hasDocument = false;
    let namingDoc: DocumentForNaming | null = null;
    if (r.sourceType === "pytr") {
      // Sync-provenance marker only — never linked to a document, even when a document
      // happens to be stored for this transaction (that document gets its own synthetic
      // `pdf` entry below).
    } else if (r.documentId && docNameById.has(r.documentId)) {
      const doc = docNameById.get(r.documentId)!;
      filename = doc.originalFilename;
      hasDocument = true;
      namingDoc = {
        id: r.documentId,
        mimeType: doc.mimeType,
        source: null,
        storedAt: r.createdAt,
        importId: null,
        transactionId: null,
      };
    } else if (r.importId && docNameByImportId.has(r.importId)) {
      const doc = docNameByImportId.get(r.importId)!;
      filename = doc.originalFilename;
      hasDocument = true;
      namingDoc = {
        id: doc.id,
        mimeType: doc.mimeType,
        source: null,
        storedAt: r.createdAt,
        importId: r.importId,
        transactionId: null,
      };
    }
    const entry: SourceSummary = {
      id: r.id,
      sourceType: r.sourceType,
      externalId: r.externalId,
      orderRef: r.orderRef,
      documentId: r.documentId,
      taxComponents: r.taxComponents as TaxComponents | null,
      createdAt: r.createdAt,
      filename,
      hasDocument,
    };
    const bucket = out.get(r.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(r.transactionId, [entry]);
    if (namingDoc) namingRequests.push({ entry, request: { doc: namingDoc, txId: r.transactionId } });
  }

  // Every retained document stored for one of these transactions gets its own downloadable
  // `pdf` entry — independent of whether it was ever successfully parsed into a source row.
  // Excludes documents already claimed by a real row's own `documentId` above.
  const unclaimedDocs = await db(app)
    .select({
      id: documents.id,
      transactionId: documents.transactionId,
      originalFilename: documents.originalFilename,
      mimeType: documents.mimeType,
      storedAt: documents.storedAt,
    })
    .from(documents)
    .where(and(inArray(documents.transactionId, txIds), eq(documents.status, "retained")));
  for (const d of unclaimedDocs) {
    if (!d.transactionId || claimedDocIds.has(d.id)) continue;
    const entry: SourceSummary = {
      id: `doc:${d.id}`,
      sourceType: "pdf",
      externalId: null,
      orderRef: null,
      documentId: d.id,
      taxComponents: null,
      createdAt: d.storedAt,
      filename: d.originalFilename,
      hasDocument: true,
    };
    const bucket = out.get(d.transactionId);
    if (bucket) bucket.push(entry);
    else out.set(d.transactionId, [entry]);
    namingRequests.push({
      entry,
      request: {
        doc: {
          id: d.id,
          mimeType: d.mimeType,
          source: null,
          storedAt: d.storedAt,
          importId: null,
          transactionId: d.transactionId,
        },
        txId: d.transactionId,
      },
    });
  }

  // Synthesize a human-readable display name for every entry that resolved a document,
  // overwriting the raw `filename` set above (which stays as the fallback on failure).
  // Best-effort: this is a read/list endpoint and must never throw.
  if (namingRequests.length > 0) {
    try {
      const meta = await gatherDocumentMetadata(
        app,
        namingRequests.map((n) => n.request),
        portfolioId,
      );
      for (const { entry, request } of namingRequests) {
        const parts = computeNamingParts(request.doc, namingContextFor(request, meta));
        entry.filename = buildDocumentName(parts);
      }
    } catch (err) {
      app.log.warn(
        { err, portfolioId },
        "sourcesForTransactions: display-name synthesis failed (non-fatal, raw filenames kept)",
      );
    }
  }

  return out;
}

/**
 * Returns the set of transaction ids whose parse confidence is below `threshold` — i.e. at
 * least one source row carries a low confidence score (a lossy LLM-vision parse). Used to flag
 * draft rows as "needs review" in the transactions table. Deterministic parsers emit
 * confidence 1 and never qualify; rows with no confidence recorded are treated as confident.
 */
export async function txIdsNeedingReview(
  app: AppLike,
  txIds: string[],
  threshold = LOW_CONFIDENCE_THRESHOLD,
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();
  const rows = await db(app)
    .select({
      transactionId: transactionSources.transactionId,
      confidence: transactionSources.confidence,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));
  return new Set(
    rows
      .filter((r) => r.confidence != null && Number(r.confidence) < threshold)
      .map((r) => r.transactionId),
  );
}

/**
 * Returns the set of transaction ids that have at least one source row with
 * non-null taxComponents — i.e. a settlement PDF was parsed for this transaction.
 */
export async function txIdsWithFullTaxDetail(
  app: AppLike,
  txIds: string[],
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();

  // Filter in JS: taxComponents IS NOT NULL (Drizzle doesn't have isNotNull for jsonb easily).
  const rows = await db(app)
    .select({
      transactionId: transactionSources.transactionId,
      taxComponents: transactionSources.taxComponents,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  return new Set(
    rows
      .filter((r) => r.taxComponents != null && Object.keys(r.taxComponents as object).length > 0)
      .map((r) => r.transactionId),
  );
}
