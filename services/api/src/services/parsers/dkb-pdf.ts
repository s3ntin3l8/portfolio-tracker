import { parsedTransactionSchema, type ParsedTransaction } from "@portfolio/schema";
import { parseEuroDecimal, parseDkbDate } from "./dkb.js";

/**
 * Deterministic parser for DKB (Deutsche Kreditbank) single-document securities PDFs —
 * the per-trade / per-income settlement notes (Wertpapierabrechnung, Dividendengutschrift,
 * Ausschüttung Investmentfonds). These are text PDFs, so unlike screenshots they parse
 * exactly with no LLM call, no billing, no data egress, and a CI-pinnable result.
 *
 * The caller extracts the PDF text (via `unpdf`) and hands the flattened, space-joined
 * stream here. `detectDkbPdf` gates whether this path applies; non-DKB PDFs fall back to
 * the vision parser. Everything is EUR-booked; German conventions (decimal comma, `€`
 * suffix, `DD.MM.YYYY`) are handled by the shared `dkb.ts` helpers.
 *
 * Document families recognised:
 *  - **Trade** ("Wertpapier Abrechnung Kauf/Ausgabe/Verkauf/Rücknahme"): buy / sell /
 *    savings_plan, with Ausführungskurs → price, Provision → fees, Ausmachender Betrag →
 *    total (settlement).
 *  - **Income** ("Dividendengutschrift" / "Ausschüttung Investmentfonds"): dividend, with
 *    the NET "Ausmachender Betrag" → price (drives cashFlow), withheld tax → tax, and the
 *    gross derived as net + tax → total. A foreign Devisenkurs → fxRate.
 */

export interface DkbPdfResult {
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
  accountNumber: string | null;
}

const ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;
// A DKB-specific signature (their BLZ / BIC) so we never claim a non-DKB broker's PDF.
const DKB_SIG_RE = /BYLADEM1001|BLZ\s*120\s*300\s*00|BLZ\s*12030000/;
const DOC_TYPE_RE = /Dividendengutschrift|Ausschüttung Investmentfonds|Wertpapier\s+Abrechnung/;

/** True when `text` is a recognised DKB securities settlement PDF this parser can handle. */
export function detectDkbPdf(text: string): boolean {
  return DKB_SIG_RE.test(text) && DOC_TYPE_RE.test(text);
}

/** Collapse internal whitespace runs to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** Sum decimal-string money values without float drift (cent integer math). */
function addMoney(...values: (string | null | undefined)[]): string {
  const cents = values.reduce((sum, v) => {
    const n = v == null ? null : parseEuroDecimal(v);
    return sum + (n == null ? 0 : Math.round(Number(n) * 100));
  }, 0);
  return (cents / 100).toFixed(2);
}

/** First numeric token following `label`, stopping before its trailing +/- sign and `EUR`. */
function amountAfter(text: string, label: string): string | null {
  const re = new RegExp(`${label}\\s+([\\d.,]+)\\s*[+-]?\\s*EUR`);
  return parseEuroDecimal(text.match(re)?.[1]);
}

/**
 * A withheld-tax amount: `<label> … <number>- EUR` (trailing minus = real deduction).
 * `gap: true` allows tokens between the label and its amount (e.g. "Einbehaltene
 * Quellensteuer 15 % auf 0,91 USD 0,12- EUR"); `gap: false` requires the number to follow
 * the label directly, so "Kapitalertragsteuer**pflichtige** … 0,77 - EUR" (a base/allowance
 * line, not a deduction) is NOT mistaken for withheld tax.
 */
function deductedAfter(text: string, label: string, gap = false): string | null {
  const re = new RegExp(`${label}\\s+${gap ? "(?:[^E]*?\\s)?" : ""}([\\d.,]+)\\s*-\\s*EUR`);
  return parseEuroDecimal(text.match(re)?.[1]);
}

