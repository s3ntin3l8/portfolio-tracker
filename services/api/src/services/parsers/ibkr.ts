import {
  parsedTransactionSchema,
  type AssetClass,
  type ParsedAction,
} from "@portfolio/schema";
import type { CsvParseResult } from "./csv.js";
import { splitCsvLine } from "./csv-line.js";
import { shortHash } from "./hash.js";

// Interactive Brokers Flex Query "Trades" CSV (with header). Columns vary by query,
// so we look them up by name. Quantity is signed (buy positive, sell negative);
// IBCommission is negative. AssetClass uses IBKR's short codes.

const ASSET_CLASS: Record<string, AssetClass> = {
  STK: "equity",
  ETF: "etf",
  BOND: "bond",
  BILL: "bond",
  FUND: "mutual_fund",
  CRYPTO: "crypto",
  OPT: "derivative",
  FUT: "derivative",
  FOP: "derivative",
  WAR: "derivative",
};

/** IBKR DateTime is `YYYYMMDD;HHMMSS`, `YYYYMMDD`, or an ISO-ish `YYYY-MM-DD …`. */
function parseDateTime(raw: string): string | null {
  const s = raw.trim().replace(/[;T]/, " ");
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const compact = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return null;
}

function num(raw: string): string {
  return raw.replace(/[^0-9.-]/g, "");
}

export function parseIbkr(content: string): CsvParseResult {
  const lines = content
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);
  const drafts: CsvParseResult["drafts"] = [];
  const errors: CsvParseResult["errors"] = [];

  const headerIdx = lines.findIndex(
    (l) => /\bSymbol\b/i.test(l) && /TradePrice/i.test(l),
  );
  if (headerIdx < 0) return { drafts, errors };

  const header = splitCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const idx = (name: string) => header.indexOf(name.toLowerCase());
  const cols = {
    symbol: idx("symbol"),
    asset: idx("assetclass"),
    when: idx("datetime"),
    qty: idx("quantity"),
    price: idx("tradeprice"),
    commission: idx("ibcommission"),
    currency: idx("currencyprimary"),
    description: idx("description"),
    tradeId: idx("tradeid"),
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const get = (j: number) => (j >= 0 ? (c[j] ?? "") : "");
    const rawQty = num(get(cols.qty));
    if (!rawQty) continue; // non-trade / blank row
    const qty = Number(rawQty);
    const executedAt = parseDateTime(get(cols.when));
    if (!executedAt) {
      errors.push({ line: i + 1, message: "unparseable DateTime" });
      continue;
    }
    const action: ParsedAction = qty >= 0 ? "buy" : "sell";
    const assetClass = ASSET_CLASS[get(cols.asset).toUpperCase()] ?? "equity";
    const symbol = get(cols.symbol);

    const tradeId = get(cols.tradeId);
    // Derive the externalId from economic content when no stable tradeId is present.
    // Row-index fallbacks (`ibkr:${i}`) break re-import idempotency: if the export
    // gains or loses a leading row the index shifts and the dedup index no longer
    // matches, creating duplicate transactions.
    const externalId = tradeId
      ? `ibkr:${tradeId}`
      : `ibkr:${shortHash([symbol, action, executedAt, String(Math.abs(qty)), num(get(cols.price)), get(cols.currency) || "USD"].join("|"))}`;
    const parsed = parsedTransactionSchema.safeParse({
      assetClass,
      action,
      ticker: symbol || undefined,
      name: get(cols.description) || symbol || undefined,
      quantity: String(Math.abs(qty)),
      unit: assetClass === "crypto" ? "units" : "shares",
      price: num(get(cols.price)) || "0",
      fees: String(Math.abs(Number(num(get(cols.commission)) || "0"))),
      currency: get(cols.currency) || "USD",
      executedAt,
      externalId,
      confidence: 1,
    });
    if (parsed.success) drafts.push(parsed.data);
    else
      errors.push({
        line: i + 1,
        message: parsed.error.issues[0]?.message ?? "invalid row",
      });
  }

  return { drafts, errors };
}
