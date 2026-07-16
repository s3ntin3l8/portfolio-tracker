/**
 * Open FIFO lots — the standing per-instrument acquisition ledger, exposed for
 * display (e.g. an instrument detail page's "Acquired / Qty / Price / Cost" table).
 *
 * This mirrors the FIFO lot bookkeeping that already lives inside
 * `computeTrades` (trade-log.ts): buy/savings_plan/transfer_in/bonus push a new
 * lot at fees-inclusive unit cost; sell consumes the oldest lot(s) first;
 * transfer_out drains lots FIFO with no realized P&L; split/bonus corporate
 * actions scale every open lot's qty/unitCost in place (total cost invariant).
 * Unlike `computeTrades`, this pass carries no P&L/episode bookkeeping — it
 * only needs the standing lots per instrument at the end of the replay.
 */
import { Decimal } from "decimal.js";
import { D } from "./decimal.js";
import { isAcquisitionType } from "./categorization.js";
import { toDateKey } from "./date-utils.js";
import type { CoreTransaction, CorporateAction } from "./types.js";

/** A FIFO lot: shares acquired together at a per-unit cost (fees included). */
interface Lot {
  acqDate: Date;
  qty: Decimal;
  unitCost: Decimal;
}

/** A standing open lot, formatted for display (decimals stringified). */
export interface LotView {
  acqDate: string; // ISO date (YYYY-MM-DD)
  qty: string;
  unitCost: string;
  cost: string; // qty * unitCost
}

type Event =
  { kind: "tx"; at: Date; tx: CoreTransaction } | { kind: "ca"; at: Date; ca: CorporateAction };

/**
 * Compute standing open FIFO lots per instrument. Pass `asOf` to replay only
 * transactions up to (and including) that date; corporate actions are always
 * applied (matching `computeHoldings`'s convention) so quantities stay in
 * current-share terms.
 */
export function openLots(
  transactions: CoreTransaction[],
  corporateActions: CorporateAction[] = [],
  asOf?: Date,
): Map<string, LotView[]> {
  const byInstrument = new Map<string, Event[]>();

  for (const tx of transactions) {
    if (!tx.instrumentId) continue;
    if (tx.status === "archived" || tx.status === "draft") continue;
    if (asOf !== undefined && tx.executedAt > asOf) continue;
    const list = byInstrument.get(tx.instrumentId) ?? [];
    list.push({ kind: "tx", at: tx.executedAt, tx });
    byInstrument.set(tx.instrumentId, list);
  }
  for (const ca of corporateActions) {
    const list = byInstrument.get(ca.instrumentId) ?? [];
    list.push({ kind: "ca", at: ca.exDate, ca });
    byInstrument.set(ca.instrumentId, list);
  }

  const result = new Map<string, LotView[]>();

  for (const [instrumentId, events] of byInstrument) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    const lots: Lot[] = [];

    for (const ev of events) {
      if (ev.kind === "ca") {
        const ratio = D(ev.ca.ratio);
        const factor =
          ev.ca.type === "split" ? ratio : ev.ca.type === "bonus" ? D(1).add(ratio) : null; // rights: no-op
        if (factor) {
          for (const l of lots) {
            l.qty = l.qty.mul(factor);
            l.unitCost = l.unitCost.div(factor);
          }
        }
        continue;
      }

      const tx = ev.tx;
      const q = D(tx.quantity);
      const p = D(tx.price);
      const f = D(tx.fees);

      if (isAcquisitionType(tx.type) || tx.type === "transfer_in" || tx.type === "bonus") {
        if (q.lte(0)) continue;
        const cost = q.mul(p).add(f);
        lots.push({ acqDate: tx.executedAt, qty: q, unitCost: cost.div(q) });
      } else if (tx.type === "sell" || tx.type === "transfer_out") {
        let remaining = q;
        while (remaining.gt(0) && lots.length > 0) {
          const lot = lots[0];
          const take = Decimal.min(lot.qty, remaining);
          lot.qty = lot.qty.sub(take);
          remaining = remaining.sub(take);
          if (lot.qty.lte(0)) lots.shift();
        }
      }
      // dividend/coupon/interest/fee/tax/deposit/withdrawal/loan_*/split/rights TYPE:
      // no effect on the lot ledger (corporate actions handled above).
    }

    // Drop zero/negligible residual lots left by rounding (defensive; the FIFO
    // consume loop above already shifts fully-consumed lots out).
    const openLotsForInstrument = lots.filter((l) => l.qty.gt(0));
    if (openLotsForInstrument.length === 0) continue;

    result.set(
      instrumentId,
      openLotsForInstrument.map((l) => ({
        acqDate: toDateKey(l.acqDate),
        qty: l.qty.toString(),
        unitCost: l.unitCost.toString(),
        cost: l.qty.mul(l.unitCost).toString(),
      })),
    );
  }

  return result;
}
