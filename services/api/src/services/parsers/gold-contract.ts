import { Decimal } from "decimal.js";
import type { ParsedGoldContract, TransactionType } from "@portfolio/schema";

/**
 * One transaction leg derived from a gold-installment contract. `role` tells the
 * confirm flow which leg carries the gold instrument (the buy); the rest are
 * instrument-less cash/financing legs. All share the contract's loanId (assigned
 * at insert time) and currency.
 */
export interface ContractLeg {
  role: "gold_buy" | "loan_drawdown" | "admin_fee" | "discount" | "repayment";
  type: TransactionType;
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  executedAt: Date;
}

/** Identity for the financed gold instrument (Galeri 24 buyback-valued, in grams). */
export function goldInstrumentForContract(c: ParsedGoldContract): {
  symbol: string;
  market: string;
  name: string;
} {
  // Galeri 24 / Pegadaian MULIA gold is valued at the GALERI24 buyback per gram.
  const market = "GALERI24";
  // Key each contract to its own instrument so per-contract cost basis and the
  // loan↔instrument link stay 1:1 (all priced identically by the buyback provider).
  const key = c.contractNo ?? c.goldName ?? `${c.grams}g`;
  return {
    symbol: `G24:${key}`,
    market,
    name: c.goldName ?? `Galeri 24 Gold ${c.grams}g`,
  };
}

/**
 * Derive the transaction legs from a financed gold contract. The gold buy books
 * the full purchase price as cost basis (rounding remainder absorbed into the
 * buy's fees so cost basis equals the purchase price exactly). The down payment
 * is implicit — the net of (buy − drawdown − admin + discount) equals the real
 * upfront cash. Only installments due on/before `now` become repayment legs; the
 * rest live in the loan's schedule for display and a future "mark paid" action.
 */
export function buildContractLegs(
  c: ParsedGoldContract,
  now: Date,
): ContractLeg[] {
  const currency = c.currency;
  const grams = new Decimal(c.grams);
  const purchase = new Decimal(c.purchasePrice);

  // Per-gram price (rounded down so the remainder is non-negative), with the
  // sub-unit remainder carried in fees → cost basis == purchasePrice exactly.
  const perGram = grams.isZero()
    ? new Decimal(0)
    : purchase.div(grams).toDecimalPlaces(2, Decimal.ROUND_DOWN);
  const remainder = purchase.sub(grams.mul(perGram));

  const legs: ContractLeg[] = [
    {
      role: "gold_buy",
      type: "buy",
      quantity: grams.toString(),
      price: perGram.toString(),
      fees: remainder.toString(),
      currency,
      executedAt: c.startDate,
    },
    {
      role: "loan_drawdown",
      type: "loan_drawdown",
      quantity: "0",
      price: new Decimal(c.principal).toString(),
      fees: "0",
      currency,
      executedAt: c.startDate,
    },
  ];

  const adminFee = new Decimal(c.adminFee);
  if (!adminFee.isZero()) {
    legs.push({
      role: "admin_fee",
      type: "fee",
      quantity: "0",
      price: adminFee.toString(),
      fees: "0",
      currency,
      executedAt: c.startDate,
    });
  }

  const discount = new Decimal(c.discount);
  if (!discount.isZero()) {
    // A promo discount is cash in → a negative fee.
    legs.push({
      role: "discount",
      type: "fee",
      quantity: "0",
      price: discount.neg().toString(),
      fees: "0",
      currency,
      executedAt: c.startDate,
    });
  }

  // Installments already due become real repayment legs (principal in price,
  // financing margin in fees). Future installments stay in the schedule only.
  for (const row of c.schedule) {
    if (row.dueDate.getTime() > now.getTime()) continue;
    legs.push({
      role: "repayment",
      type: "loan_repayment",
      quantity: "0",
      price: new Decimal(row.pokok).toString(),
      fees: new Decimal(row.sewaModal).toString(),
      currency,
      executedAt: row.dueDate,
    });
  }

  return legs;
}
