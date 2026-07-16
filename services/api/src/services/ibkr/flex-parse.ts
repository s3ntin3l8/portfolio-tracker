import { XMLParser } from "fast-xml-parser";

// ---------------------------------------------------------------------------
// Typed shapes for the Activity Flex Statement XML elements we consume.
// Each element is attribute-only in the Flex format — fast-xml-parser returns
// them as plain objects (not nested child elements).
// ---------------------------------------------------------------------------

export interface FlexTrade {
  assetCategory: string; // STK | ETF | BOND | BILL | FUND | CRYPTO | OPT | FUT | WAR
  symbol: string;
  description?: string;
  isin?: string;
  conid?: string;
  tradeID?: string;
  ibOrderID?: string;
  tradeDate: string; // YYYY-MM-DD or YYYYMMDD
  currency: string;
  quantity: string; // signed: positive=buy, negative=sell
  tradePrice: string;
  ibCommission: string; // always negative (cost to client)
  ibCommissionCurrency?: string;
  taxes?: string; // stamp duty / Kapitalertragsteuer on trade; 0 for most EU/IBKR-EU accounts
  fxRateToBase?: string;
  buySell: string; // "BUY" | "SELL" | "BUY (Ca.)" | "SELL (Ca.)"
  openCloseIndicator?: string; // O, C, O;C
  levelOfDetail?: string; // EXECUTION | ORDER (include only EXECUTION rows)
  netCash?: string;
  proceeds?: string;
}

export interface FlexCashTransaction {
  assetCategory?: string;
  symbol?: string;
  description?: string;
  isin?: string;
  currency: string;
  amount: string; // positive = received, negative = paid/withheld
  dateTime: string; // YYYYMMDD;HHMMSS or YYYY-MM-DD;HH:MM:SS or YYYYMMDD
  type: string; // see CASH_TX_TYPES below
  transactionID?: string;
  reportDate?: string;
  settleDate?: string;
  tradeID?: string;
  levelOfDetail?: string;
}

/** The CashTransaction.type values we recognise explicitly. */
export const CASH_TX_TYPES = {
  DIVIDENDS: "Dividends",
  PAYMENT_IN_LIEU: "Payment In Lieu Of Dividends",
  WITHHOLDING_TAX: "Withholding Tax",
  BROKER_INTEREST: "Broker Interest Received",
  CREDIT_INTEREST: "Credit Interest",
  DEBIT_INTEREST: "Broker Interest Paid",
  DEPOSITS_WITHDRAWALS: "Deposits/Withdrawals",
  OTHER_FEES: "Other Fees",
  TRANSFER: "Transfers", // internal cash moves
  TAX_REVERSAL: "Tax Reversal",
  COMMISSION_ADJUSTMENTS: "Commission Adjustments",
  BOND_INTEREST_RECEIVED: "Bond Interest Received",
  BOND_INTEREST_PAID: "Bond Interest Paid",
  ACCRUALS_RECEIVED: "Accruals Received",
} as const;

export interface FlexTransfer {
  assetCategory: string;
  symbol?: string;
  description?: string;
  isin?: string;
  conid?: string;
  currency: string;
  quantity: string; // signed or absolute depending on direction
  date: string; // YYYY-MM-DD or YYYYMMDD
  type: string; // "IN" | "OUT" | "ACATS IN" | "ACATS OUT" | "INTERNAL IN" | "INTERNAL OUT"
  direction?: string; // "IN" | "OUT" — fallback when type is verbose
  positionAmount?: string; // quantity * market price — useful for carried cost
  positionAmountInBase?: string;
  costBasisMoney?: string; // carried cost basis in trade currency
  costBasisPrice?: string; // per-share cost basis
  priceFactor?: string;
  value?: string;
  valueInBase?: string;
  tradeID?: string;
  transactionID?: string;
}

export interface FlexOpenPosition {
  assetCategory: string;
  symbol: string;
  description?: string;
  isin?: string;
  conid?: string;
  currency: string;
  reportDate: string; // YYYY-MM-DD
  position: string; // quantity held (signed — short is negative)
  markPrice?: string;
  positionValue?: string; // position * markPrice
  positionValueInBase?: string;
  costBasisPrice?: string; // average cost per share
  costBasisMoney?: string; // total cost basis
  percentOfNAV?: string;
  multiplier?: string;
}

