import type { transactions } from "@portfolio/db";
import type { CoreTransaction } from "@portfolio/core";

type TxRow = typeof transactions.$inferSelect;

/** Map a DB transaction row to the engine's {@link CoreTransaction} shape. */
export function txRowToCore(r: TxRow): CoreTransaction {
  return {
    id: r.id,
    instrumentId: r.instrumentId,
    type: r.type,
    quantity: r.quantity,
    price: r.price,
    fees: r.fees,
    currency: r.currency,
    executedAt: r.executedAt,
    loanId: r.loanId,
    kind: r.kind,
    tax: r.tax,
    savingsPlanId: r.savingsPlanId,
    status: r.status,
  };
}

/**
 * Map DB transaction rows to {@link CoreTransaction}, **excluding archived rows by
 * default** — archived transactions are ignored in every derivation (cash, holdings,
 * P&L, trades, contributions, net worth, income, tax). This is the single chokepoint
 * every derivation path loads through, so an archived row never reaches the engine.
 * Pass `includeArchived` for the raw transactions list (the UI shows + un-archives them).
 */
export function toCoreTxns(
  rows: TxRow[],
  opts?: { includeArchived?: boolean },
): CoreTransaction[] {
  const src = opts?.includeArchived ? rows : rows.filter((r) => r.status !== "archived");
  return src.map(txRowToCore);
}
