import { Decimal } from "decimal.js";
import { parsedTransactionSchema, type ParsedTransaction, type TaxComponents } from "@portfolio/schema";
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
// One merger leg: "<Ausbuchung|Einbuchung> Stück <qty>-? <name> <ISIN> (<WKN>)" — captures
// quantity, name, ISIN and WKN. The optional trailing "-" appears on the Ausbuchung quantity.
const MERGER_LEG_RE = (label: string) =>
  new RegExp(
    `${label}\\s+St(?:ü|ue)ck\\s+([\\d.,]+)-?\\s+(.*?)\\s+([A-Z]{2}[A-Z0-9]{9}\\d)\\s*\\(([0-9A-Z]{6})\\)`,
  );
// A DKB-specific signature (their BLZ / BIC) so we never claim a non-DKB broker's PDF.
const DKB_SIG_RE = /BYLADEM1001|BLZ\s*120\s*300\s*00|BLZ\s*12030000/;
const DOC_TYPE_RE = /Dividendengutschrift|Ausschüttung Investmentfonds|Wertpapier\s+Abrechnung/;

/**
 * A taxable Kapitalmaßnahme — Fondsverschmelzung (fund merger / ISIN change) **confirmation**
 * ("Umbuchung"): it carries both legs (Ausbuchung/Einbuchung) and a Kurswert. The earlier
 * *announcement* (no Ausbuchung/Einbuchung/Kurswert — "Umtauschverhältnis noch nicht
 * veröffentlicht") is deliberately NOT matched, as it can't produce the merged-in quantity.
 * These letters carry no BLZ/BIC signature, so we gate on a DKB-specific field combination.
 */
function isMergerDoc(text: string): boolean {
  return (
    /Kapitalmaßnahme/.test(text) &&
    /verschmelzung/i.test(text) && // "Fondsverschmelzung" (compound → lowercase v)
    /Ausbuchung/.test(text) &&
    /Einbuchung/.test(text) &&
    /Kurswert/.test(text) &&
    /Depotnummer/.test(text)
  );
}

/** True when `text` is a recognised DKB securities settlement / corporate-action PDF. */
export function detectDkbPdf(text: string): boolean {
  return (DKB_SIG_RE.test(text) && DOC_TYPE_RE.test(text)) || isMergerDoc(text);
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

  // Kapitalmaßnahme — taxable Fondsverschmelzung (ISIN change): the old instrument is
  // ausgebucht (a `sell`) and the new one eingebucht (a `buy`), both `kind:"merger"`, priced
  // at the doc's Kurswert (deemed market value). The basis steps up to Kurswert and the gain
  // realizes against the old position's existing buys; `kind:"merger"` keeps contributions
  // neutral (see the merger feature). The pair flows through the normal import-review pipeline.
  if (isMergerDoc(text)) {
    const out = text.match(MERGER_LEG_RE("Ausbuchung"));
    const inb = text.match(MERGER_LEG_RE("Einbuchung"));
    const kurswert = amountAfter(text, "Kurswert");
    const outQty = parseEuroDecimal(out?.[1]);
    const inQty = parseEuroDecimal(inb?.[1]);
    const valuta = parseDkbDate(text.match(/Valuta\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]) ?? docDate;
    const belegnr = text.match(/Belegnummer\s+(\d+)/)?.[1];

    if (!out || !inb || kurswert == null || outQty == null || inQty == null) {
      errors.push({ line: 1, message: "incomplete DKB Kapitalmaßnahme (merger) document" });
      return { drafts, errors, accountNumber };
    }

    const value = new Decimal(kurswert);
    const leg = (
      side: "out" | "in",
      m: RegExpMatchArray,
      qty: string,
      price: string,
    ) =>
      pushDraft(
        {
          assetClass: /\bETF\b/.test(m[2]) ? "etf" : /Fonds/.test(m[2]) ? "mutual_fund" : "equity",
          action: side === "out" ? "sell" : "buy",
          isin: m[3],
          wkn: m[4],
          name: collapse(m[2]) || undefined,
          quantity: qty,
          unit: "shares",
          price,
          fees: "0",
          total: kurswert,
          currency: "EUR",
          kind: "merger",
          executedAt: valuta ?? undefined,
          externalId: belegnr ? `dkb:merger:${belegnr}:${side}` : undefined,
          confidence: 1,
        },
        drafts,
        errors,
      );
    leg("out", out, outQty, value.div(outQty).toFixed(8));
    leg("in", inb, inQty, value.div(inQty).toFixed(8));
    return { drafts, errors, accountNumber };
  }

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
    const kirche = deductedAfter(text, "Kirchensteuer");
    const tax = addMoney(quellensteuer, kapst, solz, kirche);
    const total = addMoney(net, tax);
    // Build per-component breakdown (preserved instead of discarded).
    const incomeTaxComponents: TaxComponents = {};
    if (quellensteuer && Number(quellensteuer) > 0) incomeTaxComponents.quellensteuer = quellensteuer;
    if (kapst && Number(kapst) > 0) incomeTaxComponents.kapitalertragsteuer = kapst;
    if (solz && Number(solz) > 0) incomeTaxComponents.solidaritaetszuschlag = solz;
    if (kirche && Number(kirche) > 0) incomeTaxComponents.kirchensteuer = kirche;
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
        taxComponents: Object.keys(incomeTaxComponents).length > 0 ? incomeTaxComponents : undefined,
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
  // Bond accrued interest (Stückzinsen) — a cost component, not exactly a tax, but
  // stored in taxComponents for display/provenance. Appears on bond buy/sell PDFs.
  const stueckzinsen = deductedAfter(text, "Stückzinsen");
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

  const tradeTaxComponents: TaxComponents = {};
  if (stueckzinsen && Number(stueckzinsen) > 0) tradeTaxComponents.stueckzinsen = stueckzinsen;

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
      taxComponents: Object.keys(tradeTaxComponents).length > 0 ? tradeTaxComponents : undefined,
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