export interface FlexCashReportCurrency {
  currency: string;
  endingCash: string;
  endingCashInBase?: string;
  startingCash?: string;
}

export interface FlexCorporateAction {
  assetCategory?: string;
  symbol?: string;
  isin?: string;
  currency?: string;
  /** CA type codes: SO/FS/RS=split, TC=tender/cash-out, HI=spinoff, OR=rights, DW/DI=dividend */
  type: string;
  dateTime?: string;
  reportDate?: string;
  description?: string;
  actionDescription?: string;
  quantity?: string;
  proceeds?: string;
  value?: string;
  priceFactor?: string;
  conid?: string;
  transactionID?: string;
}

/** The fully-parsed Activity Flex Statement for a single account period. */
export interface FlexStatement {
  accountId: string;
  /** Account base currency, from `<AccountInformation currency="…">`. "" when absent. */
  baseCurrency: string;
  fromDate: string;
  toDate: string;
  trades: FlexTrade[];
  cashTransactions: FlexCashTransaction[];
  transfers: FlexTransfer[];
  openPositions: FlexOpenPosition[];
  corporateActions: FlexCorporateAction[];
  cashReport: FlexCashReportCurrency[];
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

const ARRAY_ELEMENTS = new Set([
  "FlexStatement",
  "Trade",
  "CashTransaction",
  "Transfer",
  "OpenPosition",
  "CorporateAction",
  "CashReportCurrency",
  "EquitySummaryByReportDateInBase", // sometimes present instead of / alongside CashReport
]);

/**
 * Parse a Flex `FlexQueryResponse` XML string into typed statements.
 *
 * Returns an array (usually one element — one account). Throws on malformed XML or
 * if the root element is not a `FlexQueryResponse`.
 */
export function parseFlexXml(xml: string): FlexStatement[] {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "",
    isArray: (name) => ARRAY_ELEMENTS.has(name),
    // IBKR uses both self-closing tags (most elements) and wrapper tags that only
    // contain children; the default trimValues is fine.
    trimValues: true,
    // Prevent numeric coercion — we want raw strings for amounts so we can feed them
    // directly into Decimal arithmetic in the mapper without precision loss.
    parseAttributeValue: false,
    parseTagValue: false,
  });

  const doc = parser.parse(xml) as Record<string, unknown>;

  const root = doc["FlexQueryResponse"] as Record<string, unknown> | undefined;
  if (!root) {
    throw new Error("Not a Flex XML file: root element must be <FlexQueryResponse>");
  }

  const statementsWrapper = root["FlexStatements"] as Record<string, unknown> | undefined;
  if (!statementsWrapper) {
    throw new Error("Missing <FlexStatements> in Flex XML");
  }

  const rawStatements = (statementsWrapper["FlexStatement"] as unknown[]) ?? [];
  if (rawStatements.length === 0) {
    return [];
  }

  return rawStatements.map((raw) => parseStatement(raw as Record<string, unknown>));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseStatement(raw: Record<string, unknown>): FlexStatement {
  // Top-level attributes are present directly on the FlexStatement element.
  const accountId = String(raw["accountId"] ?? "");
  const fromDate = String(raw["fromDate"] ?? "");
  const toDate = String(raw["toDate"] ?? "");

  // Base currency lives on the (optional) AccountInformation element. Used to label the
  // base-currency-summary cash row and as a fallback for opening-balance currency.
  const acctInfo = raw["AccountInformation"] as Record<string, unknown> | undefined;
  const baseCurrency =
    acctInfo && typeof acctInfo === "object" ? String(acctInfo["currency"] ?? "") : "";

  return {
    accountId,
    baseCurrency,
    fromDate,
    toDate,
    trades: extractRows<FlexTrade>(raw, "Trades", "Trade"),
    cashTransactions: extractRows<FlexCashTransaction>(raw, "CashTransactions", "CashTransaction"),
    transfers: extractRows<FlexTransfer>(raw, "Transfers", "Transfer"),
    openPositions: extractRows<FlexOpenPosition>(raw, "OpenPositions", "OpenPosition"),
    corporateActions: extractRows<FlexCorporateAction>(raw, "CorporateActions", "CorporateAction"),
    cashReport: extractRows<FlexCashReportCurrency>(raw, "CashReport", "CashReportCurrency"),
  };
}

