import { Decimal } from "decimal.js";
import type { CoreTransaction, CorporateAction, Holding } from "./types.js";

const D = (v: string | number) => new Decimal(v);
const ZERO = new Decimal(0);

type Event =
  { kind: "tx"; at: Date; tx: CoreTransaction } | { kind: "ca"; at: Date; ca: CorporateAction };

/**
 * Derive per-instrument holdings from transactions using the **average cost**
 * method. Handles buys/savings-plan, sells (realized P&L), transfers, zero-cash
 * `bonus` share receipts (free shares at FMV/zero basis), and split/bonus
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
    // Archived + draft rows are excluded from every derivation (cash_neutral rows still
    // count here — their shares are real; only their cash effect is suppressed in cash.ts).
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

      if (
        type === "buy" ||
        type === "savings_plan" ||
        type === "sell" ||
        type === "transfer_in" ||
        type === "transfer_out" ||
        type === "bonus"
      ) {
        if (costCurrency === null) {
          costCurrency = ev.tx.currency;
        } else if (ev.tx.currency !== costCurrency) {
          throw new Error(
            `Instrument ${instrumentId} has transactions in multiple currencies ` +
              `(${costCurrency} and ${ev.tx.currency}); cost basis can't be computed.`,
          );
        }
      }

      if (type === "buy" || type === "savings_plan" || type === "bonus") {
        // `bonus` = a zero-cash share *receipt* (free shares — TR perks, FREE_RECEIPT
        // grants, reinvested rewards). The shares are real, so quantity rises; the
        // recorded price is the FMV-at-grant carried as cost basis (price 0 → free shares
        // at zero basis). Distinct from the corporate-action bonus *issue* handled above.
        // It is never a contribution (see contributions.ts isExternalAcquisition).
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
      // dividend/coupon/fee/deposit/withdrawal/split/rights don't change holdings.
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

// ---------------------------------------------------------------------------
// Share-count timeline (issue #508) — derives implied shares/per-share for income
// rows whose source doesn't carry them (e.g. a TR CSV/IBKR dividend row, or any
// income row still missing the field after source-specific parsing).
// ---------------------------------------------------------------------------

/** Qty-changing transaction types — mirrors the branches in computeHoldings' loop
 *  (89-118) that mutate `qty`. Kept in sync with that switch; dividend/coupon/fee/
 *  deposit/withdrawal/split/rights don't affect quantity there and are excluded here. */
const QTY_AFFECTING_TYPES = new Set([
  "buy",
  "savings_plan",
  "sell",
  "transfer_in",
  "transfer_out",
  "bonus",
]);

/** Net shares held immediately after the event at `at`, on the running timeline. */
export interface ShareCheckpoint {
  at: Date;
  qty: Decimal;
}

/**
 * Build a running share-count timeline per instrument — for looking up how many shares
 * were held at an arbitrary date via `sharesHeldAt`. Used to derive an income
 * transaction's implied share count when the source data doesn't carry one (#508).
 *
 * Mirrors computeHoldings' quantity-mutation rules (`QTY_AFFECTING_TYPES` above; sell/
 * transfer_out clamp to the held quantity exactly as computeHoldings does) so the two
 * can't silently diverge.
 *
 * Deliberately DIFFERENT from computeHoldings' `asOf` semantics: corporate actions here
 * are applied INLINE at their `exDate`, scaling only the quantity accumulated so far —
 * NOT retroactively across the whole series. A lookup at date D therefore returns the
 * share count actually held AT D (pre any later split/bonus), matching what a
 * settlement PDF or CSV prints for a payment on that date.
 *
 * Do NOT reuse `computeHoldings(asOf)` for this: it intentionally applies *every*
 * corporate action regardless of `asOf` (so historical ratios stay split-consistent in
 * today's share terms — see its own doc comment). Reused here, a split that happened
 * AFTER a dividend's pay date would silently rescale that dividend's derived share
 * count, corrupting `perShare = gross / shares` against the pay-date-actual value the
 * source document/parser prints.
 */
export function buildShareTimelines(
  transactions: CoreTransaction[],
  corporateActions: CorporateAction[] = [],
): Map<string, ShareCheckpoint[]> {
  const byInstrument = new Map<string, Event[]>();

  for (const tx of transactions) {
    if (!tx.instrumentId) continue;
    if (tx.status === "archived" || tx.status === "draft") continue;
    if (!QTY_AFFECTING_TYPES.has(tx.type)) continue;
    const list = byInstrument.get(tx.instrumentId) ?? [];
    list.push({ kind: "tx", at: tx.executedAt, tx });
    byInstrument.set(tx.instrumentId, list);
  }
  for (const ca of corporateActions) {
    const list = byInstrument.get(ca.instrumentId) ?? [];
    list.push({ kind: "ca", at: ca.exDate, ca });
    byInstrument.set(ca.instrumentId, list);
  }

  const out = new Map<string, ShareCheckpoint[]>();
  for (const [instrumentId, events] of byInstrument) {
    events.sort((a, b) => a.at.getTime() - b.at.getTime());

    let qty = ZERO;
    const checkpoints: ShareCheckpoint[] = [];

    for (const ev of events) {
      if (ev.kind === "ca") {
        const ratio = D(ev.ca.ratio);
        if (ev.ca.type === "split") {
          qty = qty.mul(ratio);
        } else if (ev.ca.type === "bonus") {
          qty = qty.add(qty.mul(ratio));
        }
        // 'rights' is a no-op here too (see computeHoldings).
        checkpoints.push({ at: ev.at, qty });
        continue;
      }

      const { type, quantity } = ev.tx;
      const q = D(quantity);

      if (type === "buy" || type === "savings_plan" || type === "bonus" || type === "transfer_in") {
        qty = qty.add(q);
      } else if (type === "sell" || type === "transfer_out") {
        qty = qty.sub(Decimal.min(q, qty));
      }
      checkpoints.push({ at: ev.at, qty });
    }

    out.set(instrumentId, checkpoints);
  }

  return out;
}

/**
 * Number of shares held immediately after all events at-or-before `at`, per the
 * timeline built by `buildShareTimelines`. Returns null when the instrument has no
 * timeline (never traded) or the held quantity is not positive — an income row with
 * no matching holding can't have its shares/per-share derived.
 */
export function sharesHeldAt(
  timelines: Map<string, ShareCheckpoint[]>,
  instrumentId: string,
  at: Date,
): Decimal | null {
  const checkpoints = timelines.get(instrumentId);
  if (!checkpoints || checkpoints.length === 0) return null;

  // Binary search for the last checkpoint with `at <= target` — mirrors computeHoldings'
  // asOf convention (`tx.executedAt > asOf` is excluded, i.e. `<=` is included).
  const target = at.getTime();
  let lo = 0;
  let hi = checkpoints.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (checkpoints[mid].at.getTime() <= target) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (result === -1) return null;

  const qty = checkpoints[result].qty;
  return qty.gt(0) ? qty : null;
}

/** Market value of a holding at a given unit price. */
export function marketValue(quantity: string, price: string): string {
  return D(quantity).mul(D(price)).toString();
}

/** Unrealized P&L = market value − remaining cost basis. */
export function unrealizedPnL(quantity: string, price: string, costBasis: string): string {
  return D(quantity).mul(D(price)).sub(D(costBasis)).toString();
}
