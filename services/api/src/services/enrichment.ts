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
import { and, eq, inArray } from "drizzle-orm";
import { transactionSources, transactions, documents } from "@portfolio/db";
import type { TransactionSource } from "@portfolio/db";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
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

  // Known settlement postboxTypes (cheap pre-filter — the structure check is authoritative).
  const SETTLEMENT_TYPES = new Set([
    "SECURITIES_SETTLEMENT",
    "SECURITIES_SETTLEMENT_SAVINGS_PLAN",
    "SECURITIES_SETTLEMENT_SAVEBACK",
    "SECURITIES_SETTLEMENT_ROUND_UP",
  ]);

  // Fetch the transactions with their documentRefs.
  const txRows = await db(app)
    .select({
      id: transactions.id,
      documentRefs: transactions.documentRefs,
      source: transactions.source,
    })
    .from(transactions)
    .where(inArray(transactions.id, txIds));

  for (const tx of txRows) {
    const refs = (tx.documentRefs as { id?: string; type?: string; date?: string }[] | null) ?? [];
    if (refs.length === 0) continue;

    // Pre-filter by postboxType.
    const candidateRefs = refs.filter((r) => !r.type || SETTLEMENT_TYPES.has(r.type));
    if (candidateRefs.length === 0) continue;

    // Fetch the documents linked to this transaction.
    // Match both "staged" (at confirm time, before finalizeReceipts) and "retained"
    // (backfill over already-confirmed transactions) so enrichment works in both paths.
    const docRows = await db(app)
      .select({
        id: documents.id,
        storageKey: documents.storageKey,
        sourceEventId: documents.sourceEventId,
      })
      .from(documents)
      .where(
        and(
          eq(documents.transactionId, tx.id),
          inArray(documents.status, ["staged", "retained"]),
        ),
      );

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
      await enrichTransactionFromDrafts(tx.id, db(app), drafts, {
        importSource: "pytr",
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
}

/**
 * Fetch all source rows for the given transaction ids, keyed by transactionId.
 * Used by the transactions list endpoint to expose sources in bulk.
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
      taxComponents: transactionSources.taxComponents,
      createdAt: transactionSources.createdAt,
    })
    .from(transactionSources)
    .where(inArray(transactionSources.transactionId, txIds));

  const out = new Map<string, SourceSummary[]>();
  for (const r of rows) {
    const bucket = out.get(r.transactionId);
    const entry: SourceSummary = {
      id: r.id,
      sourceType: r.sourceType,
      externalId: r.externalId,
      orderRef: r.orderRef,
      documentId: r.documentId,
      taxComponents: r.taxComponents as TaxComponents | null,
      createdAt: r.createdAt,
    };
    if (bucket) bucket.push(entry);
    else out.set(r.transactionId, [entry]);
  }
  return out;
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