/**
 * Extract a list of typed records from a wrapper element.
 * Handles both the standard single-statement format and cases where the wrapper
 * element is absent (empty section).
 */
function extractRows<T>(statement: Record<string, unknown>, wrapper: string, element: string): T[] {
  const wrapperEl = statement[wrapper] as Record<string, unknown> | undefined;
  if (!wrapperEl) return [];

  // When there are no child records IBKR sometimes emits an empty wrapper element
  // that fast-xml-parser gives us as an empty string or null.
  if (!wrapperEl || typeof wrapperEl !== "object") return [];

  const rows = wrapperEl[element] as T[] | undefined;
  if (!Array.isArray(rows)) return [];

  return rows;
}

/**
 * Parse an IBKR date/datetime string to an ISO date string `YYYY-MM-DD`.
 *
 * IBKR uses several formats depending on the field and query version:
 * - `YYYYMMDD` (compact date)
 * - `YYYYMMDD;HHMMSS` (compact date-time)
 * - `YYYY-MM-DD` (ISO date)
 * - `YYYY-MM-DD, HH:MM:SS` or `YYYY-MM-DD;HH:MM:SS` (ISO date-time)
 */
export function parseIbkrDate(raw: string): string | null {
  if (!raw) return null;
  const s = raw.trim();

  // ISO date with optional time part: "2023-01-15" or "2023-01-15, 09:30:05"
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // Compact: "20230115" or "20230115;093005"
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;

  return null;
}

// ---------------------------------------------------------------------------
// CashReport currency helpers
// ---------------------------------------------------------------------------
//
// IBKR's CashReport emits one `<CashReportCurrency>` per held currency plus a synthetic
// aggregate row whose `currency` is the literal "BASE_SUMMARY" (values already in the
// account's base currency). A 3-letter ISO code identifies a real per-currency row.

/** True when the row carries a real 3-letter ISO currency (not BASE_SUMMARY). */
export function isRealCurrencyRow(row: FlexCashReportCurrency): boolean {
  return /^[A-Z]{3}$/.test((row.currency ?? "").trim().toUpperCase());
}

/**
 * Resolve a CashReport row to a real ISO currency code:
 * - real per-currency row → its own code;
 * - BASE_SUMMARY (or any non-ISO label) → the supplied base currency, if it is a valid
 *   3-letter ISO code (the row's values are already in base currency);
 * - otherwise `null` (cannot resolve — caller skips it).
 */
export function resolveRowCurrency(
  row: FlexCashReportCurrency,
  baseCurrency: string | undefined,
): string | null {
  if (isRealCurrencyRow(row)) return (row.currency ?? "").trim().toUpperCase();
  const base = (baseCurrency ?? "").trim().toUpperCase();
  return /^[A-Z]{3}$/.test(base) ? base : null;
}

/** A CashReport row paired with its resolved ISO currency. */
export interface ResolvedCashRow {
  row: FlexCashReportCurrency;
  currency: string;
}

/**
 * Pick the effective per-currency cash rows from a CashReport:
 * - prefer real ISO-currency rows (one entry per currency);
 * - fall back to the BASE_SUMMARY aggregate (mapped to the base currency) ONLY when no
 *   real per-currency rows are present — avoids double-counting the same currency.
 * Rows that can't be resolved to a 3-letter ISO currency are dropped; the result is
 * deduped by currency.
 */
export function selectCashRows(
  cashReport: FlexCashReportCurrency[],
  baseCurrency: string | undefined,
): ResolvedCashRow[] {
  const real = cashReport.filter(isRealCurrencyRow);
  const rows = real.length > 0 ? real : cashReport;
  const out: ResolvedCashRow[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const currency = resolveRowCurrency(row, baseCurrency);
    if (!currency || seen.has(currency)) continue;
    seen.add(currency);
    out.push({ row, currency });
  }
  return out;
}
