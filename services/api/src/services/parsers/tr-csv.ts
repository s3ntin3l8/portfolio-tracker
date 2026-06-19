import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import type { CsvParseResult } from "./csv.js";
import { splitCsvLine } from "./csv-line.js";

// Trade Republic "Transaction export" CSV — the offline fallback to the pytr WebSocket
// sync (services/pytr). TR lets you export the full account history as a CSV with a fixed,
// snake_case schema. Each row becomes a draft the user confirms (and can deselect) — buys,
// sells, dividends, interest, transfers and card spending are all represented so the
// derived cash balance stays correct; everything else is surfaced as an error rather than
// silently dropped.
//
// Conventions verified against a real 981-row export (2026-06-19):
//   • Trades:    |amount| = shares × price  (fee is SEPARATE, not folded into amount).
//   • Dividends: `amount` is GROSS; the withheld `tax` is `|tax|/|amount|` = the statutory
//                rate (26.375% DE, 15% US). Net cash credited = amount − |tax|, which is
//                what drives cashFlow/XIRR — so `price` = net, `total` = gross (cf. cash.ts).
//   • Sign:      buy amount<0/shares>0, sell amount>0/shares<0, cash-in>0, cash-out<0.
//   • FX:        amount(EUR) = original_amount × fx_rate; `fx_rate` is kept as enrichment.

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

const DEPOSIT_TYPES = new Set([
  "CUSTOMER_INBOUND",
  "CUSTOMER_INPAYMENT",
  "TRANSFER_INBOUND",
  "TRANSFER_INSTANT_INBOUND",
]);
const WITHDRAWAL_TYPES = new Set([
  "CUSTOMER_OUTBOUND_REQUEST",
  "TRANSFER_OUT",
  "TRANSFER_OUTBOUND",
  "TRANSFER_INSTANT_OUTBOUND",
]);
// Debit-card spending (and the one-off card fee) draws down the TR cash balance, so it is
// recorded as a withdrawal — matching the pytr mapper. Users omit these at review if wanted.
const CARD_TYPES = new Set(["CARD_TRANSACTION", "CARD_TRANSACTION_INTERNATIONAL"]);
const DIVIDEND_TYPES = new Set(["DIVIDEND", "DISTRIBUTION"]);
// Cash credits with no share leg (cashback / promos). Broker-credited money, not a user
// contribution — recorded as income (interest) carrying a `kind`, so it lands in cash but
// is excluded from contributed-capital like INTEREST_PAYOUT (cf. the pytr mapper). Unlike
// pytr's SAVEBACK_AGGREGATE, the CSV row has no reinvestment shares.
const CASH_CREDIT_KIND: Record<string, string> = {
  BENEFITS_SAVEBACK: "saveback",
  BONUS: "bonus",
};
// Shares received with no cash consideration → bonus (quantity = received shares, price 0).
const SHARE_IN_TYPES = new Set(["FREE_RECEIPT", "DIVIDEND_OPTION", "DIVIDEND_REINVESTMENT"]);
// Recognised but not representable as a single transaction leg — surfaced for manual
// handling rather than guessed. Rare (5 rows in the reference export).
const UNSUPPORTED = new Map<string, string>([
  ["TAX_OPTIMIZATION", "tax-optimisation adjustment (no transaction leg)"],
  ["SEC_ACCOUNT", "securities-account tax adjustment (no transaction leg)"],
  ["DIVIDEND_OPTION_CANCELLED", "reversal of a dividend-option election"],
]);

