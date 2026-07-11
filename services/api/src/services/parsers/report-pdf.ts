/**
 * Deterministic detector for account-level report PDFs (currently: Trade Republic's
 * annual tax report, "Jährlicher Steuerbericht") uploaded through the general
 * Add-Transaction flow — `POST /imports/screenshot` (routes/imports/parse.ts).
 *
 * Unlike `detectDkbPdf`/`detectTrPdf`, this isn't a transaction parser: a report PDF has
 * no drafts to extract. Its only job is to recognize the document class early — before the
 * expensive/inappropriate vision-LLM fallback ever runs on it — so the upload route can
 * route it into the tax-reports inbox instead of silently returning zero drafts.
 *
 * Reuses the same title-prefix list `services/pytr/mapper.ts` validated against a real
 * captured account (`REPORT_TITLE_PREFIXES`) — one source of truth for what counts as "the
 * annual TR tax report" whether it arrives via pytr sync or a manual upload.
 */

import { REPORT_TITLE_PREFIXES, REPORT_TITLE_YEAR_RE } from "../pytr/mapper.js";
import type { DocumentCategory } from "@portfolio/schema";

export interface ReportPdfDetection {
  category: DocumentCategory;
  /** Best-effort reporting year — see the narrow-window search below for why this is safer
   *  than scanning the whole document for a 4-digit number. Null if no year is found near
   *  the matched title. */
  taxYear: number | null;
  /** The matched title, with year suffix when found (e.g. "Jährlicher Steuerbericht 2025"). */
  title: string;
}

/**
 * True when `text` (a PDF's extracted text) is Trade Republic's annual tax report. Returns
 * the category/taxYear/title to store it with, or null when no report title is found.
 *
 * The year is searched only in a short window immediately after the matched title — not
 * the whole document — since `REPORT_TITLE_YEAR_RE` is a bare `\b(20\d{2})\b` match that
 * would otherwise risk grabbing an unrelated year elsewhere in the PDF (a footer, an
 * account-opening date, page numbering).
 */
export function detectReportPdf(text: string): ReportPdfDetection | null {
  for (const prefix of REPORT_TITLE_PREFIXES) {
    const idx = text.indexOf(prefix);
    if (idx === -1) continue;

    const window = text.slice(idx, idx + prefix.length + 12);
    const yearMatch = REPORT_TITLE_YEAR_RE.exec(window);
    const taxYear = yearMatch ? Number(yearMatch[1]) : null;
    const title = taxYear ? `${prefix} ${taxYear}` : prefix;
    return { category: "tax_report", taxYear, title };
  }
  return null;
}
