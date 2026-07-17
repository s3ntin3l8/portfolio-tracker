import { collapse } from "./shared.js";
import { detectTrPdf, TR_SIG_RE, TR_ISIN_LABELED_RE, BARE_ISIN_RE } from "./tr-pdf/detect.js";
import { parseTrTrade } from "./tr-pdf/trade.js";
import { parseTrDividend } from "./tr-pdf/dividend.js";
import { parseTrInterest } from "./tr-pdf/interest.js";
import { parseTrTaxOptimization } from "./tr-pdf/tax-optimization.js";
import { type TrPdfResult } from "./tr-pdf/helpers.js";

export { detectTrPdf, TR_SIG_RE, TR_ISIN_LABELED_RE, BARE_ISIN_RE };
export type { TrPdfResult };

export function parseTrPdf(rawText: string): TrPdfResult {
  const text = collapse(rawText);
  if (/STEUERLICHE OPTIMIERUNG/i.test(text)) return parseTrTaxOptimization(text);
  if (/\b(?:WAHL)?DIVIDENDE\b|\bAUSSCHÜTTUNG\b/.test(text)) return parseTrDividend(text);
  if (/ABRECHNUNG ZINSEN/.test(text)) return parseTrInterest(text);
  return parseTrTrade(text);
}
