import { toDateKey } from "@portfolio/core";
import { Decimal } from "decimal.js";
import type { ParsedTransaction, TaxComponents } from "@portfolio/schema";
import { collapse } from "../shared.js";
import { TR_ISIN_LABELED_RE, BARE_ISIN_RE } from "./detect.js";
import {
  parseGerman,
  parseUs,
  addMoney,
  parseTrDate,
  pushDraft,
  extractBuchung,
  type TrPdfResult,
} from "./helpers.js";

export function parseTrDividend(text: string): TrPdfResult {
  const drafts: ParsedTransaction[] = [];
  const errors: { line: number; message: string }[] = [];

  const depot = text.match(/\bDEPOT\s+(\d+)/)?.[1] ?? null;
  const headerDateStr = text.match(/\bDATUM\s+(\d{2}\.\d{2}\.\d{4})/)?.[1];
  const headerDate = parseTrDate(headerDateStr);

  const isGermanLocale = !/Stücke/.test(text);
  const parseNum = isGermanLocale ? parseGerman : parseUs;
  const qtyWord = isGermanLocale ? "Stk\\." : "Stücke";
  const NUM = "[\\d.,]+";

  const isin = text.match(TR_ISIN_LABELED_RE)?.[1] ?? text.match(BARE_ISIN_RE)?.[1];

  let name: string | undefined;
  if (isin) {
    const labeledM = text.match(new RegExp(`BETRAG\\s+([^:]{1,120}?)\\s*ISIN:\\s+${isin}`));
    const m = labeledM ?? text.match(new RegExp(`BETRAG\\s+(.*?)${isin}`));
    name = m ? collapse(m[1]) : undefined;
  }

  const posM = text.match(
    new RegExp(`(${NUM})\\s+${qtyWord}\\s+(${NUM})\\s+([A-Z]{3})\\s+(${NUM})\\s+([A-Z]{3})`),
  );
  const shares = posM ? parseNum(posM[1]) : null;
  const perShare = posM ? parseNum(posM[2]) : null;
  const nativeCcy = posM?.[3];
  const grossNativeAmt = posM ? parseNum(posM[4]) : null;

  const fxM = text.match(
    new RegExp(
      `Zwischensumme\\s+(${NUM})\\s+[A-Z]{3}\\s+Zwischensumme\\s+${NUM}\\s+[A-Z]{3}\\/[A-Z]{3}\\s+(${NUM})\\s+EUR`,
    ),
  );
  const fxForeignNet = fxM ? parseNum(fxM[1]) : null;
  const fxEurNet = fxM ? parseNum(fxM[2]) : null;
  const fxRate =
    fxForeignNet && fxEurNet && Number(fxForeignNet) > 0
      ? new Decimal(fxEurNet).div(new Decimal(fxForeignNet)).toDecimalPlaces(6).toString()
      : null;

  const isForeign = Boolean(nativeCcy) && nativeCcy !== "EUR" && Boolean(fxRate);

  const quellenM = text.match(new RegExp(`Quellensteuer für [\\w-]+ -\\s*(${NUM})\\s+([A-Z]{3})`));
  const quellenForeign = quellenM ? parseNum(quellenM[1]) : null;
  const quellenEur =
    quellenForeign && fxRate
      ? new Decimal(quellenForeign).mul(new Decimal(fxRate)).toDecimalPlaces(2).toString()
      : null;

  const taxLine = (label: string): string | null =>
    parseNum(
      text.match(
        new RegExp(`${label}(?:\\s+${NUM}\\s+[A-Z]{3}\\/[A-Z]{3})?\\s+-\\s*(${NUM})\\s+EUR`),
      )?.[1],
    );
  const kapst = taxLine("Kapitalertrags?steuer");
  const soli = taxLine("Solidaritätszuschlag");
  const kirche = taxLine("Kirchensteuer");

  const taxVal =
    quellenEur || kapst || soli || kirche ? addMoney(quellenEur, kapst, soli, kirche) : undefined;
  const taxNum = taxVal ? Number(taxVal) : 0;

  const taxComponents: TaxComponents = {};
  if (quellenEur && Number(quellenEur) > 0) taxComponents.quellensteuer = quellenEur;
  if (kapst && Number(kapst) > 0) taxComponents.kapitalertragsteuer = kapst;
  if (soli && Number(soli) > 0) taxComponents.solidaritaetszuschlag = soli;
  if (kirche && Number(kirche) > 0) taxComponents.kirchensteuer = kirche;

  const buchung = extractBuchung(text);
  const payDate = buchung.date ?? headerDate;
  const netEur = parseNum(buchung.amountRaw?.replace(/^-/, ""));

  const total = netEur && taxVal ? addMoney(netEur, taxVal) : (netEur ?? undefined);

  const payDateStr = payDate ? toDateKey(payDate) : undefined;
  const externalId =
    depot && isin && payDateStr ? `tr:div:${depot}:${isin}:${payDateStr}` : undefined;

  pushDraft(
    {
      action: "dividend",
      isin: isin ?? undefined,
      name: name ?? undefined,
      quantity: "0",
      price: netEur ?? "",
      total: total ?? undefined,
      tax: taxNum > 0 ? taxVal : undefined,
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
