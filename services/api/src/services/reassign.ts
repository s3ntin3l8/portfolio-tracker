/**
 * Move transactions from one portfolio to another (issue: reassign imported transactions).
 *
 * Used by the per-transaction "Reassign…" action and the import-level "Reassign all to…"
 * action. A move is a plain `portfolioId` update, but two cases need care:
 *
 *  - **Dedup-index conflict.** The unique index `(portfolioId, source, externalId)` means a
 *    row whose economic identity already exists in the target would violate it. Those rows
 *    are pre-checked and **skipped** (reported as `skippedConflicts`), never crashed on.
 *  - **Financed-gold legs.** A `loanId`-linked leg can't be split from its loan (the loan
 *    stays in the source portfolio), so such rows are skipped (`skippedLoans`).
 *
 * Returns the rows actually moved plus the `(portfolioId, day)` pairs the caller must
 * recompute — BOTH the source and the target change on each affected day.
 */
import { and, eq, inArray } from "drizzle-orm";
import { transactions } from "@portfolio/db";
import type { DB } from "../db/client.js";

export interface ReassignResult {
  moved: number;
  skippedConflicts: number;
  skippedLoans: number;
  /** Distinct (portfolioId, day) pairs to recompute — source + target, per affected day. */
  recompute: Array<{ portfolioId: string; day: string }>;
}

/**
 * Move the selected rows of `fromPortfolioId` (or all rows of `importId`) into
 * `toPortfolioId`. Caller is responsible for ownership checks of both portfolios and for
 * enqueuing the returned recompute pairs.
 */
export async function reassignTransactions(
  db: DB,
  args:
    | { rowIds: string[]; fromPortfolioId: string; toPortfolioId: string }
    | { importId: string; toPortfolioId: string },
): Promise<ReassignResult> {
  const { toPortfolioId } = args;

  // The candidate rows + the portfolio they currently live in.
  const where =
    "importId" in args
      ? eq(transactions.importId, args.importId)
      : and(
          eq(transactions.portfolioId, args.fromPortfolioId),
          inArray(transactions.id, args.rowIds),
        );
  const rows = await db
    .select({
      id: transactions.id,
      portfolioId: transactions.portfolioId,
      source: transactions.source,
      externalId: transactions.externalId,
      executedAt: transactions.executedAt,
      loanId: transactions.loanId,
    })
    .from(transactions)
    .where(where);

  // Never move a row that's already in the target, and never split a financed-gold leg.
  const candidates = rows.filter((r) => r.portfolioId !== toPortfolioId);
  const movable = candidates.filter((r) => !r.loanId);
  const skippedLoans = candidates.length - movable.length;

  // Pre-check the dedup index: an existing (source, externalId) in the target blocks the move.
  const targetExisting = await db
    .select({ source: transactions.source, externalId: transactions.externalId })
    .from(transactions)
    .where(eq(transactions.portfolioId, toPortfolioId));
  const targetKeys = new Set(
    targetExisting.filter((r) => r.externalId).map((r) => `${r.source}|${r.externalId}`),
  );
  const toMove = movable.filter(
    (r) => !(r.externalId && targetKeys.has(`${r.source}|${r.externalId}`)),
  );
  const skippedConflicts = movable.length - toMove.length;

  if (toMove.length > 0) {
    await db
      .update(transactions)
      .set({ portfolioId: toPortfolioId })
      .where(
        inArray(
          transactions.id,
          toMove.map((r) => r.id),
        ),
      );
  }

  // Both the source and the target change on each affected day.
  const pairs = new Map<string, { portfolioId: string; day: string }>();
  for (const r of toMove) {
    const day = r.executedAt.toISOString().slice(0, 10);
    for (const pid of [r.portfolioId, toPortfolioId]) {
      pairs.set(`${pid}|${day}`, { portfolioId: pid, day });
    }
  }

  return {
    moved: toMove.length,
    skippedConflicts,
    skippedLoans,
    recompute: [...pairs.values()],
  };
}
