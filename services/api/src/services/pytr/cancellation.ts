import { and, eq, inArray } from "drizzle-orm";
import type { FastifyBaseLogger } from "fastify";
import { transactions, trResolvedEvents } from "@portfolio/db";
import type { DB } from "../../db/client.js";
import type { StorageProvider } from "../../storage/types.js";
import { deleteReceiptsForTransactions } from "../../storage/receipts.js";
import { RECLASSIFICATION_ORIGINAL_SUFFIX } from "./mapper.js";

// A cancelled event keeps its id but flips status — these are removed, not re-imported.
export function isCancelled(status: unknown): boolean {
  const s = typeof status === "string" ? status.toUpperCase() : "";
  return s === "CANCELED" || s === "CANCELLED";
}

/**
 * Un-import any confirmed transactions whose source event is now cancelled, and forget them
 * in the resolved-events ledger so a later re-execution can re-stage. Returns the number of
 * transactions removed. Best-effort throughout: a storage error cleaning up linked documents
 * is logged but never aborts the sync (which would also skip reconciliation + the session roll).
 */
export async function applyCancellations(opts: {
  db: DB;
  portfolioId: string;
  cancelledIds: Set<string>;
  connectionId: string;
  storage?: StorageProvider;
  log?: FastifyBaseLogger;
}): Promise<number> {
  const { db, portfolioId, cancelledIds, connectionId, storage, log } = opts;
  if (!cancelledIds.size) return 0;

  // A cancelled raw event may have been booked as a single row (externalId = the raw id,
  // the common case) OR — for a "Dividend correction" event that was split — as TWO rows,
  // the correction leg (externalId = the raw id) and a backdated original-portion leg
  // (externalId = `${rawId}:original`, see buildReclassificationSplit in mapper.ts). Match
  // both forms so a cancellation removes the whole split pair, not just the correction leg.
  const externalIdCandidates = [...cancelledIds].flatMap((id) => [
    id,
    `${id}${RECLASSIFICATION_ORIGINAL_SUFFIX}`,
  ]);
  const removed = await db
    .delete(transactions)
    .where(
      and(
        eq(transactions.portfolioId, portfolioId),
        eq(transactions.source, "pytr"),
        inArray(transactions.externalId, externalIdCandidates),
      ),
    )
    .returning({ id: transactions.id, importId: transactions.importId });
  const cancelled = removed.length;

  // Clean up any linked documents (#231). Best-effort — no-op in phase 1 since
  // TR per-tx docs aren't stored yet; forward-compatible for phase 2.
  if (storage && removed.length > 0) {
    const storageApp = { storage, db, log: log ?? console } as Parameters<typeof deleteReceiptsForTransactions>[0];
    try {
      await deleteReceiptsForTransactions(
        storageApp,
        removed.map((r) => r.id),
        removed.map((r) => r.importId).filter((x): x is string => x !== null),
      );
    } catch (err) {
      log?.error(
        { connectionId, err, txIds: removed.map((r) => r.id) },
        "tr cancelled-document cleanup failed (non-fatal)",
      );
    }
  }

  await db
    .delete(trResolvedEvents)
    .where(
      and(
        eq(trResolvedEvents.portfolioId, portfolioId),
        eq(trResolvedEvents.source, "pytr"),
        inArray(trResolvedEvents.eventId, [...cancelledIds]),
      ),
    );
  if (cancelled > 0) {
    log?.info({ connectionId, cancelled }, "tr cancelled events removed");
  }
  return cancelled;
}
