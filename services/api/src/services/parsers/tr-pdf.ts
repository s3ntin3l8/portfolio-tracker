/**
 * Deterministic parser for Trade Republic settlement confirmation PDFs —
 * Wertpapierabrechnung (trade: buy/sell/savings_plan/saveback/roundup) and Dividende
 * (income: dividend). These are text PDFs, so unlike screenshots they parse exactly:
 * no LLM call, no billing, no data egress, CI-pinnable result.
 *
 * Called by the existing `POST /imports/screenshot` route when `detectTrPdf` gates it
 * in (the same pattern as `detectDkbPdf` for DKB), and by `enrichTransactionFromDrafts`
 * for the auto-enrichment path (settlement PDFs fetched during TR sync).
 *
 * TR PDF structure (confirmed against 10 real samples, 2025-2026):
 *  - Header: DATUM DD.MM.YYYY  AUFTRAG|ORDER <id>  AUSFÜHRUNG <id>  DEPOT <number>
 *    (ROUND UP / SAVEBACK / SPARPLAN docs have the sub-type id instead of AUFTRAG)
 *  - WERTPAPIERABRECHNUNG — trade settlements (buy / sell / savings_plan / saveback /
 *    roundup). Table columns: POSITION / ANZAHL / PREIS|DURCHSCHNITTSKURS / BETRAG.
 *    ABRECHNUNG table: Fremdkostenzuschlag (fee), Kapitalertragsteuer, Solidaritätszuschlag.
 *    BUCHUNG table: VERRECHNUNGSKONTO / WERTSTELLUNG YYYY-MM-DD / BETRAG.
 *  - DIVIDENDE (also WAHLDIVIDENDE, a cash-elected scrip dividend — same structure) —
 *    dividend income. US decimal locale (`.` as decimal). Table columns:
 *    POSITION / ANZAHL / ERTRAG / BETRAG, all in the instrument's native currency (any
 *    3-letter code, not just USD — this era of TR's template covers ~2024Q3 onward; an
 *    older, German-locale/`Stk.` template predates it and is not handled here).
 *    ABRECHNUNG: Quellensteuer für <country>-Emittenten (native currency), Zwischensumme
 *    (native, then its EUR conversion), Kapitalertragsteuer/-ssteuer, Solidaritätszuschlag,
 *    Kirchensteuer (all EUR). BUCHUNG: DATUM DER ZAHLUNG / BETRAG (EUR). `fxRate` is derived
 *    from the two Zwischensumme amounts (EUR ÷ native), not the printed ratio's label/direction.
 *
 * TR number locales (differ from DKB):
 *  - Trade PDFs: German decimal comma (`207,20 EUR`, `1.026,36 EUR`).
 *  - Dividend PDFs: US decimal (`0.459173 Stücke`, `0.02 USD`, `0.07 EUR`).
 *  - Leading-minus sign (`-1,00 EUR`) NOT trailing-minus (DKB convention).
 *
 * `detectTrPdf` is deliberately narrow — gates only on settlement confirmations that
 * bear tax/fee detail. Cost-information and order-confirmation docs return false.
 */

import { Decimal } from "decimal.js";
import { parsedTransactionSchema, type ParsedTransaction, type TaxComponents } from "@portfolio/schema";
import { parseEuroDecimal, parseDkbDate } from "./dkb.js";

export interface TrPdfResult {
  drafts: ParsedTransaction[];
  errors: { line: number; message: string }[];
  /** DEPOT account number from the PDF header. */
  accountNumber: string | null;
}

// Trade Republic header signature — present in all their settlement PDFs.
const TR_SIG_RE = /Trade Republic Bank GmbH|TRADE REPUBLIC BANK GMBH/;
// An ISIN with explicit label (trade PDFs): "ISIN: IE00B5BMR087".
const TR_ISIN_LABELED_RE = /ISIN:\s+([A-Z]{2}[A-Z0-9]{9}\d)/;
// Bare ISIN without label (dividend PDFs): embedded between name and quantity.
const BARE_ISIN_RE = /\b([A-Z]{2}[A-Z0-9]{9}\d)\b/;

/**
 * True when `text` is a Trade Republic settlement confirmation PDF (Wertpapierabrechnung
 * or Dividende). Cost-information and order-confirmation docs return false.
 *
 * Settlement trade: has WERTPAPIERABRECHNUNG + AUSFÜHRUNG (all 10 sample types).
 * Settlement dividend: has the word DIVIDENDE + Stücke (US qty notation for foreign shares).
 */
