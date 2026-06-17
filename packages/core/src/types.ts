// Transaction types that affect holdings/cash. Mirrors @portfolio/schema but kept
// local so the calc engine has no workspace dependencies.
export type TransactionType =
  | "buy"
  | "sell"
  | "dividend"
  | "coupon"
  | "interest"
  | "fee"
  | "split"
  | "bonus"
  | "rights"
  | "savings_plan"
  | "deposit"
  | "withdrawal";

/** Minimal transaction shape the engine needs. Money/qty are decimal strings. */
export interface CoreTransaction {
  instrumentId: string | null; // null for cash movements
  type: TransactionType;
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  executedAt: Date;
}

export interface CorporateAction {
  instrumentId: string;
  type: "split" | "bonus" | "rights";
  ratio: string; // split 2:1 => "2"; 1:10 bonus => "0.1"
  exDate: Date;
}

export interface Holding {
  instrumentId: string;
  quantity: string; // remaining units
  avgCost: string; // average cost per unit
  costBasis: string; // total cost of remaining units
  realizedPnL: string;
}
