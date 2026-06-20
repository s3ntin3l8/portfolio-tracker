import { Decimal } from "decimal.js";
import type { CoreTransaction } from "./types.js";

const D = (v: string | number) => new Decimal(v);

/** Signed cash effect of a single transaction (positive = cash in). */
export function cashFlow(tx: CoreTransaction): Decimal {
  const q = D(tx.quantity);
  const p = D(tx.price);
  const f = D(tx.fees);
  const notional = q.mul(p);

  switch (tx.type) {
    case "deposit":
      return p.sub(f);
    case "withdrawal":
      return p.neg().sub(f);
    case "buy":
    case "savings_plan":
      return notional.neg().sub(f);
    case "sell":
      return notional.sub(f);
    case "dividend":
    case "coupon":
    case "interest":
    case "bonus_cash":
      // Income: per-unit (qty>0) or a lump sum recorded in price. Interest/bonus_cash are
      // always lump sums (no instrument) — cash in, never a contribution.
      return (q.gt(0) ? notional : p).sub(f);
    case "fee":
      return p.neg().sub(f);
    case "loan_drawdown":
      // Financed cash arrives; it is immediately spent on the paired buy, so the
      // two legs are net-neutral on the contract date.
      return p;
    case "loan_repayment":
      // An installment: principal (price) + financing margin (fees) leave cash.
      return p.neg().sub(f);
    case "split":
    case "bonus":
    case "rights":
      return f.neg();
    default:
      return new Decimal(0);
  }
}

/** Uninvested cash balance per currency, derived from all transactions. */
export function cashBalances(
  transactions: CoreTransaction[],
): Record<string, string> {
  const totals = new Map<string, Decimal>();
  for (const tx of transactions) {
    const cur = tx.currency;
    totals.set(cur, (totals.get(cur) ?? new Decimal(0)).add(cashFlow(tx)));
  }
  const out: Record<string, string> = {};
  for (const [cur, total] of totals) out[cur] = total.toString();
  return out;
}
