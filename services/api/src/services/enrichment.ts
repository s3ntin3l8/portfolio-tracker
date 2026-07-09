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
import { and, desc, eq, inArray } from "drizzle-orm";
import { transactionSources, transactions, documents } from "@portfolio/db";
import type { TransactionSource } from "@portfolio/db";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import { LOW_CONFIDENCE_THRESHOLD } from "@portfolio/schema";
import type { DB } from "../db/client.js";
import { recomputeRollup, type SourceRow } from "./parsers/dedup.js";
import { extractPdfText } from "./parsers/pdf-text.js";
import { detectTrPdf, parseTrPdf } from "./parsers/tr-pdf.js";

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
  const exists = await dbClient
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.id, transactionId));
  if (exists.length === 0) return writtenIds; // tx deleted during enrichment — skip

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
    if (rollup.executedPrice !== null) patch.executedPrice = rollup.executedPrice;
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
          drafts.push(d);
          if (d.externalId) documentsByExternalId.set(d.externalId, doc.id);
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
  /** Original filename of the document this row resolves to (null when none is retained). */
  filename: string | null;
  /** True when a document can be downloaded for this row — either its own `documentId`,
   * or (for upload imports) a retained document linked via the row's `importId`. */
  hasDocument: boolean;
}

/**
 * Fetch all source rows for the given transaction ids, keyed by transactionId.
 * Used by the transactions list endpoint to expose sources in bulk.
 *
 * Each row also carries `filename`/`hasDocument`, resolved in bulk to mirror
 * `getDocumentForTransaction`: a row downloads its own `documentId` when set (retained PDF
 * imports); otherwise the transaction-scoped document (correct for TR, whose collector import
 * holds many docs) — excluding any document a *sibling* row already claims via its own
 * `documentId`, so e.g. the original pytr sync row (no document of its own) doesn't show the
 * same document a later pdf-enrichment row on the same transaction links directly — then the
 * import-linked document (the common CSV case, `documentId` null).
 */
export async function sourcesForTransactions(
  app: AppLike,
  txIds: string[],
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

  // Resolve filenames + downloadability in bulk to avoid N+1 lookups. Rows without their own
  // documentId fall back to the transaction-scoped doc (txId), then the import-linked doc —
  // exactly as getDocumentForTransaction resolves at download time.
  const fallbackRows = rows.filter((r) => !r.documentId);
  const docIds = [...new Set(rows.map((r) => r.documentId).filter((d): d is string => !!d))];
  const fallbackTxIds = [...new Set(fallbackRows.map((r) => r.transactionId))];
  const importIds = [
    ...new Set(fallbackRows.map((r) => r.importId).filter((i): i is string => !!i)),
  ];

  const docNameById = new Map<string, string | null>();
  if (docIds.length > 0) {
    const docRows = await db(app)
      .select({ id: documents.id, originalFilename: documents.originalFilename })
      .from(documents)
      .where(and(inArray(documents.id, docIds), eq(documents.status, "retained")));
    for (const d of docRows) docNameById.set(d.id, d.originalFilename);
  }

  // Transaction-scoped docs (TR per-event receipts), newest first to match getDocumentForTransaction.
  // Exclude any document already claimed by some sibling row's own `documentId` (`docIds` above)
  // — otherwise a row with no document of its own (e.g. the original pytr sync row) would show
  // the SAME document a sibling row already links directly (e.g. a later pdf-enrichment row),
  // rendering as two sources both "linked" to one file. A genuinely different, unclaimed
  // transaction-scoped document (the CSV/legacy case this fallback exists for) still resolves.
  const claimedDocIds = new Set(docIds);
  const docNameByTxId = new Map<string, string | null>();
  if (fallbackTxIds.length > 0) {
    const txDocRows = await db(app)
      .select({
        transactionId: documents.transactionId,
        originalFilename: documents.originalFilename,
        id: documents.id,
      })
      .from(documents)
      .where(
        and(inArray(documents.transactionId, fallbackTxIds), eq(documents.status, "retained")),
      )
      .orderBy(desc(documents.storedAt));
    for (const d of txDocRows) {
      if (claimedDocIds.has(d.id)) continue;
      if (d.transactionId && !docNameByTxId.has(d.transactionId)) {
        docNameByTxId.set(d.transactionId, d.originalFilename);
      }
    }
  }

  const docNameByImportId = new Map<string, string | null>();
  if (importIds.length > 0) {
    const impRows = await db(app)
      .select({ importId: documents.importId, originalFilename: documents.originalFilename })
      .from(documents)
      .where(and(inArray(documents.importId, importIds), eq(documents.status, "retained")));
    for (const d of impRows) {
      if (d.importId && !docNameByImportId.has(d.importId)) {
        docNameByImportId.set(d.importId, d.originalFilename);
      }
    }
  }

  const out = new Map<string, SourceSummary[]>();
  for (const r of rows) {
    let filename: string | null = null;
    let hasDocument = false;
    if (r.documentId && docNameById.has(r.documentId)) {
      filename = docNameById.get(r.documentId) ?? null;
      hasDocument = true;
    } else if (docNameByTxId.has(r.transactionId)) {
      filename = docNameByTxId.get(r.transactionId) ?? null;
      hasDocument = true;
    } else if (r.importId && docNameByImportId.has(r.importId)) {
      filename = docNameByImportId.get(r.importId) ?? null;
      hasDocument = true;
    }
    const bucket = out.get(r.transactionId);
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
    if (bucket) bucket.push(entry);
    else out.set(r.transactionId, [entry]);
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
