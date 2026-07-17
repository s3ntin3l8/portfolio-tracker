import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import { parseEuroDecimal, parseDkbDate } from "../dkb.js";
import { tryAddDraft, type ParserError } from "../shared.js";
import { TR_BUCHUNG_RE } from "./detect.js";

export interface TrPdfResult {
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
  accountNumber: string | null;
}

export function parseGerman(raw: string | null | undefined): string | null {
  return parseEuroDecimal(raw);
}

export function parseUs(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.replace(/[^\d.-]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toString() : null;
}

export function addMoney(...values: (string | null | undefined)[]): string {
  const cents = values.reduce((acc, v) => {
    const n = v == null ? null : parseFloat(v);
    return acc + (n == null || !Number.isFinite(n) ? 0 : Math.round(n * 100));
  }, 0);
  return (cents / 100).toFixed(2);
}

export function parseTrDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  const isoM = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoM) {
    const d = new Date(Date.UTC(Number(isoM[1]), Number(isoM[2]) - 1, Number(isoM[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseDkbDate(raw);
}

export function pushDraft(
  draft: Record<string, unknown>,
  drafts: ParsedTransaction[],
  errors: { line: number; message: string }[],
): void {
  const pe: ParserError[] = [];
  tryAddDraft(parsedTransactionSchema, draft, drafts, pe);
  for (const e of pe) {
    errors.push({ line: 1, message: e.issues[0]?.message ?? "invalid TR PDF" });
  }
}

export function extractBuchung(text: string): { date: Date | null; amountRaw: string | null } {
  const m = text.match(TR_BUCHUNG_RE);
  return { date: m ? parseTrDate(m[1]) : null, amountRaw: m?.[2] ?? null };
}
