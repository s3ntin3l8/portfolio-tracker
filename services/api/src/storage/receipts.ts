/**
 * Central receipt-storage helper — the one code path for all import sources.
 *
 * Stage-then-finalize lifecycle:
 *   1. `storeReceipt()` — called at upload time (bytes exist here). Writes the file to
 *      the configured StorageProvider and inserts a `documents` row with status="staged".
 *      Best-effort: a storage failure is logged and suppressed so the parse succeeds.
 *   2. `finalizeReceipts()` — called at confirm time (portfolio is known here).
 *      If `retain` (portfolio.documentRetention=true): marks rows "retained" and sets the
 *      portfolio link. Otherwise: deletes storage objects and rows (privacy-by-default).
 *   3. `deleteReceiptsForImport/ForPortfolio/ForTransactions` — cleanup helpers called
 *      from every deletion path (discard, undo, tx-delete, portfolio-delete). Always
 *      best-effort on the storage side so a missing object never blocks a DB delete.
 *
 * Key convention: `receipts/{userId}/{importId}/{sanitizedFilename}`.
 * This intentionally deviates from the issue text's `{transactionId}` key — transactions
 * don't exist at upload time. importId is stable and available at stage time.
 */

import path from "node:path";
import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray } from "drizzle-orm";
import { documents, transactions } from "@portfolio/db";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { schema } from "@portfolio/db";

// ---- Key building ----------------------------------------------------------

/** Sanitise a filename: strip directory traversal, collapse spaces, limit length. */
function sanitiseFilename(name: string): string {
  const base = path.basename(name).replace(/[^\w.-]/g, "_").slice(0, 200);
  return base || "document";
}

/** Extension derived from mimeType, used when originalFilename is absent. */
function extFromMime(mimeType: string): string {
  const map: Record<string, string> = {
    "application/pdf": ".pdf",
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "text/csv": ".csv",
    "text/plain": ".txt",
  };
  return map[mimeType] ?? "";
}

export function buildReceiptKey(
  userId: string,
  importId: string,
  originalFilename?: string | null,
  mimeType?: string,
): string {
  const filename = originalFilename
    ? sanitiseFilename(originalFilename)
    : `document${mimeType ? extFromMime(mimeType) : ""}`;
  return `receipts/${userId}/${importId}/${filename}`;
}

// ---- Types -----------------------------------------------------------------

export interface StoreReceiptOptions {
  userId: string;
  importId: string;
  buf: Buffer;
  mimeType: string;
  originalFilename?: string | null;
  /** Parser/source label, e.g. "claude", "dkb", "csv", "tr-csv", "pytr". */
  source?: string | null;
  /**
   * TR postbox sync→confirm join key: the TR timeline event id whose documentRefs
   * triggered this download. Null/absent for upload-family (screenshot/DKB/CSV) docs.
   */
  sourceEventId?: string | null;
  /**
   * Override the initial status (default "staged"). Pass "retained" only when the
   * document is stored at confirm time and the portfolio already has retention on.
   */
  status?: "staged" | "retained";
}

export interface FinalizeReceiptsOptions {
  importId: string;
  portfolioId: string;
  /** If true, mark staged docs "retained"; if false, delete them. */
  retain: boolean;
}

export interface DocumentMeta {
  id: string;
  storageKey: string;
  mimeType: string;
  originalFilename: string | null;
  sizeBytes: number | null;
  storedAt: Date;
  source: string | null;
  importId: string | null;
  transactionId: string | null;
  userId: string;
}

export interface DocumentSummary {
  id: string;
  originalFilename: string | null;
  mimeType: string;
  sizeBytes: number | null;
  storedAt: Date;
}

// ---- Core helpers ----------------------------------------------------------

type AppLike = Pick<FastifyInstance, "storage" | "db" | "log">;
type AppLikeDb = Pick<FastifyInstance, "db">;

/** Drizzle db accessor (avoids repeating the cast everywhere). */
function db(app: AppLikeDb): PostgresJsDatabase<typeof schema> {
  return app.db as PostgresJsDatabase<typeof schema>;
}

/**
 * Stage a document at upload time. Best-effort: errors are logged and swallowed
 * so a storage misconfiguration never breaks the import flow.
 */
export async function storeReceipt(app: AppLike, opts: StoreReceiptOptions): Promise<void> {
  const {
    userId,
    importId,
    buf,
    mimeType,
    originalFilename,
    source,
    sourceEventId,
    status = "staged",
  } = opts;
  const key = buildReceiptKey(userId, importId, originalFilename, mimeType);
  try {
    await app.storage.put(key, buf, {
      mimeType,
      originalFilename: originalFilename ?? undefined,
    });
    await db(app).insert(documents).values({
      userId,
      importId,
      storageKey: key,
      mimeType,
      originalFilename: originalFilename ?? null,
      sizeBytes: buf.byteLength,
      status,
      source: source ?? null,
      sourceEventId: sourceEventId ?? null,
    });
    app.log.debug({ importId, key, bytes: buf.byteLength, status }, "receipt staged");
  } catch (err) {
    app.log.warn({ err, importId, key }, "storeReceipt failed (non-fatal)");
  }
}

