import { parsedTransactionSchema, type ParsedAction } from "@portfolio/schema";
import type { CsvParseResult } from "./csv.js";
import { splitCsvLine } from "./csv-line.js";

// Coinbase "Transaction history" CSV. The real export carries a preamble before the
// header row, which contains "Quantity Transacted" and a spot-price column. Only Buy
// and Sell rows become trades; transfers/converts/rewards are skipped.

const ACTIONS: Record<string, ParsedAction> = {
  buy: "buy",
  "advanced trade buy": "buy",
  sell: "sell",
  "advanced trade sell": "sell",
};

function num(raw: string): string {
  return raw.replace(/[^0-9.-]/g, "");
}

export function parseCoinbase(content: string): CsvParseResult {
  const lines = content.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const drafts: CsvParseResult["drafts"] = [];
  const errors: CsvParseResult["errors"] = [];

  const headerIdx = lines.findIndex((l) => /Quantity Transacted/i.test(l));
  if (headerIdx < 0) return { drafts, errors };

  const header = splitCsvLine(lines[headerIdx]).map((h) => h.toLowerCase());
  const find = (re: RegExp) => header.findIndex((h) => re.test(h));
  const cols = {
    when: find(/timestamp/),
    type: find(/transaction type/),
    asset: find(/^asset$/),
    qty: find(/quantity transacted/),
    currency: find(/spot price currency/),
    price: find(/(spot )?price at transaction/),
    fees: find(/fees/),
  };

  for (let i = headerIdx + 1; i < lines.length; i++) {
    const c = splitCsvLine(lines[i]);
    const get = (j: number) => (j >= 0 ? (c[j] ?? "") : "");
    const action = ACTIONS[get(cols.type).toLowerCase()];
    if (!action) continue; // skip Send/Receive/Convert/Rewards/etc.

    const asset = get(cols.asset);
    const parsed = parsedTransactionSchema.safeParse({
      assetClass: "crypto",
      action,
      ticker: asset || undefined,
      name: asset || undefined,
      quantity: num(get(cols.qty)),
      unit: "units",
      price: num(get(cols.price)) || "0",
      fees: num(get(cols.fees)) || "0",
      currency: get(cols.currency) || "USD",
      executedAt: get(cols.when),
      externalId: `coinbase:${get(cols.when)}:${asset}:${i}`,
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
