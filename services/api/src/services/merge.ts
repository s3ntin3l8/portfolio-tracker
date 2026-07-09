/**
 * Merge two duplicate transactions (manual recovery when cross-source dedup misses a
 * pair — e.g. a CSV row and a PDF settlement note for the same trade that fall outside
 * `findCrossSourceDuplicates`'s day/quantity/price tolerance, see parsers/dedup.ts).
 *
 * A merge is **manual enrichment**: the user picks a survivor (its core economic fields —
 * quantity, price, executedAt, type, instrument, kind — win), the absorbed row's
 * `transaction_sources` + `documents` are re-parented onto the survivor, the scalar rollup
 * (tax/fees/executedPrice/fxRate/venue) is recomputed by source rank via `recomputeRollup`,
 * and the absorbed row is deleted.
 *
 * Two correctness invariants drive the shape of this file:
 *
 *  1. `recomputeRollup` only reads `transaction_sources` rows — never the transaction's own
 *     scalar columns. Manual entries and legacy rows can have **zero** source rows (the plain
 *     `POST /transactions` endpoint never writes one). Merging two such rows without first
 *     synthesizing a source row for each would silently drop one side's hand-set values (e.g.
 *     a manual `fees` edit) the moment the other side's rows are read back — and `hasManual`
 *     protection would never fire because no `manual` source row exists to trigger it. So
 *     `ensureSourceRow` runs on BOTH transactions before anything is re-parented.
 *
 *  2. Both `transaction_sources.transactionId` and `documents.transactionId` are
 *     `onDelete: cascade`. Re-parenting must happen BEFORE the absorbed row is deleted, or the
 *     cascade wipes exactly the rows being preserved. The re-parent UPDATE can also collide
 *     with `transaction_sources_dedup_idx (transactionId, sourceType, externalId)` when the
 *     survivor already holds an equivalent source; those rows are dropped (not re-parented)
 *     instead of letting the UPDATE throw.
 */
import { and, eq, inArray } from "drizzle-orm";
import { transactions, transactionSources, documents, trResolvedEvents } from "@portfolio/db";
import type { DB } from "../db/client.js";
import { actionClass, recomputeRollup, type SourceRow } from "./parsers/dedup.js";

export type MergeBlockReason =
  | "not_found"
  | "same_transaction"
  | "different_instrument"
  | "incompatible_type"
  | "loan_linked";

export class MergeBlockedError extends Error {
  constructor(public readonly reason: MergeBlockReason) {
    super(`cannot_merge_${reason}`);
  }
}

type TxRow = typeof transactions.$inferSelect;

export interface MergePreview {
  ok: boolean;
  blockedReason?: MergeBlockReason;
  merged?: {
    quantity: string;
    price: string;
    executedAt: string;
    type: string;
    currency: string;
    tax: string | null;
    fees: string | null;
    executedPrice: string | null;
    fxRate: string | null;
    venue: string | null;
    perShare: string | null;
    shares: string | null;
    nativeCurrency: string | null;
    grossNative: string | null;
    documentCount: number;
  };
}

export interface MergeResult {
  survivorId: string;
  recompute: Array<{ portfolioId: string; day: string }>;
}

async function loadRow(db: DB, portfolioId: string, id: string): Promise<TxRow | null> {
  const [row] = await db
    .select()
    .from(transactions)
    .where(and(eq(transactions.portfolioId, portfolioId), eq(transactions.id, id)));
  return row ?? null;
}

/** Same rules as `reassign.ts`'s financed-gold-leg skip: same portfolio (caller loads both
 *  rows scoped to one portfolioId already), same instrument, and a compatible action class
 *  (buy ≡ savings_plan ≡ bonus, per `actionClass`) — never merge a buy with its own opposite
 *  (sell) or an unrelated action (dividend, fee, transfer). */
function assertMergeable(survivor: TxRow, absorbed: TxRow): void {
  if (survivor.id === absorbed.id) throw new MergeBlockedError("same_transaction");
  if (survivor.instrumentId !== absorbed.instrumentId) {
    throw new MergeBlockedError("different_instrument");
  }
  if (actionClass(survivor.type) !== actionClass(absorbed.type)) {
    throw new MergeBlockedError("incompatible_type");
  }
  if (survivor.loanId || absorbed.loanId) {
    throw new MergeBlockedError("loan_linked");
  }
}

/** A transaction's own scalar columns, reduced to a `SourceRow` — the row `recomputeRollup`
 *  would see if this transaction were its own (only) source. Used both to synthesize a real
 *  `transaction_sources` row (write path) and to simulate one for the read-only preview. */
function ownScalarsAsSourceRow(row: TxRow): SourceRow {
  return {
    sourceType: row.source,
    tax: row.tax,
    fees: row.fees,
    executedPrice: row.executedPrice,
    fxRate: row.fxRate,
    venue: row.venue,
    perShare: row.perShare,
    shares: row.shares,
    nativeCurrency: row.nativeCurrency,
    grossNative: row.grossNative,
    taxComponents: null,
  };
}

