// Transaction types that affect holdings/cash. Mirrors @portfolio/schema but kept
// local so the calc engine has no workspace dependencies.
export type TransactionType =
  | "buy"
  | "sell"
  | "dividend"
  | "coupon"
  | "interest"
  | "fee"
  // A standalone tax debit NOT tied to a disposal — e.g. German Vorabpauschale (advance
  // lump-sum fund tax). Cash outflow (like `fee`), never income or a contribution.
  | "tax"
  | "split"
  | "bonus"
  | "rights"
  | "savings_plan"
  | "deposit"
  | "withdrawal"
  // Broker-credited cash bonus (e.g. TR Kindergeld/promo bonus) — lump-sum income,
  // not a user contribution. Same cash economics as `interest` but distinct so it
  // renders with its own "Bonus" label.
  | "bonus_cash"
  // Financing legs (e.g. Pegadaian/Galeri24 gold cicilan). Source of truth for the
  // outstanding-liability balance; deliberately excluded from XIRR/contributions
  // (which whitelist deposit/withdrawal), so booking a loan is not a capital flow.
  | "loan_drawdown"
  | "loan_repayment"
  // Depot-to-depot securities transfers (Depotübertrag). Cash-neutral — shares move
  // in/out at carried cost basis. For inside-boundary portfolios, transfer_in is counted
  // as contributed value at the carried basis (insideMonths). NOT realized P&L.
  // Replaces the former `bonus` + `kind:"transfer_in"` hack (PR #309).
  | "transfer_in"
  | "transfer_out";

/**
 * Visibility/lifecycle status of a transaction.
 * - "normal"       : counts everywhere (default when undefined).
 * - "archived"     : ignored in every derivation. The API filters these out before
 *   they reach the engine, so the calc functions should never see one — but they are
 *   treated as cash-/holding-neutral defensively if one slips through.
 * - "cash_neutral" : keeps shares/cost-basis, but its `cashFlow` is only `-fees` and it
 *   is not counted as a contribution. For reward-funded acquisitions whose funding leg
 *   the broker feed omits (e.g. a crypto promo bonus that pays for the buy).
 * - "draft"        : an unconfirmed import/sync row. Excluded from every derivation
 *   (like "archived") until the user confirms it. The API filters these out before the
 *   engine; the calc functions also skip them defensively if one slips through.
 */
export type TransactionStatus = "normal" | "archived" | "cash_neutral" | "draft";

/** Minimal transaction shape the engine needs. Money/qty are decimal strings. */
export interface CoreTransaction {
  /** DB primary key; optional so in-memory/test fixtures can omit it. */
  id?: string;
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
  // Groups executions of the same broker savings plan (Sparplan). Written by the TR
  // importer; used only by sparplan detection. null/undefined for non-plan rows.
  savingsPlanId?: string | null;
  // Visibility/lifecycle status (see {@link TransactionStatus}). undefined ⇒ "normal".
  status?: TransactionStatus | null;
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
  costBasis: string; // total cost of remaining units (in costCurrency)
  realizedPnL: string; // in costCurrency
  /**
   * The currency in which the cost basis and realized P&L are denominated.
   * Normally the trade currency from buy/savings_plan/sell transactions for
   * this instrument. Null when the instrument has had no price-bearing trades
   * (e.g. pure-dividend rows). This is often the same as the quote currency,
   * but diverges for instruments traded in a different currency than they are
   * priced/quoted in (e.g. US stocks bought in EUR via a European broker).
   */
  costCurrency: string | null;
}