/**
 * At confirm time: keep or delete staged documents for an import.
 * Best-effort storage deletion — a missing object is not an error.
 */
export async function finalizeReceipts(
  app: AppLike,
  opts: FinalizeReceiptsOptions,
): Promise<void> {
  const { importId, portfolioId, retain } = opts;

  const rows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));

  if (rows.length === 0) return;

  if (retain) {
    await db(app)
      .update(documents)
      .set({ status: "retained", portfolioId })
      .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));
    app.log.debug({ importId, portfolioId, count: rows.length }, "receipts retained");
  } else {
    await _deleteStorageObjects(app, rows, `finalize importId=${importId}`);
    await db(app)
      .delete(documents)
      .where(and(eq(documents.importId, importId), eq(documents.status, "staged")));
    app.log.debug({ importId, count: rows.length }, "receipts discarded (retention off)");
  }
}

/**
 * Delete all documents (staged or retained) for a given import.
 * Used by: discard, undo-import, GC sweep.
 */
export async function deleteReceiptsForImport(app: AppLike, importId: string): Promise<void> {
  const rows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.importId, importId));

  if (rows.length === 0) return;
  await _deleteStorageObjects(app, rows, `importId=${importId}`);
  await db(app).delete(documents).where(eq(documents.importId, importId));
}

/**
 * Delete all retained documents for a portfolio (pre-query before portfolio delete,
 * since DB cascade removes rows but not storage objects).
 */
export async function deleteReceiptsForPortfolio(
  app: AppLike,
  portfolioId: string,
): Promise<void> {
  const rows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(eq(documents.portfolioId, portfolioId));

  if (rows.length === 0) return;
  await _deleteStorageObjects(app, rows, `portfolioId=${portfolioId}`);
  // Rows are removed by DB cascade on portfolios delete — no explicit DB delete needed.
}

/**
 * Delete documents linked to specific transactions and clean up orphaned import docs.
 * Phase 1: delete any transaction-scoped docs (TR future — currently no rows).
 * Phase 2: for each parent import, if no transactions remain, delete import-linked docs.
 */
export async function deleteReceiptsForTransactions(
  app: AppLike,
  txIds: string[],
  /** importIds of the deleted transactions (to check for orphaned import docs). */
  importIds: string[],
): Promise<void> {
  if (txIds.length === 0) return;

  // Phase 1: transaction-scoped docs (TR future — currently no rows).
  const txRows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey })
    .from(documents)
    .where(inArray(documents.transactionId, txIds));
  if (txRows.length > 0) {
    await _deleteStorageObjects(app, txRows, `txIds`);
    await db(app).delete(documents).where(inArray(documents.transactionId, txIds));
  }

  // Phase 2: orphan-GC for import-linked docs.
  const uniqueImportIds = [...new Set(importIds.filter(Boolean))];
  for (const importId of uniqueImportIds) {
    await _maybeDeleteOrphanImportReceipts(app, importId);
  }
}

/**
 * GC: delete staged documents older than `maxAgeDays`.
 * Catches abandoned uploads (user uploaded but never confirmed or discarded).
 */
export async function gcStagedReceipts(app: AppLike, maxAgeDays = 7): Promise<number> {
  const cutoff = new Date(Date.now() - maxAgeDays * 86_400_000);

  const staleRows = await db(app)
    .select({ id: documents.id, storageKey: documents.storageKey, storedAt: documents.storedAt })
    .from(documents)
    .where(eq(documents.status, "staged"));

  const expired = staleRows.filter((r) => r.storedAt < cutoff);
  if (expired.length === 0) return 0;

  await _deleteStorageObjects(app, expired, "gc-staged");
  await db(app)
    .delete(documents)
    .where(inArray(documents.id, expired.map((r) => r.id)));
  app.log.info({ count: expired.length }, "gc: deleted expired staged receipts");
  return expired.length;
}

// ---- Signed-URL resolution for download endpoints -------------------------

/**
 * Find the retained document for a given import. Returns null if not found.
 * IDOR guard: caller must verify document.userId === request.user.id.
 */
export async function getDocumentForImport(
  app: AppLikeDb,
  importId: string,
): Promise<DocumentMeta | null> {
  const rows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "retained")))
    .limit(1);
  return (rows[0] as DocumentMeta) ?? null;
}

/**
 * Find the retained document for a transaction: first by transactionId (TR future),
 * then by the transaction's importId (DKB, screenshot, CSV).
 * IDOR guard: caller must verify document.userId === request.user.id.
 */
