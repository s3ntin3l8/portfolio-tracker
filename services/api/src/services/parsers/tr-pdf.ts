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
 *  - DIVIDENDE (also WAHLDIVIDENDE, a cash-elected scrip dividend, and AUSSCHÜTTUNG, a
 *    fund/ETF distribution — no "DIVIDENDE" keyword at all — same structure) — dividend
 *    income, in TWO template eras with different quantity word + decimal locale:
 *      - ~2024Q3 onward: `Stücke`, US decimal locale (`.` as decimal).
 *      - pre-2024Q3: `Stk.` (abbreviated), German decimal locale (`,` as decimal), and the
 *        ISIN is *labeled* (`ISIN: <code>`) rather than bare. Also has two coexisting
 *        section orderings (POSITION-table-first-then-ABRECHNUNG, or the reverse) and a
 *        singular/plural Quellensteuer issuer label ("US-Emittent" / "US-Emittenten") —
 *        none of which matter to the regexes below, which search for each field
 *        independently rather than relying on section order.
 *    Table columns: POSITION / ANZAHL / ERTRAG / BETRAG, all in the instrument's native
 *    currency (any 3-letter code, not just USD). ABRECHNUNG: Quellensteuer für
 *    <country>-Emittent(en) (native currency), Zwischensumme (native, then its EUR
 *    conversion), Kapitalertragsteuer/-ssteuer, Solidaritätszuschlag, Kirchensteuer (all
 *    EUR). BUCHUNG: DATUM DER ZAHLUNG / WERTSTELLUNG / BETRAG. `fxRate` is derived from the
 *    two Zwischensumme amounts (EUR ÷ native), not the printed ratio's label/direction —
 *    which also sidesteps the two eras printing the pair in opposite orders (`<CCY>/EUR`
 *    vs `EUR/<CCY>`).
 *
 * TR number locales (differ from DKB):
 *  - Trade PDFs: German decimal comma (`207,20 EUR`, `1.026,36 EUR`).
 *  - Dividend PDFs: German locale pre-2024Q3 (`2,13 EUR`), US decimal from ~2024Q3 onward
 *    (`0.459173 Stücke`, `0.02 USD`, `0.07 EUR`) — detected per-document from the quantity
 *    word (`Stücke` ⟹ US locale, `Stk.` ⟹ German locale), since both eras coexist in a
 *    single account's history and must each be parsed with their own decimal convention.
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
 * Settlement dividend: has the word DIVIDENDE (or WAHLDIVIDENDE/AUSSCHÜTTUNG) + a quantity
 * marker (Stücke — US-locale era — or Stk. — German-locale, pre-2024Q3, era).
 *
 * Explicitly EXCLUDED (real docs, discovered via the historical backfill): a dividend
 * cancellation ("STORNIERUNG DER DIVIDENDE ...") or a US-REIT tax reclassification
 * ("REKLASSIFIZIERUNG US-AUSSCHÜTTUNGEN ...") of an *earlier* payment — not a fresh income
 * event. These carry negative POSITION/BUCHUNG amounts that `parseTrDividend` isn't
 * sign-aware for (it strips a leading "-" before parsing, which would turn a reversal into
 * a same-sized positive credit), and in practice several conflicting STORNIERUNG/
 * REKLASSIFIZIERUNG documents can be linked to a single transaction — there's no reliable
 * "the" per-share/native/fx to pick even if the sign were handled. Safer to not parse them
 * at all; the pytr sync's own net cash-flow for these transactions is left untouched.
 */