export function detectTrPdf(text: string): boolean {
  if (!TR_SIG_RE.test(text)) return false;
  // Trade settlement confirmation.
  if (/WERTPAPIERABRECHNUNG/.test(text) && /\bAUSFÜHRUNG\b/.test(text)) return true;
  // Dividend income confirmation. Also matches WAHLDIVIDENDE (scrip/choice-dividend paid in
  // cash — same structure) — a plain `\bDIVIDENDE\b` misses it because "WAHLDIVIDENDE" is one
  // unbroken token, so there's no word boundary directly before "DIVIDENDE".
  if (/\b(?:WAHL)?DIVIDENDE\b/.test(text) && /Stücke/.test(text)) return true;
  // Interest payout (Cash Zinsen) — "ABRECHNUNG ZINSEN" / "EINKOMMENSART ... ZINSEN".
  if (/ABRECHNUNG\s+ZINSEN/.test(text)) return true;
  // Tax-optimisation true-up (Steuerliche Optimierung — KapSt/Soli refund or charge).
  if (/STEUERLICHE OPTIMIERUNG/i.test(text)) return true;
  return false;
}

/** Collapse internal whitespace runs to single spaces and trim. */
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Parse a German-format decimal string (comma decimal, optional dot thousands).
 * Delegates to `parseEuroDecimal` from dkb.ts — they use the same format.
 */
function parseGerman(raw: string | null | undefined): string | null {
  return parseEuroDecimal(raw);
}

/**
 * Parse a US-format decimal string (dot decimal, optional comma thousands).
 * Used for dividend PDFs (USD amounts, US locale).
 */
function parseUs(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const s = raw.replace(/[^\d.-]/g, "");
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n.toString() : null;
}

/** Sum decimal-string amounts, propagating through null (missing = 0). */
function addMoney(...values: (string | null | undefined)[]): string {
  const cents = values.reduce((acc, v) => {
    const n = v == null ? null : parseFloat(v);
    return acc + (n == null || !Number.isFinite(n) ? 0 : Math.round(n * 100));
  }, 0);
  return (cents / 100).toFixed(2);
}

/**
 * Parse `DD.MM.YYYY` (German) as a UTC date — delegates to dkb.ts helper.
 * Also parses `YYYY-MM-DD` (ISO, used in BUCHUNG/WERTSTELLUNG rows).
 */
function parseTrDate(raw: string | null | undefined): Date | null {
  if (!raw) return null;
  // ISO date from BUCHUNG WERTSTELLUNG: "2026-02-25"
  const isoM = raw.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoM) {
    const d = new Date(Date.UTC(Number(isoM[1]), Number(isoM[2]) - 1, Number(isoM[3])));
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return parseDkbDate(raw);
}

function pushDraft(
  draft: Record<string, unknown>,
  drafts: ParsedTransaction[],
  errors: { line: number; message: string }[],
): void {
  const parsed = parsedTransactionSchema.safeParse(draft);
  if (parsed.success) drafts.push(parsed.data);
  else errors.push({ line: 1, message: parsed.error.issues[0]?.message ?? "invalid TR PDF" });
}

/**
 * Extract the BUCHUNG / payment line as a raw `{ date, amountRaw }`.
 *
 * The label varies across doc types (`WERTSTELLUNG`, `DATUM DER ZAHLUNG`,
 * `BUCHUNGSDATUM GUTSCHRIFT NACH STEUERN`) and an IBAN sits between the label and the
 * date, so we anchor on the layout-invariant `<IBAN> <date> <amount> EUR` tail. The date
 * is German `DD.MM.YYYY` (trade/dividend/interest/tax-opt) or ISO `YYYY-MM-DD` (some
 * round-up legs). The amount's locale differs per doc, so callers parse `amountRaw` with
 * the branch's own `parseGerman`/`parseUs`.
 */
const TR_BUCHUNG_RE =
  /(?:WERTSTELLUNG|DATUM DER ZAHLUNG|BUCHUNGSDATUM)[^]*?(\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2})\s+(-?[\d.,]+)\s+EUR/;
function extractBuchung(text: string): { date: Date | null; amountRaw: string | null } {
  const m = text.match(TR_BUCHUNG_RE);
  return { date: m ? parseTrDate(m[1]) : null, amountRaw: m?.[2] ?? null };
}

