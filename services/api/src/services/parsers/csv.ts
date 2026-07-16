import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import { tryAddDraft, type ParserError } from "./shared.js";

// Expected header (order-independent):
//   date,action,assetClass,ticker,name,quantity,unit,price,fees,currency

/**
 * A rejected / not-directly-mappable row surfaced to the user instead of being silently
 * dropped. A bare `{ line, message }` renders as an ignorable note in the review screen.
 * Adding `severity: "attention"` + a truthy `eventId` + `eventType` (and ideally `raw`)
 * promotes it to a *mappable* row — the user can turn it into a transaction via the same
 * map-issue editor used for Trade Republic sync issues. Structurally a superset of
 * `@portfolio/schema`'s `ImportIssue`, so it flows over the wire unchanged.
 */
export interface CsvParseIssue {
  line?: number;
  message: string;
  severity?: "info" | "attention";
  eventId?: string;
  eventType?: string;
  raw?: {
    isin?: string | null;
    name?: string | null;
    currency?: string | null;
    executedAt?: string | null;
    amount?: number | null;
    shares?: number | null;
  };
}

export interface CsvParseResult {
  drafts: ParsedTransaction[];
  errors: CsvParseIssue[];
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
    const draft: Record<string, unknown> = {
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
    };
    const pe: ParserError[] = [];
    tryAddDraft(parsedTransactionSchema, draft, drafts, pe);
    for (const e of pe) {
      errors.push({ line: i + 1, message: e.issues[0]?.message ?? "invalid row" });
    }
  }

  return { drafts, errors };
}