/** Ensure `row` has at least one `transaction_sources` entry before any rollup recompute —
 *  see file-level invariant #1. No-op when a source row already exists. */
async function ensureSourceRow(db: DB, row: TxRow): Promise<void> {
  const existing = await db
    .select({ id: transactionSources.id })
    .from(transactionSources)
    .where(eq(transactionSources.transactionId, row.id))
    .limit(1);
  if (existing.length > 0) return;

  await db
    .insert(transactionSources)
    .values({
      transactionId: row.id,
      sourceType: row.source,
      importId: row.importId ?? null,
      documentId: null,
      externalId: row.externalId ?? null,
      orderRef: null,
      tax: row.tax,
      fees: row.fees,
      executedPrice: row.executedPrice,
      fxRate: row.fxRate,
      venue: row.venue,
      perShare: row.perShare,
      shares: row.shares,
      nativeCurrency: row.nativeCurrency,
      grossNative: row.grossNative,
      taxComponents: null,
      confidence: null,
      rawData: null,
    })
    .onConflictDoNothing();
}

/**
 * Merge `absorbedId` into `survivorId` within `portfolioId`. All-or-nothing (wrapped in a DB
 * transaction). Throws `MergeBlockedError` for any guardrail failure — callers map its
 * `reason` to an HTTP 400 (or 404 for `not_found`).
 */
export async function mergeTransactions(
  db: DB,
  args: { portfolioId: string; survivorId: string; absorbedId: string },
): Promise<MergeResult> {
  const { portfolioId, survivorId, absorbedId } = args;

  return db.transaction(async (tx) => {
    const survivor = await loadRow(tx, portfolioId, survivorId);
    const absorbed = await loadRow(tx, portfolioId, absorbedId);
    if (!survivor || !absorbed) throw new MergeBlockedError("not_found");
    assertMergeable(survivor, absorbed);

    // Invariant #1: guarantee both sides are represented by a source row before anything
    // is re-parented or recomputed.
    await ensureSourceRow(tx, survivor);
    await ensureSourceRow(tx, absorbed);

    // Invariant #2: re-parent BEFORE deleting (both FKs cascade on delete).
    // Drop (rather than re-parent) any absorbed source row that would collide with an
    // identical (sourceType, externalId) already on the survivor.
    const survivorSources = await tx
      .select({ sourceType: transactionSources.sourceType, externalId: transactionSources.externalId })
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, survivorId));
    const survivorKeys = new Set(
      survivorSources.filter((r) => r.externalId != null).map((r) => `${r.sourceType}|${r.externalId}`),
    );
    const absorbedSources = await tx
      .select({ id: transactionSources.id, sourceType: transactionSources.sourceType, externalId: transactionSources.externalId })
      .from(transactionSources)
      .where(eq(transactionSources.transactionId, absorbedId));

    const colliding = absorbedSources.filter(
      (r) => r.externalId != null && survivorKeys.has(`${r.sourceType}|${r.externalId}`),
    );
    const reparentable = absorbedSources.filter((r) => !colliding.includes(r));

    if (colliding.length > 0) {
      await tx.delete(transactionSources).where(
        inArray(transactionSources.id, colliding.map((r) => r.id)),
      );
    }
    if (reparentable.length > 0) {
      await tx
        .update(transactionSources)
        .set({ transactionId: survivorId })
        .where(inArray(transactionSources.id, reparentable.map((r) => r.id)));
    }

    // Re-parent documents (settlement PDFs etc.) attached directly to the absorbed row.
    await tx
      .update(documents)
      .set({ transactionId: survivorId })
      .where(eq(documents.transactionId, absorbedId));

    // Union `documentRefs` (TR postbox references) onto the survivor.
    const survivorRefs = ((survivor.documentRefs as { id?: string }[] | null) ?? []).slice();
    const absorbedRefs = (absorbed.documentRefs as { id?: string }[] | null) ?? [];
    const seenRefIds = new Set(survivorRefs.map((r) => r.id).filter(Boolean));
    for (const ref of absorbedRefs) {
      if (ref.id && seenRefIds.has(ref.id)) continue;
      survivorRefs.push(ref);
      if (ref.id) seenRefIds.add(ref.id);
    }

    // Recompute the rollup from ALL of the survivor's source rows now that absorbed's have
    // been folded in (mirrors enrichTransactionFromDrafts's read-all-then-patch sequence).
    const allSourceRows = await tx
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
      .where(eq(transactionSources.transactionId, survivorId));
    const rollup = recomputeRollup(allSourceRows as SourceRow[]);

    const patch: Partial<TxRow> = {
      documentRefs: survivorRefs.length > 0 ? survivorRefs : null,
    };
    if (!rollup.hasManual) {
      if (rollup.tax !== null) patch.tax = rollup.tax;
      if (rollup.fees !== null) patch.fees = rollup.fees;
      if (rollup.executedPrice !== null) patch.executedPrice = rollup.executedPrice;
      if (rollup.fxRate !== null) patch.fxRate = rollup.fxRate;
      if (rollup.venue !== null) patch.venue = rollup.venue;
      if (rollup.perShare !== null) patch.perShare = rollup.perShare;
      if (rollup.shares !== null) patch.shares = rollup.shares;
      if (rollup.nativeCurrency !== null) patch.nativeCurrency = rollup.nativeCurrency;
      if (rollup.grossNative !== null) patch.grossNative = rollup.grossNative;
    }
    await tx.update(transactions).set(patch).where(eq(transactions.id, survivorId));

    // Tombstone the absorbed row if it's sync-sourced, so a later pytr/ibkr sync can't
    // re-create it — the event is accounted for by the survivor now (mirrors resolve-drafts).
    if ((absorbed.source === "pytr" || absorbed.source === "ibkr") && absorbed.externalId) {
      await tx
        .insert(trResolvedEvents)
        .values({
          portfolioId,
          source: absorbed.source,
          eventId: absorbed.externalId,
          resolution: "confirmed",
        })
        .onConflictDoNothing();
    }

    await tx.delete(transactions).where(eq(transactions.id, absorbedId));

    const days = new Set([
      survivor.executedAt.toISOString().slice(0, 10),
      absorbed.executedAt.toISOString().slice(0, 10),
    ]);
    return {
      survivorId,
      recompute: [...days].map((day) => ({ portfolioId, day })),
    };
  });
}

