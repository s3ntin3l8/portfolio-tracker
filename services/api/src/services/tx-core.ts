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
    source: r.source,
    vorabBase: r.vorabBase,
  };
}

/**
 * Map DB transaction rows to {@link CoreTransaction}, **excluding archived and draft rows
 * by default** — both are ignored in every derivation (cash, holdings, P&L, trades,
 * contributions, net worth, income, tax). This is the single chokepoint every derivation
 * path loads through, so such a row never reaches the engine.
 *
 * `draft` rows are unconfirmed imports/sync rows; they are **always** excluded (even with
 * `includeArchived`) — an unconfirmed row must never feed a derivation until the user
 * confirms it (→ "normal"). `includeArchived` only re-includes archived rows, and is used
 * by the raw transactions list (the UI shows + un-archives them).
 */
export function toCoreTxns(rows: TxRow[], opts?: { includeArchived?: boolean }): CoreTransaction[] {
  const src = rows.filter(
    (r) => r.status !== "draft" && (opts?.includeArchived || r.status !== "archived"),
  );
  return src.map(txRowToCore);
}