export function detectTrPdf(text: string): boolean {
  if (!TR_SIG_RE.test(text)) return false;
  // Trade settlement confirmation.
  if (/WERTPAPIERABRECHNUNG/.test(text) && /\bAUSFÜHRUNG\b/.test(text)) return true;
  // A dividend cancellation or US-REIT reclassification of a prior payment — see the
  // module doc comment above. Excluded from both dividend branches below (not a top-level
  // guard: a trade-settlement STORNIERUNG, if TR ever prints one, should still be free to
  // hit the WERTPAPIERABRECHNUNG branch above).
  const isCorrection = /STORNIERUNG DER DIVIDENDE|REKLASSIFIZIERUNG/.test(text);
  // Dividend income confirmation, ~2024Q3 onward (US locale, Stücke). Also matches
  // WAHLDIVIDENDE (scrip/choice-dividend paid in cash — same structure) — a plain
  // `\bDIVIDENDE\b` misses it because "WAHLDIVIDENDE" is one unbroken token, so there's no
  // word boundary directly before "DIVIDENDE".
  if (/\b(?:WAHL)?DIVIDENDE\b/.test(text) && /Stücke/.test(text) && !isCorrection) return true;
  // Dividend/distribution income confirmation, pre-2024Q3 (German locale, Stk.). Also
  // matches AUSSCHÜTTUNG (fund/ETF distribution) documents, which carry no "DIVIDENDE"
  // keyword at all. The `!WERTPAPIERABRECHNUNG` guard is belt-and-suspenders — trade docs
  // also use "Stk." for share quantity, though they never carry DIVIDENDE/AUSSCHÜTTUNG.
  if (
    !isCorrection &&
    /\b(?:WAHL)?DIVIDENDE\b|\bAUSSCHÜTTUNG\b/.test(text) &&
    /Stk\./.test(text) &&
    !/WERTPAPIERABRECHNUNG/.test(text)
  ) {
    return true;
  }
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

  // Decimal locale differs by era: ~2024Q3 onward is US locale (`Stücke`, `.` decimal);
  // pre-2024Q3 is German locale (`Stk.`, `,` decimal). Detected once per document and used
  // for every numeric field below — mixing them up silently corrupts amounts (e.g. parsing
  // the German "2,13" with the US parser strips the comma and yields "213").
  const isGermanLocale = !/Stücke/.test(text);
  const parseNum = isGermanLocale ? parseGerman : parseUs;
  const qtyWord = isGermanLocale ? "Stk\\." : "Stücke";
  // Permissive class: captures raw digits/separators in either locale; `parseNum` above
  // interprets them. Never used to pick the locale itself (that's `isGermanLocale`).
  const NUM = "[\\d.,]+";

  // ISIN: labeled ("ISIN: <code>", pre-2024Q3) or bare (no label, ~2024Q3 onward), sitting
  // between the name and the quantity.
  const isin = text.match(TR_ISIN_LABELED_RE)?.[1] ?? text.match(BARE_ISIN_RE)?.[1];

  // Name: precedes the ISIN on the position line, after a "BETRAG" column header. The
  // {1,120} bound on the labeled form is deliberate — it makes the (non-greedy) match skip
  // past earlier, irrelevant "BETRAG" occurrences (ABRECHNUNG/BUCHUNG column headers) that
  // sit much further from "ISIN:" than the real position row, mirroring parseTrTrade's same
  // anchor. The bare form (no "ISIN:" literal in the text at all) is the ~2024Q3+ shape.
  let name: string | undefined;
  if (isin) {
    const labeledM = text.match(new RegExp(`BETRAG\\s+([^:]{1,120}?)\\s*ISIN:\\s+${isin}`));
    const m = labeledM ?? text.match(new RegExp(`BETRAG\\s+(.*?)${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }

  // POSITION line: "<qty> Stücke|Stk. <perShare> <CCY> <grossNative> <CCY>" — any currency
  // (the instrument's native one). `shares`/`perShare`/`nativeCurrency`/`grossNative` are
  // informational display fields — `price` (net EUR credited) and `quantity` ("0") below
  // keep their existing cash-flow semantics unchanged, so core/holdings/reconciliation are
  // unaffected.
  const posM = text.match(
    new RegExp(`(${NUM})\\s+${qtyWord}\\s+(${NUM})\\s+([A-Z]{3})\\s+(${NUM})\\s+([A-Z]{3})`),
  );
  const shares = posM ? parseNum(posM[1]) : null;
  const perShare = posM ? parseNum(posM[2]) : null;
  const nativeCcy = posM?.[3];
  const grossNativeAmt = posM ? parseNum(posM[4]) : null;

  // FX: derive EUR-per-<native> from the two Zwischensumme AMOUNTS (foreign net-of-withholding,
  // then its EUR equivalent) rather than trusting the printed ratio's label/direction — the
  // pair order flips between eras (`<CCY>/EUR` from ~2024Q3, `EUR/<CCY>` pre-2024Q3), so a
  // label-trusting parse would store the reciprocal for half the account's history. Amounts
  // don't have that ambiguity, and the [A-Z]{3}/[A-Z]{3} class below doesn't care which order
  // the pair prints in either way.
  const fxM = text.match(
    new RegExp(`Zwischensumme\\s+(${NUM})\\s+[A-Z]{3}\\s+Zwischensumme\\s+${NUM}\\s+[A-Z]{3}\\/[A-Z]{3}\\s+(${NUM})\\s+EUR`),
  );
  const fxForeignNet = fxM ? parseNum(fxM[1]) : null;
  const fxEurNet = fxM ? parseNum(fxM[2]) : null;
  const fxRate =
    fxForeignNet && fxEurNet && Number(fxForeignNet) > 0
      ? new Decimal(fxEurNet).div(new Decimal(fxForeignNet)).toDecimalPlaces(6).toString()
      : null;

  // Only a genuinely foreign-currency payment has a meaningful native currency / FX rate —
  // a EUR-denominated dividend carries no Zwischensumme conversion line at all.
  const isForeign = Boolean(nativeCcy) && nativeCcy !== "EUR" && Boolean(fxRate);

  // Quellensteuer (source-country withholding), in the native currency: "Quellensteuer für
  // <country>-Emittent(en) -X,XX/-X.XX <CCY>" — issuer label is singular pre-2024Q3
  // ("US-Emittent"), plural from ~2024Q3 ("US-Emittenten"); [\w-]+ matches either.
  const quellenM = text.match(new RegExp(`Quellensteuer für [\\w-]+ -\\s*(${NUM})\\s+([A-Z]{3})`));
  const quellenForeign = quellenM ? parseNum(quellenM[1]) : null;
  const quellenEur =
    quellenForeign && fxRate
      ? new Decimal(quellenForeign).mul(new Decimal(fxRate)).toDecimalPlaces(2).toString()
      : null;

  // Kapitalertragsteuer / Solidaritätszuschlag / Kirchensteuer are always printed already in
  // EUR; the "<rate> <CCY>/<CCY>" prefix only appears for foreign-currency dividends, so it's
  // optional here — a EUR-native dividend's tax lines have no such prefix at all. Spelling
  // varies across document eras (Kapitalertragsteuer / Kapitalertragssteuer).
  const taxLine = (label: string): string | null =>
    parseNum(
      text.match(
        new RegExp(`${label}(?:\\s+${NUM}\\s+[A-Z]{3}\\/[A-Z]{3})?\\s+-\\s*(${NUM})\\s+EUR`),
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
  // Real docs put `DATUM DER ZAHLUNG|WERTSTELLUNG BETRAG <IBAN> <German-date> <amount>` — the
  // amount's own decimal locale matches the document's era, so it's parsed with `parseNum`
  // (not unconditionally US-locale, which corrupted German-locale amounts, e.g. "2,13" → 213).
  const buchung = extractBuchung(text);
  const payDate = buchung.date ?? headerDate;
  const netEur = parseNum(buchung.amountRaw?.replace(/^-/, ""));

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
  // Also routes WAHLDIVIDENDE (cash-elected scrip dividend) and AUSSCHÜTTUNG (fund/ETF
  // distribution, no "DIVIDENDE" keyword) — see detectTrPdf's comment.
  if (/\b(?:WAHL)?DIVIDENDE\b|\bAUSSCHÜTTUNG\b/.test(text)) return parseTrDividend(text);
  if (/ABRECHNUNG ZINSEN/.test(text)) return parseTrInterest(text);
  return parseTrTrade(text);
}
