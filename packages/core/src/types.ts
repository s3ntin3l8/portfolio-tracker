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
  | "withdrawal"
  // Financing legs (e.g. Pegadaian/Galeri24 gold cicilan). Source of truth for the
  // outstanding-liability balance; deliberately excluded from XIRR/contributions
  // (which whitelist deposit/withdrawal), so booking a loan is not a capital flow.
  | "loan_drawdown"
  | "loan_repayment";

/** Minimal transaction shape the engine needs. Money/qty are decimal strings. */
export interface CoreTransaction {
  instrumentId: string | null; // null for cash movements
  type: TransactionType;
  quantity: string;
  price: string;
  fees: string;
  currency: string;
  executedAt: Date;
  // Links a financing leg (and the financed buy) to its loan; null otherwise.
  loanId?: string | null;
  // Optional source-set sub-classification (e.g. "saveback", "roundup", "transfer_in").
  // Used to tell apart externally-funded purchases from broker-credited reinvestment
  // when deriving contributions; null/undefined for plain transactions.
  kind?: string | null;
  // Withholding tax already netted into `price` for income legs (dividend/coupon/
  // interest). Informational — used by the trade log to surface tax-by-year; the
  // cash effect lives in `price`. null/undefined when not applicable.
  tax?: string | null;
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
