import { Decimal } from "decimal.js";
import type { CoreTransaction, CorporateAction, Holding } from "./types.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

type Event =
  | { kind: "tx"; at: Date; tx: CoreTransaction }
  | { kind: "ca"; at: Date; ca: CorporateAction };

/**
 * Derive per-instrument holdings from transactions using the **average cost**
 * method. Handles buys/savings-plan, sells (realized P&L), and split/bonus
 * corporate actions. Cash movements (null instrument) are ignored here.
 *
 * Pass `asOf` to replay only transactions up to (and including) that date.
 * Corporate actions are **always** applied regardless of `asOf`, so the
 * returned quantity is in current share terms — making `histQty / currentQty`
 * ratios split-consistent without extra adjustment.
 */
export function computeHoldings(
  transactions: CoreTransaction[],
  corporateActions: CorporateAction[] = [],
  asOf?: Date,
): Holding[] {
  const byInstrument = new Map<string, Event[]>();

  for (const tx of transactions) {
    if (!tx.instrumentId) continue;
    // Archived rows are excluded from every derivation (cash_neutral rows still count
    // here — their shares are real; only their cash effect is suppressed in cash.ts).
    if (tx.status === "archived") continue;
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

  const holdings: Holding[] = [];

  for (const [instrumentId, events] of byInstrument) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    let qty = ZERO;
    let costBasis = ZERO;
    let realized = ZERO;
    // Cost basis is currency-blind, so every price-bearing transaction for one
    // instrument must share a currency — otherwise the accumulated basis is
    // meaningless. Fail loud rather than produce silently-wrong P&L.
    let costCurrency: string | null = null;

    for (const ev of events) {
      if (ev.kind === "ca") {
        const ratio = D(ev.ca.ratio);
        if (ev.ca.type === "split") {
          // 2:1 split → ratio 2 → quantity doubles, avg cost halves (basis unchanged).
          qty = qty.mul(ratio);
        } else if (ev.ca.type === "bonus") {
          // bonus ratio = extra shares per held share; basis unchanged.
          qty = qty.add(qty.mul(ratio));
        }
        // 'rights' requires a paired subscription transaction; no-op here.
        continue;
      }

      const { type, quantity, price, fees } = ev.tx;
      const q = D(quantity);
      const p = D(price);
      const f = D(fees);

      if (type === "buy" || type === "savings_plan" || type === "sell" ||
          type === "transfer_in" || type === "transfer_out") {
        if (costCurrency === null) {
          costCurrency = ev.tx.currency;
        } else if (ev.tx.currency !== costCurrency) {
          throw new Error(
            `Instrument ${instrumentId} has transactions in multiple currencies ` +
              `(${costCurrency} and ${ev.tx.currency}); cost basis can't be computed.`,
          );
        }
      }

      if (type === "buy" || type === "savings_plan") {
        qty = qty.add(q);
        costBasis = costBasis.add(q.mul(p)).add(f);
      } else if (type === "transfer_in") {
        // Inbound depot transfer: shares arrive at the user's carried cost basis.
        // Fees are typically 0 on a transfer but are added to basis if present.
        qty = qty.add(q);
        costBasis = costBasis.add(q.mul(p)).add(f);
      } else if (type === "sell") {
        const sellQty = Decimal.min(q, qty);
        const avg = qty.gt(0) ? costBasis.div(qty) : ZERO;
        const costOfSold = avg.mul(sellQty);
        const proceeds = sellQty.mul(p).sub(f);
        realized = realized.add(proceeds.sub(costOfSold));
        qty = qty.sub(sellQty);
        costBasis = costBasis.sub(costOfSold);
      } else if (type === "transfer_out") {
        // Outbound depot transfer: shares leave at average cost. NOT a disposal for
        // P&L purposes (no realized gain/loss — the shares move to another depot, not sold).
        const transferQty = Decimal.min(q, qty);
        const avg = qty.gt(0) ? costBasis.div(qty) : ZERO;
        const costOfTransferred = avg.mul(transferQty);
        qty = qty.sub(transferQty);
        costBasis = costBasis.sub(costOfTransferred);
      }
      // dividend/coupon/fee/deposit/withdrawal/bonus/split/rights don't change holdings.
    }

    const avgCost = qty.gt(0) ? costBasis.div(qty) : ZERO;
    holdings.push({
      instrumentId,
      quantity: qty.toString(),
      avgCost: avgCost.toString(),
      costBasis: costBasis.toString(),
      realizedPnL: realized.toString(),
      costCurrency,
    });
  }

  return holdings;
}

/** Market value of a holding at a given unit price. */
export function marketValue(quantity: string, price: string): string {
  return D(quantity).mul(D(price)).toString();
}

/** Unrealized P&L = market value − remaining cost basis. */
export function unrealizedPnL(
  quantity: string,
  price: string,
  costBasis: string,
): string {
  return D(quantity).mul(D(price)).sub(D(costBasis)).toString();
}