/**
 * Read-only simulation of a merge — validates the guardrails and computes what the merged
 * result would look like, without writing anything. Powers the merge dialog's live preview.
 */
export async function previewMerge(
  db: DB,
  args: { portfolioId: string; survivorId: string; absorbedId: string },
): Promise<MergePreview> {
  const { portfolioId, survivorId, absorbedId } = args;
  const survivor = await loadRow(db, portfolioId, survivorId);
  const absorbed = await loadRow(db, portfolioId, absorbedId);
  if (!survivor || !absorbed) return { ok: false, blockedReason: "not_found" };

  try {
    assertMergeable(survivor, absorbed);
  } catch (err) {
    if (err instanceof MergeBlockedError) return { ok: false, blockedReason: err.reason };
    throw err;
  }

  const [survivorSources, absorbedSources, docCount] = await Promise.all([
    db
      .select({
        sourceType: transactionSources.sourceType,
        externalId: transactionSources.externalId,
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
      .where(eq(transactionSources.transactionId, survivorId)),
    db
      .select({
        sourceType: transactionSources.sourceType,
        externalId: transactionSources.externalId,
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
      .where(eq(transactionSources.transactionId, absorbedId)),
    db
      .select({ id: documents.id })
      .from(documents)
      .where(inArray(documents.transactionId, [survivorId, absorbedId])),
  ]);

  const survivorRows: SourceRow[] =
    survivorSources.length > 0 ? (survivorSources as SourceRow[]) : [ownScalarsAsSourceRow(survivor)];
  const absorbedRowsRaw: SourceRow[] =
    absorbedSources.length > 0 ? (absorbedSources as SourceRow[]) : [ownScalarsAsSourceRow(absorbed)];

  // Simulate the collision-drop from the real write path: an absorbed row whose
  // (sourceType, externalId) already exists on the survivor contributes nothing new.
  const survivorKeys = new Set(
    survivorRows.filter((r) => (r as { externalId?: string }).externalId != null).map(
      (r) => `${r.sourceType}|${(r as { externalId?: string }).externalId}`,
    ),
  );
  const absorbedRows = absorbedRowsRaw.filter((r) => {
    const key = (r as { externalId?: string }).externalId;
    return !(key != null && survivorKeys.has(`${r.sourceType}|${key}`));
  });

  const rollup = recomputeRollup([...survivorRows, ...absorbedRows]);

  return {
    ok: true,
    merged: {
      quantity: survivor.quantity,
      price: survivor.price,
      executedAt: survivor.executedAt.toISOString(),
      type: survivor.type,
      currency: survivor.currency,
      tax: rollup.hasManual ? survivor.tax : rollup.tax,
      fees: rollup.hasManual ? survivor.fees : rollup.fees,
      executedPrice: rollup.hasManual ? survivor.executedPrice : rollup.executedPrice,
      fxRate: rollup.hasManual ? survivor.fxRate : rollup.fxRate,
      venue: rollup.hasManual ? survivor.venue : rollup.venue,
      perShare: rollup.hasManual ? survivor.perShare : rollup.perShare,
      shares: rollup.hasManual ? survivor.shares : rollup.shares,
      nativeCurrency: rollup.hasManual ? survivor.nativeCurrency : rollup.nativeCurrency,
      grossNative: rollup.hasManual ? survivor.grossNative : rollup.grossNative,
      documentCount: docCount.length,
    },
  };
}