export async function getDocumentForTransaction(
  app: AppLikeDb,
  txId: string,
  txImportId: string | null,
): Promise<DocumentMeta | null> {
  // Phase 1: transaction-scoped doc (TR — populated by linkTrReceiptsToTransactions at confirm).
  // Order by storedAt desc so if multiple docs exist for the same transaction, the most
  // recent one is returned (e.g. a re-sync after the original was deleted and re-fetched).
  const txRows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.transactionId, txId), eq(documents.status, "retained")))
    .orderBy(desc(documents.storedAt))
    .limit(1);
  if (txRows.length > 0) return txRows[0] as DocumentMeta;

  // Phase 2: import-linked doc.
  if (!txImportId) return null;
  const impRows = await db(app)
    .select()
    .from(documents)
    .where(and(eq(documents.importId, txImportId), eq(documents.status, "retained")))
    .limit(1);
  return (impRows[0] as DocumentMeta) ?? null;
}

/**
 * Return a brief document summary for embedding in list responses.
 */
export async function getDocumentSummaryForImport(
  app: AppLikeDb,
  importId: string,
): Promise<DocumentSummary | null> {
  const rows = await db(app)
    .select({
      id: documents.id,
      originalFilename: documents.originalFilename,
      mimeType: documents.mimeType,
      sizeBytes: documents.sizeBytes,
      storedAt: documents.storedAt,
    })
    .from(documents)
    .where(and(eq(documents.importId, importId), eq(documents.status, "retained")))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Batch-check which importIds have a retained document.
 * Used to embed `hasDocument` on transaction list items for non-TR sources
 * (one doc per import). For TR transactions, use `transactionIdsWithDocuments` instead
 * because TR has many docs per collector import (one per event).
 */
export async function importIdsWithDocuments(
  app: AppLikeDb,
  importIds: string[],
): Promise<Set<string>> {
  if (importIds.length === 0) return new Set();
  const rows = await db(app)
    .select({ importId: documents.importId })
    .from(documents)
    .where(and(inArray(documents.importId, importIds), eq(documents.status, "retained")));
  return new Set(rows.map((r) => r.importId).filter((id): id is string => id !== null));
}

/**
 * Batch-check which transactionIds have a retained, transaction-linked document.
 * Use this for TR transactions (many docs per collector import → importId check is wrong).
 */
export async function transactionIdsWithDocuments(
  app: AppLikeDb,
  txIds: string[],
): Promise<Set<string>> {
  if (txIds.length === 0) return new Set();
  const rows = await db(app)
    .select({ transactionId: documents.transactionId })
    .from(documents)
    .where(and(inArray(documents.transactionId, txIds), eq(documents.status, "retained")));
  return new Set(
    rows.map((r) => r.transactionId).filter((id): id is string => id !== null),
  );
}

/**
 * Link staged TR postbox documents to their confirmed transactions.
 * Called at confirm time (after transactions are inserted) — sets `transactionId`
 * on each staged document by matching `sourceEventId` (= the TR event id = tx.externalId).
 * Best-effort: errors are logged and swallowed so a linkage failure never blocks confirm.
 *
 * Ordering with finalizeReceipts: call this BEFORE finalizeReceipts so the transactionId
 * is set before the status is flipped from "staged" to "retained" (or the row is deleted).
 */
export async function linkTrReceiptsToTransactions(
  app: AppLike,
  opts: {
    importId: string;
    links: { sourceEventId: string; transactionId: string }[];
  },
): Promise<void> {
  const { importId, links } = opts;
  if (links.length === 0) return;
  try {
    for (const { sourceEventId, transactionId } of links) {
      await db(app)
        .update(documents)
        .set({ transactionId })
        .where(
          and(
            eq(documents.importId, importId),
            eq(documents.sourceEventId, sourceEventId),
            eq(documents.status, "staged"),
          ),
        );
    }
    app.log.debug(
      { importId, linked: links.length },
      "tr receipts linked to transactions",
    );
  } catch (err) {
    app.log.warn({ err, importId }, "linkTrReceiptsToTransactions failed (non-fatal)");
  }
}

// ---- Internal helpers ------------------------------------------------------

async function _deleteStorageObjects(
  app: Pick<FastifyInstance, "storage" | "log">,
  rows: { id: string; storageKey: string }[],
  context: string,
): Promise<void> {
  await Promise.all(
    rows.map(async (row) => {
      try {
        await app.storage.delete(row.storageKey);
      } catch (err) {
        app.log.warn(
          { err, key: row.storageKey, context },
          "storage.delete failed (non-fatal)",
        );
      }
    }),
  );
}

async function _maybeDeleteOrphanImportReceipts(app: AppLike, importId: string): Promise<void> {
  // If any transactions still reference this import, the document is still in use.
  const remaining = await db(app)
    .select({ id: transactions.id })
    .from(transactions)
    .where(eq(transactions.importId, importId))
    .limit(1);

  if (remaining.length === 0) {
    await deleteReceiptsForImport(app, importId);
    app.log.debug({ importId }, "orphan import receipts cleaned up");
  }
}
