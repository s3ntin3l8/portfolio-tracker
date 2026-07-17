import type { ParsedTransaction } from "@portfolio/schema";
import { formatDecimal } from "../../parsers/numeric.js";
import {
  TR_CRYPTO_ISIN,
  TR_DOC_DATE_RE,
  RECLASSIFICATION_ORIGINAL_SUFFIX,
  type TrEvent,
} from "./taxonomy.js";

export { RECLASSIFICATION_ORIGINAL_SUFFIX };

export function rawEventIdFromExternalId(externalId: string): string {
  return externalId.endsWith(RECLASSIFICATION_ORIGINAL_SUFFIX)
    ? externalId.slice(0, -RECLASSIFICATION_ORIGINAL_SUFFIX.length)
    : externalId;
}

function parseTrDocDate(text: string): Date | null {
  const m = TR_DOC_DATE_RE.exec(text.trim());
  if (!m) return null;
  const [, day, month, year] = m;
  const d = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  return Number.isNaN(d.getTime()) ? null : d;
}

export function buildReclassificationSplit(ev: TrEvent): ParsedTransaction[] | null {
  if (ev.originalAmount == null || ev.correctionAmount == null || !ev.trueDistributionDate) {
    return null;
  }
  const trueDate = parseTrDocDate(ev.trueDistributionDate);
  if (!trueDate) return null;

  const assetClass: "crypto" | "equity" =
    ev.isin && TR_CRYPTO_ISIN.test(ev.isin) ? "crypto" : "equity";
  const shared = {
    assetClass,
    ticker: null,
    isin: ev.isin ?? null,
    wkn: ev.wkn ?? null,
    name: ev.title ?? ev.isin ?? ev.eventType,
    quantity: "0",
    unit: "shares" as const,
    fees: "0",
    currency: ev.currency.toUpperCase(),
    confidence: 1,
    savingsPlanId: ev.savingsPlanId ?? null,
    exchangeCode: null,
    executedPrice: null,
    fxRate: ev.fxRate != null ? formatDecimal(ev.fxRate) : null,
    venue: ev.venue ?? null,
    description: ev.description ?? null,
  };
  const original: ParsedTransaction = {
    ...shared,
    action: "dividend",
    price: formatDecimal(Math.abs(ev.originalAmount)),
    total: formatDecimal(Math.abs(ev.originalAmount)),
    tax: null,
    executedAt: trueDate,
    externalId: `${ev.id}${RECLASSIFICATION_ORIGINAL_SUFFIX}`,
    kind: "reclassification-original",
    documentRefs: null,
  };
  const correction: ParsedTransaction = {
    ...shared,
    action: "dividend",
    price: formatDecimal(Math.abs(ev.correctionAmount)),
    total: formatDecimal(Math.abs(ev.correctionAmount)),
    tax: null,
    executedAt: new Date(ev.timestamp),
    externalId: ev.id,
    kind: "reclassification-correction",
    documentRefs: ev.documentRefs ?? null,
  };
  return [original, correction];
}
