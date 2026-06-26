import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import type { CsvParseResult } from "./csv.js";
import { splitCsvLine } from "./csv-line.js";
import { formatDecimal } from "./numeric.js";

// Trade Republic "Transaction export" CSV — the offline fallback to the pytr WebSocket
// sync (services/pytr). TR lets you export the full account history as a CSV with a fixed,
// snake_case schema. Each row becomes a draft the user confirms (and can deselect) — buys,
// sells, dividends, interest, transfers, card spending, broker promos and the German
// Vorabpauschale tax are all represented so the derived cash balance stays correct;
// unrecognised types are surfaced for review rather than silently dropped.
//
// Conventions verified against real exports (981-row main + a JUNIOR child depot, 2026-06-19):
//   • Trades:    |amount| = shares × price  (fee is SEPARATE, not folded into amount).
//   • Dividends: `amount` is GROSS (signed). `tax` is negative for a withholding, positive
//                for a refund/reversal. Net = amount + tax. `price` = signed net (drives
//                cashFlow/XIRR); `tax` stored as −csv_tax (positive = withheld, negative =
//                refund) to match the DKB/manual convention. A reversal row has a negative
//                `amount` and positive `tax`, yielding a negative net and negative stored tax.
//   • Promos:    BENEFITS_SAVEBACK → income (action `interest` + kind `saveback`) — excluded
//                from contributions. BONUS/KINDERGELD_BONUS/STOCKPERK → action `bonus_cash`
//                (a distinct broker-cash type with its own "Bonus" label), also excluded.
//   • EARNINGS:  Vorabpauschale (advance fund tax): gross 0, only `tax` withheld, so the net
//                cash is −|tax| → a negative-cash income leg (cash & gain drop, not contribution).
//   • Sign:      buy amount<0/shares>0, sell amount>0/shares<0, cash-in>0, cash-out<0.
//   • FX:        amount(EUR) = original_amount × fx_rate; `fx_rate` is kept as enrichment.

const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