// ---------------------------------------------------------------------------
// Trade settlement parser (WERTPAPIERABRECHNUNG)
// ---------------------------------------------------------------------------

/**
 * Determine the action from the ÜBERSICHT description line.
 * TR uses German and English mixed in different formats.
 */
function tradeAction(text: string): { action: ParsedTransaction["action"]; kind: string | undefined } {
  // Check for special kinds first.
  if (/Sparplanausführung|SPARPLAN/.test(text)) {
    return { action: "savings_plan", kind: undefined };
  }
  if (/Saveback/.test(text)) {
    return { action: "buy", kind: "saveback" };
  }
  if (/Round[- ]?up/.test(text)) {
    return { action: "buy", kind: "roundup" };
  }
  // Standard market orders.
  if (/\bSELL\b|\bVerkauf\b/.test(text)) {
    return { action: "sell", kind: undefined };
  }
  if (/\bKauf\b|\bBUY\b/.test(text)) {
    return { action: "buy", kind: undefined };
  }
  return { action: "buy", kind: undefined }; // fallback
}

/**
 * Extract the venue (exchange / counterparty) from the ÜBERSICHT description.
 * TR always says "an der <venue>" or "bei <venue>".
 */
function extractVenue(text: string): string | undefined {
  // "an der Lang und Schwarz Exchange" / "an der Tradegate Exchange"
  const m =
    text.match(/an der ([A-Za-z &]+(?:Exchange|AG[^.]*)?)/)?.[1]?.trim() ??
    text.match(/bei ([A-Za-z &]+(?:AG|GmbH)[^.]*)\./)?.[1]?.trim();
  return m ? collapse(m) : undefined;
}