/** Pull the security identity: name (between Stück <qty> and the ISIN), ISIN, WKN. */
function extractSecurity(text: string): { name?: string; isin?: string; wkn?: string; quantity?: string } {
  const isin = text.match(ISIN_RE)?.[1];
  const wkn = isin ? text.match(new RegExp(`${isin}\\s*\\(([0-9A-Z]{6})\\)`))?.[1] : undefined;
  const quantity = parseEuroDecimal(text.match(/St(?:ü|ue)ck\s+([\d.,]+)/)?.[1]) ?? undefined;
  let name: string | undefined;
  if (isin) {
    const m = text.match(new RegExp(`St(?:ü|ue)ck\\s+[\\d.,]+\\s+(.*?)\\s+${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }
  return { name: name || undefined, isin, wkn, quantity };
}

function pushDraft(
  draft: Record<string, unknown>,
  drafts: ParsedTransaction[],
  errors: { line: number; message: string }[],
): void {
  const parsed = parsedTransactionSchema.safeParse(draft);
  if (parsed.success) drafts.push(parsed.data);
  else errors.push({ line: 1, message: parsed.error.issues[0]?.message ?? "invalid DKB PDF" });
}

export function parseDkbPdf(rawText: string): DkbPdfResult {
  const text = collapse(rawText);
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const accountNumber = text.match(/Depotnummer\s+(\d+)/)?.[1] ?? null;
  const docDate = parseDkbDate(text.match(/\bDatum\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]);
  const { name, isin, wkn, quantity } = extractSecurity(text);

  const isIncome = /Dividendengutschrift|Ausschüttung Investmentfonds/.test(text);

  if (isIncome) {
    // NET amount credited drives the cash flow; gross = net + withheld tax (self-consistent).
    // `tax` is informational (display-only; cashFlow never subtracts it) and tuned to the
    // common case where German KapSt is absorbed by the Sparer-Pauschbetrag (so the only
    // withholding is foreign Quellensteuer). A doc with actually-withheld KapSt/SolZ may
    // under-report `tax`, but `price` (the directly-parsed Ausmachender Betrag) stays correct.
    const net = amountAfter(text, "Ausmachender Betrag");
    const quellensteuer = deductedAfter(text, "Einbehaltene Quellensteuer", true);
    const kapst = deductedAfter(text, "\\bKapitalertragsteuer");
    const solz = deductedAfter(text, "Solidaritätszuschlag");
    const tax = addMoney(quellensteuer, kapst, solz);
    const total = addMoney(net, tax);
    const fxRate = parseEuroDecimal(
      text.match(/Devisenkurs\s+[A-Z]{3}\s*\/\s*[A-Z]{3}\s+([\d.,]+)/)?.[1],
    );
    const valueDate =
      parseDkbDate(text.match(/Wertstellung\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]) ?? docDate;
    const belegnr = text.match(/Abrechnungsnr\.\s+(\d+)/)?.[1];
    pushDraft(
      {
        assetClass: /Ausschüttung Investmentfonds/.test(text) ? "etf" : "equity",
        action: "dividend",
        isin,
        wkn,
        name,
        quantity: "0",
        price: net ?? "",
        total,
        tax: Number(tax) > 0 ? tax : undefined,
        fxRate: fxRate ?? undefined,
        currency: "EUR",
        executedAt: valueDate ?? undefined,
        externalId: belegnr ? `dkb:${belegnr}` : undefined,
        confidence: 1,
      },
      drafts,
      errors,
    );
    return { drafts, errors, accountNumber };
  }

  // Trade: Wertpapier Abrechnung (Kauf / Ausgabe / Verkauf / Rücknahme).
  const isSell = /Verkauf|Rücknahme/.test(text);
  const isSavingsPlan = /Sparplan/.test(text); // "ETF-Sparplan" / "Wertpapier-Sparplan"
  const action = isSell ? "sell" : isSavingsPlan ? "savings_plan" : "buy";
  // ETFs/funds vs single equities — instrument resolution refines this later via OpenFIGI.
  const assetClass = /\bETF\b/.test(name ?? "")
    ? "etf"
    : /Investmentfonds|Fonds/.test(text)
      ? "mutual_fund"
      : "equity";
  const price = parseEuroDecimal(text.match(/Ausführungskurs\s+([\d.,]+)\s*EUR/)?.[1]);
  const fees = amountAfter(text, "Provision") ?? "0";
  const total = amountAfter(text, "Ausmachender Betrag");
  const tradeDate =
    parseDkbDate(text.match(/Schlusstag(?:\/-?Zeit)?\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]) ?? docDate;
  // venue: prefer the named counterparty, else the execution venue.
  const venue =
    collapse(text.match(/Handelspartner\s+(.+?)\s+(?:Schlusstag|Auftraggeber|Auftragserteilung)/)?.[1] ?? "") ||
    collapse(text.match(/Gegenpartei bei diesem Geschäft war\s+(.+?)\s+(?:ABR|Ihr|Die|Sofern)/)?.[1] ?? "") ||
    collapse(
      text.match(/Handels-\/Ausführungsplatz\s+(.+?)\s+(?:Handelspartner|Handelszeit|Schlusstag|Auftraggeber|Gegenpartei|Kurswert)/)?.[1] ?? "",
    );
  const auftrag = text.match(/Auftragsnummer\s+(\S+)/)?.[1];
  const externalId = auftrag ? `dkb:${auftrag.replace(/\D/g, "")}` : undefined;

  pushDraft(
    {
      assetClass,
      action,
      isin,
      wkn,
      name,
      quantity: quantity ?? "",
      unit: "shares",
      price: price ?? "",
      fees,
      total: total ?? undefined,
      venue: venue || undefined,
      currency: "EUR",
      executedAt: tradeDate ?? undefined,
      externalId,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber };
}