function toNum(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// Format a number as a decimalString (no exponent, trailing zeros trimmed, no "-0").
function dec(n: number): string {
  if (!Number.isFinite(n)) return "0";
  const s = n.toFixed(10).replace(/\.?0+$/, "");
  return s === "" || s === "-" || s === "-0" ? "0" : s;
}

function assetClassOf(raw: string): "equity" | "crypto" | undefined {
  switch (raw.trim().toUpperCase()) {
    case "STOCK":
    case "FUND":
      return "equity"; // refined to etf/mutual_fund at confirm via OpenFIGI
    case "CRYPTO":
      return "crypto";
    default:
      return undefined;
  }
}

// TR exports HTML-escape security names (e.g. "Core S&amp;P 500"). Decode in a single pass
// so a replacement can't be re-interpreted as another entity (no double-unescaping).
const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#39;": "'",
};
function decodeName(s: string): string {
  return s.replace(/&(?:amp|lt|gt|quot|#39);/g, (m) => HTML_ENTITIES[m] ?? m).trim();
}

/**
 * Parse a Trade Republic transaction-export CSV into draft transactions. Each recognised
 * row becomes a draft (confidence 1); rows of a recognised-but-unmappable type, and rows
 * missing required figures, are collected as errors rather than failing the whole import.
 */
export function parseTrCsv(content: string): CsvParseResult {
  const stripped = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const lines = stripped.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const drafts: ParsedTransaction[] = [];
  const errors: CsvParseResult["errors"] = [];
  if (lines.length < 2) return { drafts, errors };

  const header = splitCsvLine(lines[0]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name);
  const cols = {
    datetime: idx("datetime"),
    type: idx("type"),
    assetClass: idx("asset_class"),
    name: idx("name"),
    symbol: idx("symbol"),
    shares: idx("shares"),
    price: idx("price"),
    amount: idx("amount"),
    fee: idx("fee"),
    tax: idx("tax"),
    currency: idx("currency"),
    fxRate: idx("fx_rate"),
    txId: idx("transaction_id"),
  };

  for (let i = 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const get = (j: number) => (j >= 0 ? (c[j] ?? "") : "");
    const fail = (message: string) => errors.push({ line: i + 1, message });

    const type = get(cols.type).trim().toUpperCase();
    const amount = toNum(get(cols.amount));
    const fee = toNum(get(cols.fee));
    const tax = toNum(get(cols.tax));
    const shares = toNum(get(cols.shares));
    const priceCol = toNum(get(cols.price));

    const symbol = get(cols.symbol).trim();
    const isin = ISIN_RE.test(symbol) ? symbol : undefined;
    const ticker = isin ? undefined : symbol || undefined;
    const name = decodeName(get(cols.name)) || undefined;
    const assetClass = assetClassOf(get(cols.assetClass));
    const fxRate = get(cols.fxRate).trim() || undefined;

    // Fields shared by every draft. Currency defaults to EUR for the share-in corporate
    // actions, whose cash currency column is blank.
    const base = {
      currency: get(cols.currency).trim() || "EUR",
      executedAt: get(cols.datetime),
      externalId: `tr-csv:${get(cols.txId)}`,
      confidence: 1 as const,
      fxRate,
    };
    const instrument = { assetClass, isin, ticker, name };

    let candidate: Record<string, unknown>;

    if (type === "BUY" || type === "SELL") {
      if (shares == null || priceCol == null || amount == null) {
        fail(`${type} row missing shares/price/amount`);
        continue;
      }
      candidate = {
        ...base,
        ...instrument,
        action: type === "BUY" ? "buy" : "sell",
        quantity: dec(Math.abs(shares)),
        unit: assetClass === "crypto" ? "units" : "shares",
        price: dec(Math.abs(priceCol)),
        fees: fee != null ? dec(Math.abs(fee)) : "0",
        total: dec(Math.abs(amount) + Math.abs(fee ?? 0)), // gross consideration incl. fee
      };
    } else if (DIVIDEND_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      const gross = Math.abs(amount);
      const withheld = tax != null ? Math.abs(tax) : 0;
      candidate = {
        ...base,
        ...instrument,
        action: "dividend",
        quantity: "0", // the CSV `shares` here is the holding/rate, not a traded quantity
        unit: assetClass ? "shares" : undefined,
        price: dec(gross - withheld), // NET cash credited drives cashFlow/XIRR
        total: dec(gross), // gross payout (display only)
        tax: withheld ? dec(withheld) : undefined,
        fees: "0",
      };
    } else if (type === "INTEREST_PAYMENT") {
      if (amount == null) {
        fail("INTEREST_PAYMENT row missing amount");
        continue;
      }
      candidate = {
        ...base,
        action: "interest",
        quantity: "0",
        price: dec(Math.abs(amount)),
        tax: tax ? dec(Math.abs(tax)) : undefined,
        fees: "0",
      };
    } else if (DEPOSIT_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      candidate = { ...base, action: "deposit", quantity: "0", price: dec(Math.abs(amount)), fees: "0" };
    } else if (WITHDRAWAL_TYPES.has(type) || CARD_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      candidate = { ...base, action: "withdrawal", quantity: "0", price: dec(Math.abs(amount)), fees: "0" };
    } else if (type === "CARD_ORDERING_FEE") {
      const charge = fee ?? amount ?? 0;
      candidate = { ...base, action: "withdrawal", quantity: "0", price: dec(Math.abs(charge)), fees: "0" };
    } else if (type in CASH_CREDIT_KIND) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      // Income, not a holding or a contribution — keep the source name for context, drop
      // the instrument. `interest` lands in cash but is excluded from contributed capital.
      candidate = {
        ...base,
        name,
        action: "interest",
        quantity: "0",
        price: dec(Math.abs(amount)),
        fees: "0",
        kind: CASH_CREDIT_KIND[type],
      };
    } else if (SHARE_IN_TYPES.has(type)) {
      if (shares == null || shares === 0) {
        fail(`${type} row missing a share count`);
        continue;
      }
      candidate = {
        ...base,
        ...instrument,
        action: "bonus",
        quantity: dec(Math.abs(shares)),
        unit: "shares",
        price: "0", // shares received with no cash consideration
        fees: "0",
        // A FREE_RECEIPT is an inbound securities transfer — contributed capital at its
        // carried cost basis (the user sets the price when editing). DIVIDEND_OPTION/
        // _REINVESTMENT are reinvested income, not contributions, so they stay untagged.
        // See CLAUDE.md "one boundary per portfolio".
        kind: type === "FREE_RECEIPT" ? "transfer_in" : null,
      };
    } else if (UNSUPPORTED.has(type)) {
      fail(`${type}: ${UNSUPPORTED.get(type)}`);
      continue;
    } else {
      fail(`unsupported Trade Republic type: ${type || "(blank)"}`);
      continue;
    }

    const parsed = parsedTransactionSchema.safeParse(candidate);
    if (parsed.success) drafts.push(parsed.data);
    else fail(parsed.error.issues[0]?.message ?? "invalid row");
  }

  return { drafts, errors };
}
