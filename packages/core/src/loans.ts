import { Decimal } from "decimal.js";
import { convert, type FxRateFn } from "./networth.js";
import type { CoreTransaction } from "./types.js";

const D = (v: string | number) => new Decimal(v);

/**
 * Outstanding principal per loan, derived from the financing legs:
 * `Σ loan_drawdown.price − Σ loan_repayment.price`. Never stored — the balance
 * is always re-derived so it cannot drift from the transactions.
 */
export function loanBalances(
  transactions: CoreTransaction[],
): Record<string, string> {
  const totals = new Map<string, Decimal>();
  for (const tx of transactions) {
    if (tx.loanId == null) continue;
    if (tx.type === "loan_drawdown") {
      totals.set(tx.loanId, (totals.get(tx.loanId) ?? D(0)).add(tx.price));
    } else if (tx.type === "loan_repayment") {
      totals.set(tx.loanId, (totals.get(tx.loanId) ?? D(0)).sub(tx.price));
    }
  }
  const out: Record<string, string> = {};
  for (const [id, total] of totals) out[id] = total.toString();
  return out;
}

/** Outstanding loan principal per currency — the netting term for net worth. */
export function liabilityBalances(
  transactions: CoreTransaction[],
): Record<string, string> {
  const totals = new Map<string, Decimal>();
  for (const tx of transactions) {
    if (tx.type === "loan_drawdown") {
      totals.set(tx.currency, (totals.get(tx.currency) ?? D(0)).add(tx.price));
    } else if (tx.type === "loan_repayment") {
      totals.set(tx.currency, (totals.get(tx.currency) ?? D(0)).sub(tx.price));
    }
  }
  const out: Record<string, string> = {};
  for (const [ccy, total] of totals) out[ccy] = total.toString();
  return out;
}

/** Total outstanding liabilities, FX-converted to the display currency. */
export function totalLiabilities(
  transactions: CoreTransaction[],
  displayCurrency: string,
  fx?: FxRateFn,
): string {
  const f: FxRateFn = fx ?? (() => "1");
  let total = new Decimal(0);
  for (const [ccy, amount] of Object.entries(liabilityBalances(transactions))) {
    total = total.add(convert(amount, ccy, displayCurrency, f));
  }
  return total.toString();
}

/**
 * Financing cost incurred to date per financed instrument — the amount a
 * "total paid" cost basis adds on top of the purchase price. Derived purely
 * from the loan's legs: admin/discount `fee` legs (discount is a negative fee,
 * so it subtracts) plus the financing margin carried in each booked
 * `loan_repayment.fees`. Attributed to the instrument of the loan's buy leg.
 */
export function financingByInstrument(
  transactions: CoreTransaction[],
): Record<string, string> {
  // Map each loan to the instrument it financed (the buy leg carries both).
  const loanInstrument = new Map<string, string>();
  for (const tx of transactions) {
    if (tx.loanId != null && tx.instrumentId != null) {
      loanInstrument.set(tx.loanId, tx.instrumentId);
    }
  }

  const byLoan = new Map<string, Decimal>();
  for (const tx of transactions) {
    if (tx.loanId == null) continue;
    if (tx.type === "fee") {
      byLoan.set(tx.loanId, (byLoan.get(tx.loanId) ?? D(0)).add(tx.price));
    } else if (tx.type === "loan_repayment") {
      byLoan.set(tx.loanId, (byLoan.get(tx.loanId) ?? D(0)).add(tx.fees));
    }
  }

  const out: Record<string, Decimal> = {};
  for (const [loanId, amount] of byLoan) {
    const instrumentId = loanInstrument.get(loanId);
    if (!instrumentId) continue;
    out[instrumentId] = (out[instrumentId] ?? D(0)).add(amount);
  }
  return Object.fromEntries(
    Object.entries(out).map(([k, v]) => [k, v.toString()]),
  );
}
