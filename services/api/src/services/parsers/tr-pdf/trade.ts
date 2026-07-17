import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import { collapse } from "../shared.js";
import { TR_ISIN_LABELED_RE } from "./detect.js";
import {
  parseGerman,
  parseTrDate,
  pushDraft,
  extractBuchung,
  type TrPdfResult,
} from "./helpers.js";

function tradeAction(text: string): {
  action: ParsedTransaction["action"];
  kind: string | undefined;
} {
  if (/Sparplanausführung|SPARPLAN/.test(text)) {
    return { action: "savings_plan", kind: undefined };
  }
  if (/Saveback/.test(text)) {
    return { action: "savings_plan", kind: "saveback" };
  }
  if (/Round[- ]?up/.test(text)) {
    return { action: "buy", kind: "roundup" };
  }
  if (/\bSELL\b|\bVerkauf\b/.test(text)) {
    return { action: "sell", kind: undefined };
  }
  if (/\bKauf\b|\bBUY\b/.test(text)) {
    return { action: "buy", kind: undefined };
  }
  return { action: "buy", kind: undefined };
}

function extractVenue(text: string): string | undefined {
  const m =
    text.match(/an der ([A-Za-z &]+(?:Exchange|AG[^.]*)?)/)?.[1]?.trim() ??
    text.match(/bei ([A-Za-z &]+(?:AG|GmbH)[^.]*)\./)?.[1]?.trim();
  return m ? collapse(m) : undefined;
}

export function parseTrTrade(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const depot = text.match(/\bDEPOT\s+(\d+)/)?.[1] ?? null;
  const orderRef =
    text.match(/\bAUFTRAG\s+([a-fA-F0-9-]+)/)?.[1] ??
    text.match(/\bORDER\s+([a-fA-F0-9-]+)/)?.[1] ??
    null;
  const ausfuehrung = text.match(/\bAUSFÜHRUNG\s+([a-fA-F0-9-]+)/)?.[1] ?? null;
  const headerDateStr = text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1];
  const headerDate = parseTrDate(headerDateStr);

  const ubersichtM =
    text.match(/ÜBERSICHT\s+([\s\S]*?)(?=POSITION|ABRECHNUNG|BUCHUNG|$)/)?.[1] ?? "";
  const { action, kind } = tradeAction(text + " " + ubersichtM);
  const venue = extractVenue(ubersichtM);

  const isin = text.match(TR_ISIN_LABELED_RE)?.[1];
  let name: string | undefined;
  if (isin) {
    const m = text.match(new RegExp(`.*BETRAG\\s+([^:]{1,120}?)\\s*ISIN:\\s+${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }

  const qtyM = text.match(/([0-9][0-9.,]*)\s+Stk\./);
  const quantity = parseGerman(qtyM?.[1]);

  let price: string | null = null;
  let gross: string | null = null;
  if (qtyM) {
    const afterQty = text.slice(text.indexOf(qtyM[0]) + qtyM[0].length);
    const euros = [...afterQty.matchAll(/([0-9][0-9.,]*)\s+EUR/g)].map((m) => m[1]);
    price = parseGerman(euros[0]);
    gross = parseGerman(euros[1]);
  }

  const fremdkostenM = text.match(/Fremdkostenzuschlag\s+(-?[\d.,]+)\s+EUR/);
  const fees = fremdkostenM ? (parseGerman(fremdkostenM[1].replace("-", "")) ?? "0") : "0";

  const taxLine = (label: string): string | null =>
    parseGerman(
      text
        .match(new RegExp(`${label}(?:\\s+Optimierung)?\\s+(-?[\\d.,]+)\\s+EUR`))?.[1]
        ?.replace("-", ""),
    );
  const kapst = taxLine("Kapitalertrags?steuer");
  const solz = taxLine("Solidaritätszuschlag");
  const kirche = taxLine("Kirchensteuer");

  const buchung = extractBuchung(text);
  const net = buchung.amountRaw ? parseGerman(buchung.amountRaw.replace(/^-/, "")) : undefined;
  const settlementDate = buchung.date ?? headerDate;

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