const DEPOSIT_TYPES = new Set([
  "CUSTOMER_INBOUND",
  "CUSTOMER_INPAYMENT",
  "TRANSFER_INBOUND",
  "TRANSFER_INSTANT_INBOUND",
  // Incoming cash transfer (e.g. a parent funding a child's JUNIOR depot). Cash, not a
  // securities transfer — plain deposit, no `kind` (cf. the share-in FREE_RECEIPT below).
  "TRANSFER_IN",
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
// contribution — excluded from contributed capital (cf. the pytr mapper). Unlike pytr's
// SAVEBACK_AGGREGATE, the CSV rows have no reinvestment shares.
//
// BENEFITS_SAVEBACK: recorded as action `interest` + kind `saveback` — keeping saveback's
//   own contribution-exclusion path unchanged.
// BONUS / KINDERGELD_BONUS / STOCKPERK: broker cash bonuses → action `bonus_cash` + kind
//   `bonus`. KINDERGELD_BONUS is a TR cash credit on the Kindergeld feature; STOCKPERK is a
//   reward credited as cash (the row has an instrument field but no share count). All three
//   have the same economics but are now distinguishable in the UI as "Bonus".
const CASH_SAVEBACK_TYPES = new Set(["BENEFITS_SAVEBACK"]);
const CASH_BONUS_TYPES = new Set(["BONUS", "KINDERGELD_BONUS", "STOCKPERK"]);
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
 * Rows of an *unrecognised* type become "attention" issues the user can map manually in
 * the review screen — never silently dropped.
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
    description: idx("description"),
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
      // CSV sell `tax` column: negative = capital-gains tax withheld. Captured so
      // cashFlow (sell) = qty·price − fees − tax matches the invariant Σ(amount+fee+tax).
      // Buy rows don't carry tax (German KapSt only applies to proceeds, not purchases).
      const sellTax = type === "SELL" && tax != null && tax !== 0 ? formatDecimal(Math.abs(tax)) : undefined;
      candidate = {
        ...base,
        ...instrument,
        action: type === "BUY" ? "buy" : "sell",
        quantity: formatDecimal(Math.abs(shares)),
        unit: assetClass === "crypto" ? "units" : "shares",
        price: formatDecimal(Math.abs(priceCol)), // gross per-share price (amount / shares)
        fees: fee != null ? formatDecimal(Math.abs(fee)) : "0",
        tax: sellTax,
        total: formatDecimal(Math.abs(amount) + Math.abs(fee ?? 0)), // gross consideration incl. fee
      };
    } else if (DIVIDEND_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      // CSV sign: `amount` = signed gross, `tax` = negative for a withholding, positive for
      // a refund/reversal. net = amount + tax. We store `price` = signed net (drives
      // cashFlow/XIRR), and convert the CSV tax to the app's convention: positive = withheld,
      // negative = refund — i.e. stored_tax = −csv_tax. A reversal row (amount < 0, tax > 0)
      // produces a negative price (cash out) and a negative stored_tax (refund tag).
      const taxSigned = tax ?? 0; // CSV: negative = withheld, positive = refunded
      const net = amount + taxSigned; // signed net cash credited
      candidate = {
        ...base,
        ...instrument,
        action: "dividend",
        quantity: "0", // the CSV `shares` here is the holding/rate, not a traded quantity
        unit: assetClass ? "shares" : undefined,
        price: formatDecimal(net), // signed NET drives cashFlow/XIRR; negative for reversals
        total: formatDecimal(amount), // signed gross (display only; not persisted)
        tax: taxSigned !== 0 ? formatDecimal(-taxSigned) : undefined, // +withheld / −refund
        fees: "0",
      };
    } else if (type === "INTEREST_PAYMENT") {
      if (amount == null) {
        fail("INTEREST_PAYMENT row missing amount");
        continue;
      }
      // Mirror the dividend net-into-price convention (lines above): `price` = net cash so
      // cashFlow reads the right amount. CSV tax is negative for a withholding.
      const taxSigned = tax ?? 0;
      const net = amount + taxSigned; // amount - |withheld|
      candidate = {
        ...base,
        action: "interest",
        quantity: "0",
        price: formatDecimal(Math.abs(net)),
        tax: taxSigned !== 0 ? formatDecimal(-taxSigned) : undefined, // +withheld / −refund
        fees: "0",
      };
    } else if (type === "EARNINGS") {
      // German Vorabpauschale (advance lump-sum fund tax): the gross payout is 0 and only a
      // `tax` is withheld, so the net cash effect is −|tax|. Model it as a negative-cash
      // income leg (cf. the dividend net/gross convention above): `price` is the net cash
      // `cashFlow` reads, so cash and gain both drop by the tax while contribution is
      // unchanged (interest is return, never contributed capital). No instrument leg — the
      // tax doesn't change the holding; the name labels it for review.
      if (tax == null) {
        fail("EARNINGS row missing tax");
        continue;
      }
      const net = (amount ?? 0) - Math.abs(tax);
      candidate = {
        ...base,
        name: decodeName(get(cols.description)) || name || "Vorabpauschale",
        action: "interest",
        quantity: "0",
        price: formatDecimal(net),
        tax: formatDecimal(Math.abs(tax)),
        fees: "0",
      };
    } else if (DEPOSIT_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      candidate = { ...base, action: "deposit", quantity: "0", price: formatDecimal(Math.abs(amount)), fees: "0" };
    } else if (WITHDRAWAL_TYPES.has(type) || CARD_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      candidate = { ...base, action: "withdrawal", quantity: "0", price: formatDecimal(Math.abs(amount)), fees: "0" };
    } else if (type === "CARD_ORDERING_FEE") {
      const charge = fee ?? amount ?? 0;
      candidate = { ...base, action: "withdrawal", quantity: "0", price: formatDecimal(Math.abs(charge)), fees: "0" };
    } else if (CASH_SAVEBACK_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      // Saveback: broker-credited cashback on trades — income, not a contribution.
      // Recorded as `interest` + kind `saveback` to reuse the saveback contribution-exclusion.
      candidate = {
        ...base,
        name,
        action: "interest",
        quantity: "0",
        price: formatDecimal(Math.abs(amount)),
        fees: "0",
        kind: "saveback",
      };
    } else if (CASH_BONUS_TYPES.has(type)) {
      if (amount == null) {
        fail(`${type} row missing amount`);
        continue;
      }
      // Broker cash bonus (Kindergeld credit, promotion bonus, stock perk) — income but
      // distinct from uninvested-cash interest so it shows as "Bonus" in the UI.
      // `kind: "bonus"` is kept for context and backfill matching.
      candidate = {
        ...base,
        name,
        action: "bonus_cash",
        quantity: "0",
        price: formatDecimal(Math.abs(amount)),
        fees: "0",
        kind: "bonus",
      };
    } else if (SHARE_IN_TYPES.has(type)) {
      if (shares == null || shares === 0) {
        fail(`${type} row missing a share count`);
        continue;
      }
      if (type === "FREE_RECEIPT") {
        // Discriminator: a TR-issued grant (BTC/ETH promo) has a price; a genuine
        // depot-to-depot share transfer (Depotübertrag) has no price.
        if (priceCol != null && priceCol !== 0) {
          // Crypto/promo grant: income at market basis. NOT a contribution.
          candidate = {
            ...base,
            ...instrument,
            action: "bonus",
            quantity: formatDecimal(Math.abs(shares)),
            unit: assetClass === "crypto" ? "units" : "shares",
            price: formatDecimal(Math.abs(priceCol)),
            fees: "0",
          };
        } else {
          // Depot transfer: carried cost basis is unknown — emit a low-confidence draft
          // so the review screen prompts the user to set the original cost basis.
          // action:"transfer_in" is the first-class type from PR #309.
          candidate = {
            ...base,
            ...instrument,
            action: "transfer_in",
            quantity: formatDecimal(Math.abs(shares)),
            unit: "shares",
            price: "0", // user must set the carried cost basis at confirm
            fees: "0",
            confidence: 0.5, // prompts review; sub-1 surfaces in import-review.tsx
          };
        }
      } else {
        // DIVIDEND_OPTION / DIVIDEND_REINVESTMENT: reinvested income, not a contribution.
        candidate = {
          ...base,
          ...instrument,
          action: "bonus",
          quantity: formatDecimal(Math.abs(shares)),
          unit: "shares",
          price: "0",
          fees: "0",
        };
      }
    } else if (UNSUPPORTED.has(type)) {
      fail(`${type}: ${UNSUPPORTED.get(type)}`);
      continue;
    } else {
      // An unrecognised type — don't guess its economics, but don't discard it either.
      // Surface it as a mappable "attention" issue so the user can turn it into the right
      // transaction in the review screen (reusing the Trade Republic map-issue editor).
      // `eventId` mirrors the `tr-csv:${txId}` externalId convention so a mapped row dedups
      // consistently with the rows we parsed directly; a blank txId gets a stable row id.
      const txId = get(cols.txId).trim();
      errors.push({
        line: i + 1,
        severity: "attention",
        eventId: txId ? `tr-csv:${txId}` : `tr-csv:row-${i}`,
        eventType: type || "(blank)",
        message: `unsupported Trade Republic type: ${type || "(blank)"} — review to map manually`,
        raw: {
          isin: isin ?? null,
          name: name ?? null,
          currency: base.currency,
          executedAt: base.executedAt || null,
          amount,
          shares,
        },
      });
      continue;
    }

    const parsed = parsedTransactionSchema.safeParse(candidate);
    if (parsed.success) drafts.push(parsed.data);
    else fail(parsed.error.issues[0]?.message ?? "invalid row");
  }

  return { drafts, errors };
}