function parseTrTrade(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  // --- Header ---
  const depot = text.match(/\bDEPOT\s+(\d+)/)?.[1] ?? null;
  // Newer: AUFTRAG xxxx  Older: ORDER xxxx
  const orderRef =
    text.match(/\bAUFTRAG\s+([a-fA-F0-9-]+)/)?.[1] ??
    text.match(/\bORDER\s+([a-fA-F0-9-]+)/)?.[1] ??
    null;
  const ausfuehrung = text.match(/\bAUSFÜHRUNG\s+([a-fA-F0-9-]+)/)?.[1] ?? null;
  const headerDateStr = text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1];
  const headerDate = parseTrDate(headerDateStr);

  // --- Action from ÜBERSICHT ---
  const ubersichtM = text.match(
    /ÜBERSICHT\s+([\s\S]*?)(?=POSITION|ABRECHNUNG|BUCHUNG|$)/,
  )?.[1] ?? "";
  const { action, kind } = tradeAction(text + " " + ubersichtM);
  const venue = extractVenue(ubersichtM);

  // --- POSITION table ---
  // Format: "<name> ISIN: <isin> <qty> Stk. <price> EUR <total_gross> EUR"
  // DURCHSCHNITTSKURS (sparplan/saveback/roundup) and PREIS are the same column position.
  const isin = text.match(TR_ISIN_LABELED_RE)?.[1];
  // Name: the security name immediately precedes the labelled ISIN on the POSITION detail
  // row. Anchor on the LAST "BETRAG " before "ISIN:" (greedy prefix) so we land on the
  // position row, not the earlier "ABRECHNUNG POSITION BETRAG" column header that sell /
  // settlement docs print first (the old non-greedy match swallowed the whole block).
  let name: string | undefined;
  if (isin) {
    const m = text.match(new RegExp(`.*BETRAG\\s+([^:]{1,120}?)\\s*ISIN:\\s+${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }

  // Quantity (German decimal): "0,332223 Stk." or "9 Stk."
  const qtyM = text.match(/([0-9][0-9.,]*)\s+Stk\./);
  const quantity = parseGerman(qtyM?.[1]);

  // Per-share price + gross position total — the two EUR amounts after "<qty> Stk.":
  // "<qty> Stk. <price> EUR <gross> EUR". price = PREIS/DURCHSCHNITTSKURS, gross = BETRAG.
  let price: string | null = null;
  let gross: string | null = null;
  if (qtyM) {
    const afterQty = text.slice(text.indexOf(qtyM[0]) + qtyM[0].length);
    const euros = [...afterQty.matchAll(/([0-9][0-9.,]*)\s+EUR/g)].map((m) => m[1]);
    price = parseGerman(euros[0]);
    gross = parseGerman(euros[1]);
  }

  // --- ABRECHNUNG ---
  // Fremdkostenzuschlag: "-1,00 EUR" (leading minus = fee charged).
  const fremdkostenM = text.match(/Fremdkostenzuschlag\s+(-?[\d.,]+)\s+EUR/);
  const fees = fremdkostenM ? (parseGerman(fremdkostenM[1].replace("-", "")) ?? "0") : "0";

  // Tax component magnitudes (German decimal). The label may carry an "Optimierung"
  // qualifier (TR Steueroptimierung) and appears single- or double-s spelled.
  const taxLine = (label: string): string | null =>
    parseGerman(
      text
        .match(new RegExp(`${label}(?:\\s+Optimierung)?\\s+(-?[\\d.,]+)\\s+EUR`))?.[1]
        ?.replace("-", ""),
    );
  const kapst = taxLine("Kapitalertrags?steuer");
  const solz = taxLine("Solidaritätszuschlag");
  const kirche = taxLine("Kirchensteuer");

  // --- BUCHUNG (net credited / debited) ---
  const buchung = extractBuchung(text);
  const net = buchung.amountRaw ? parseGerman(buchung.amountRaw.replace(/^-/, "")) : undefined;
  const settlementDate = buchung.date ?? headerDate;

  // Tax. Normal sells itemise withholding (KapSt/Soli/Kirche) which is *subtracted* from the
  // proceeds, so the realised tax is their sum. A Steueroptimierung true-up instead *adds* a
  // refund (or adds a charge) — the components are signed the other way — so there the
  // realised tax follows from the cash identity gross − fees − net (signed), and we sign the
  // component breakdown to match. Buys carry no tax. (Dividends/interest: own branches.)
  const isOptimierung = /(?:Kapitalertrags?steuer|Solidaritätszuschlag)\s+Optimierung/.test(text);
  const compSum =
    (kapst ? Number(kapst) : 0) + (solz ? Number(solz) : 0) + (kirche ? Number(kirche) : 0);
  let tax: string | undefined;
  const taxComponents: TaxComponents = {};
  if (action === "sell" && isOptimierung) {
    const signed =
      gross != null && net != null ? Number(gross) - Number(fees) - Number(net) : -compSum;
    if (Math.abs(signed) >= 0.005) {
      tax = signed.toFixed(2);
      const sgn = signed < 0 ? -1 : 1;
      const sign = (v: string | null): string | null =>
        v && Number(v) > 0 ? (sgn * Number(v)).toFixed(2) : null;
      const k = sign(kapst);
      const s = sign(solz);
      const ki = sign(kirche);
      if (k) taxComponents.kapitalertragsteuer = k;
      if (s) taxComponents.solidaritaetszuschlag = s;
      if (ki) taxComponents.kirchensteuer = ki;
    }
  } else if (compSum > 0) {
    tax = compSum.toFixed(2);
    if (kapst && Number(kapst) > 0) taxComponents.kapitalertragsteuer = kapst;
    if (solz && Number(solz) > 0) taxComponents.solidaritaetszuschlag = solz;
    if (kirche && Number(kirche) > 0) taxComponents.kirchensteuer = kirche;
  }

  // externalId: keyed by AUSFÜHRUNG (per-leg idempotency).
  const externalId = ausfuehrung ? `tr:exec:${ausfuehrung}` : undefined;

  pushDraft(
    {
      action,
      kind: kind ?? undefined,
      isin: isin ?? undefined,
      name: name ?? undefined,
      quantity: quantity ?? "",
      unit: "shares" as const,
      price: price ?? "",
      // Per-share execution price — distinct from `price` so enrichment's
      // executedPrice column is populated (the rollup reads draft.executedPrice).
      executedPrice: price ?? undefined,
      fees,
      total: net ?? undefined,
      tax,
      taxComponents: Object.keys(taxComponents).length > 0 ? taxComponents : undefined,
      venue: venue ?? undefined,
      currency: "EUR",
      executedAt: settlementDate ?? undefined,
      externalId,
      orderRef: orderRef ?? undefined,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber: depot };
}

// ---------------------------------------------------------------------------
// Dividend income parser (DIVIDENDE)
// ---------------------------------------------------------------------------

function parseTrDividend(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const depot = text.match(/\bDEPOT\s+(\d+)/)?.[1] ?? null;
  const headerDateStr = text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1];
  const headerDate = parseTrDate(headerDateStr);

  // ISIN: bare (no label) in dividend docs, sitting between the name and the quantity.
  // Pattern: "<name> <ISIN_12> <qty> Stücke <perShare> <currency> <gross> <currency>"
  const isin = text.match(TR_ISIN_LABELED_RE)?.[1] ?? text.match(BARE_ISIN_RE)?.[1];

  // Name: everything before the bare ISIN (on the position line after BETRAG header).
  let name: string | undefined;
  if (isin) {
    const m = text.match(new RegExp(`BETRAG\\s+(.*?)${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }

  // POSITION line: "<qty> Stücke <perShare> <CCY> <grossNative> <CCY>" — any currency (the
  // instrument's native one; previously assumed to always be USD and discarded outright).
  // `shares`/`perShare`/`nativeCurrency`/`grossNative` are informational display fields —
  // `price` (net EUR credited) and `quantity` ("0") below keep their existing cash-flow
  // semantics unchanged, so core/holdings/reconciliation are unaffected.
  const posM = text.match(/([\d.]+)\s+Stücke\s+([\d.]+)\s+([A-Z]{3})\s+([\d.]+)\s+([A-Z]{3})/);
  const shares = posM ? parseUs(posM[1]) : null;
  const perShare = posM ? parseUs(posM[2]) : null;
  const nativeCcy = posM?.[3];
  const grossNativeAmt = posM ? parseUs(posM[4]) : null;

  // FX: derive EUR-per-<native> from the two Zwischensumme AMOUNTS (foreign net-of-withholding,
  // then its EUR equivalent) rather than trusting the printed "<rate> <CCY>/EUR" ratio's label
  // direction — the previous code stored that printed ratio (foreign-per-EUR) directly as
  // `fxRate`, the OPPOSITE convention used by every other import path (CSV/timeline store
  // EUR-per-foreign, matching the column's own "units of currency per foreign" doc comment).
  // Deriving from amounts also sidesteps needing the label's currency-pair order at all.
  const fxM = text.match(
    /Zwischensumme\s+([\d.]+)\s+[A-Z]{3}\s+Zwischensumme\s+[\d.]+\s+[A-Z]{3}\/EUR\s+([\d.]+)\s+EUR/,
  );
  const fxForeignNet = fxM ? parseUs(fxM[1]) : null;
  const fxEurNet = fxM ? parseUs(fxM[2]) : null;
  const fxRate =
    fxForeignNet && fxEurNet && Number(fxForeignNet) > 0
      ? new Decimal(fxEurNet).div(new Decimal(fxForeignNet)).toDecimalPlaces(6).toString()
      : null;

  // Only a genuinely foreign-currency payment has a meaningful native currency / FX rate —
  // a EUR-denominated dividend carries no Zwischensumme conversion line at all.
  const isForeign = Boolean(nativeCcy) && nativeCcy !== "EUR" && Boolean(fxRate);

  // Quellensteuer (source-country withholding), in the native currency: "Quellensteuer für
  // <country>-Emittenten -X.XX <CCY>" — previously hardcoded to USD only.
  // [\w-]+ matches the country specifier including hyphen (e.g. "US-Emittenten").
  const quellenM = text.match(/Quellensteuer für [\w-]+ -\s*([\d.]+)\s+([A-Z]{3})/);
  const quellenForeign = quellenM ? parseUs(quellenM[1]) : null;
  const quellenEur =
    quellenForeign && fxRate
      ? new Decimal(quellenForeign).mul(new Decimal(fxRate)).toDecimalPlaces(2).toString()
      : null;

  // Kapitalertragsteuer / Solidaritätszuschlag / Kirchensteuer are always printed already in
  // EUR; the "<rate> <CCY>/EUR" prefix only appears for foreign-currency dividends, so it's
  // optional here — a EUR-native dividend's tax lines have no such prefix at all. Spelling
  // varies across document eras (Kapitalertragsteuer / Kapitalertragssteuer).
  const taxLine = (label: string): string | null =>
    parseUs(
      text.match(
        new RegExp(`${label}(?:\\s+[\\d.]+\\s+[A-Z]{3}\\/EUR)?\\s+-\\s*([\\d.]+)\\s+EUR`),
      )?.[1],
    );
  const kapst = taxLine("Kapitalertrags?steuer");
  // Previously omitted entirely — a real undercount whenever a dividend actually carried a
  // Solidaritätszuschlag component (it does on at least some real US-withholding dividends).
  const soli = taxLine("Solidaritätszuschlag");
  const kirche = taxLine("Kirchensteuer");

  // Tax rollup.
  const tax =
    quellenEur || kapst || soli || kirche
      ? addMoney(quellenEur, kapst, soli, kirche)
      : undefined;
  const taxNum = tax ? Number(tax) : 0;

  const taxComponents: TaxComponents = {};
  if (quellenEur && Number(quellenEur) > 0) taxComponents.quellensteuer = quellenEur;
  if (kapst && Number(kapst) > 0) taxComponents.kapitalertragsteuer = kapst;
  if (soli && Number(soli) > 0) taxComponents.solidaritaetszuschlag = soli;
  if (kirche && Number(kirche) > 0) taxComponents.kirchensteuer = kirche;

  // Net EUR payout from the BUCHUNG line: "<IBAN> <DD.MM.YYYY|YYYY-MM-DD> <amount> EUR".
  // Real docs put `DATUM DER ZAHLUNG BETRAG <IBAN> <German-date> <amount>` — the old regex
  // expected an ISO date immediately after the label, so netEur was always null → the
  // dividend draft failed validation (price="") and was dropped. The amount is US-locale.
  const buchung = extractBuchung(text);
  const payDate = buchung.date ?? headerDate;
  const netEur = parseUs(buchung.amountRaw?.replace(/^-/, ""));

  // Gross = net + tax (same pattern as DKB dividend).
  const total = netEur && tax ? addMoney(netEur, tax) : (netEur ?? undefined);

  // For dividends we derive an idempotency key from available identifiers (no AUSFÜHRUNG).
  // "tr:div:<depot>:<isin>:<paydate>" — stable for same payer, instrument, and payment date.
  const payDateStr = payDate ? payDate.toISOString().slice(0, 10) : undefined;
  const externalId =
    depot && isin && payDateStr ? `tr:div:${depot}:${isin}:${payDateStr}` : undefined;

  pushDraft(
    {
      action: "dividend",
      isin: isin ?? undefined,
      name: name ?? undefined,
      quantity: "0",
      // price = net EUR credited (drives cashFlow, same convention as DKB dividends)
      price: netEur ?? "",
      total: total ?? undefined,
      tax: taxNum > 0 ? tax : undefined,
      taxComponents: Object.keys(taxComponents).length > 0 ? taxComponents : undefined,
      shares: shares ?? undefined,
      perShare: perShare ?? undefined,
      nativeCurrency: isForeign ? nativeCcy : undefined,
      grossNative: isForeign ? (grossNativeAmt ?? undefined) : undefined,
      fxRate: isForeign ? (fxRate ?? undefined) : undefined,
      currency: "EUR",
      executedAt: payDate ?? undefined,
      externalId,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber: depot };
}

// ---------------------------------------------------------------------------
// Interest payout parser (ABRECHNUNG ZINSEN — Cash Zinsen)
// ---------------------------------------------------------------------------

function parseTrInterest(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const account = text.match(/VERRECHNUNGSKONTO\s+(\d+)/)?.[1] ?? null;
  const headerDate = parseTrDate(text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]);

  // Tax (German decimal, double-s spelling on interest docs).
  const kapst = parseGerman(text.match(/Kapitalertrags?steuer\s+([\d.,]+)\s+EUR/)?.[1]);
  const solz = parseGerman(text.match(/Solidaritätszuschlag\s+([\d.,]+)\s+EUR/)?.[1]);
  const kapstNum = kapst ? Number(kapst) : 0;
  const solzNum = solz ? Number(solz) : 0;
  const taxNum = kapstNum + solzNum;
  const tax = taxNum > 0 ? taxNum.toFixed(2) : undefined;
  const taxComponents: TaxComponents = {};
  if (kapstNum > 0) taxComponents.kapitalertragsteuer = kapst!;
  if (solzNum > 0) taxComponents.solidaritaetszuschlag = solz!;

  // Net credited from BUCHUNG ("… GUTSCHRIFT NACH STEUERN <IBAN> <date> <amount> EUR").
  const buchung = extractBuchung(text);
  const payDate = buchung.date ?? headerDate;
  const net = parseGerman(buchung.amountRaw?.replace(/^-/, ""));
  // Gross interest (Besteuerungsgrundlage) → total; falls back to net + tax.
  const besteuerung = parseGerman(text.match(/Besteuerungsgrundlage\s+([\d.,]+)\s+EUR/)?.[1]);
  const total = besteuerung ?? (net && tax ? addMoney(net, tax) : (net ?? undefined));

  const payDateStr = payDate ? payDate.toISOString().slice(0, 10) : undefined;
  const externalId =
    account && payDateStr ? `tr:int:${account}:${payDateStr}` : undefined;

  pushDraft(
    {
      action: "interest",
      name: "Zinsen",
      quantity: "0",
      // price = net EUR credited (cashFlow convention, like dividends).
      price: net ?? "",
      total: total ?? undefined,
      tax: tax ?? undefined,
      taxComponents: Object.keys(taxComponents).length > 0 ? taxComponents : undefined,
      currency: "EUR",
      executedAt: payDate ?? undefined,
      externalId,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber: account };
}

// ---------------------------------------------------------------------------
// Tax-optimisation true-up parser (STEUERLICHE OPTIMIERUNG — KapSt/Soli refund or charge)
// ---------------------------------------------------------------------------

function parseTrTaxOptimization(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const depot = text.match(/\bDEPOT\s+(\d+)/)?.[1] ?? null;
  const headerDate = parseTrDate(text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1]);

  // Components are US-locale, signed: positive = refund (credit), negative = charge (debit).
  const kapstPdf = parseUs(text.match(/Kapitalertrags?steuer\s+(-?[\d.]+)\s+EUR/)?.[1]);
  const solzPdf = parseUs(text.match(/Solidaritätszuschlag\s+(-?[\d.]+)\s+EUR/)?.[1]);

  // BUCHUNG cashflow (signed): + = credited (refund), − = debited (charge).
  const buchung = extractBuchung(text);
  const cashflow = parseUs(buchung.amountRaw);
  const date = buchung.date ?? headerDate;

  // `tax` is the amount PAID (positive when money leaves you), i.e. the negated cashflow:
  // a refund (cash in) reduces the year's paid tax (negative); a charge (cash out) adds.
  const tax = cashflow != null ? (-Number(cashflow)).toFixed(2) : undefined;
  const taxComponents: TaxComponents = {};
  if (kapstPdf != null) taxComponents.kapitalertragsteuer = (-Number(kapstPdf)).toFixed(2);
  if (solzPdf != null) taxComponents.solidaritaetszuschlag = (-Number(solzPdf)).toFixed(2);

  // Refund (cash in) → deposit; charge (cash out) → withdrawal.
  const action = cashflow != null && Number(cashflow) < 0 ? "withdrawal" : "deposit";
  const dateStr = date ? date.toISOString().slice(0, 10) : undefined;
  const externalId = depot && dateStr ? `tr:taxopt:${depot}:${dateStr}` : undefined;

  pushDraft(
    {
      action,
      name: "Steuerliche Optimierung",
      quantity: "0",
      price: cashflow != null ? Math.abs(Number(cashflow)).toFixed(2) : "",
      tax: tax ?? undefined,
      taxComponents: Object.keys(taxComponents).length > 0 ? taxComponents : undefined,
      currency: "EUR",
      executedAt: date ?? undefined,
      externalId,
      confidence: 1,
    },
    drafts,
    errors,
  );

  return { drafts, errors, accountNumber: depot };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Parse a TR settlement confirmation PDF (trade, dividend, interest, or tax optimisation).
 * The caller has already called `detectTrPdf(text)` which guarantees we are in scope.
 */
export function parseTrPdf(rawText: string): TrPdfResult {
  const text = collapse(rawText);
  if (/STEUERLICHE OPTIMIERUNG/i.test(text)) return parseTrTaxOptimization(text);
  // Also routes WAHLDIVIDENDE (cash-elected scrip dividend) — see detectTrPdf's comment.
  if (/\b(?:WAHL)?DIVIDENDE\b/.test(text)) return parseTrDividend(text);
  if (/ABRECHNUNG ZINSEN/.test(text)) return parseTrInterest(text);
  return parseTrTrade(text);
}
