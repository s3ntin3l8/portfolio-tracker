import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";

// Expected header (order-independent):
//   date,action,assetClass,ticker,name,quantity,unit,price,fees,currency
export interface CsvParseResult {
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
  /**
   * Account identifier embedded in the file (IBAN / depot number), when the format
   * exposes one. Used for portfolio auto-detect and the account-mismatch warning.
   * Most CSV formats don't carry one — left undefined there.
   */
  accountNumber?: string | null;
}

/**
 * Parse a generic transaction CSV into draft transactions. Each valid row becomes
 * a draft (confidence 1); invalid rows are collected as errors rather than failing
 * the whole import. Quoted fields with embedded commas are out of scope for now.
 */
export function parseCsv(content: string): CsvParseResult {
  const lines = content
    .trim()
    .split(/\r?\n/)
    .filter((l) => l.trim().length > 0);

  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];
  if (lines.length < 2) return { drafts, errors };

  const header = lines[0].split(",").map((h) => h.trim().toLowerCase());
  const col = (cols: string[], name: string) => {
    const i = header.indexOf(name);
    return i >= 0 ? (cols[i]?.trim() ?? "") : "";
  };

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    const parsed = parsedTransactionSchema.safeParse({
      assetClass: col(cols, "assetclass"),
      action: col(cols, "action"),
      ticker: col(cols, "ticker") || undefined,
      name: col(cols, "name") || undefined,
      quantity: col(cols, "quantity"),
      unit: col(cols, "unit"),
      price: col(cols, "price"),
      fees: col(cols, "fees") || "0",
      currency: col(cols, "currency"),
      executedAt: col(cols, "date"),
      confidence: 1,
    });
    if (parsed.success) {
      drafts.push(parsed.data);
    } else {
      errors.push({ line: i + 1, message: parsed.error.issues[0]?.message ?? "invalid row" });
    }
  }

  return { drafts, errors };
}
