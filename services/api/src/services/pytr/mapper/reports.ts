import { z } from "zod";
import { REPORT_EVENT_TYPES, REPORT_TITLE_PREFIXES, REPORT_TITLE_YEAR_RE } from "./taxonomy.js";

const reportEventSchema = z.object({
  id: z.string().min(1),
  timestamp: z.string().min(1),
  eventType: z.string().nullish(),
  title: z.string().nullish(),
  documentRefs: z
    .array(z.object({ id: z.string(), type: z.string().nullish(), date: z.string().nullish() }))
    .nullish(),
});

export interface ReportDocumentRef {
  eventId: string;
  docId: string;
  taxYear: number | null;
  title: string | null;
}

export function extractReportDocuments(rawEvents: unknown[]): ReportDocumentRef[] {
  const out: ReportDocumentRef[] = [];
  for (const raw of rawEvents) {
    const parsed = reportEventSchema.safeParse(raw);
    if (!parsed.success) continue;
    const ev = parsed.data;
    const title = ev.title?.trim() ?? null;
    const isReport =
      REPORT_EVENT_TYPES.has(ev.eventType ?? "") ||
      (title != null && REPORT_TITLE_PREFIXES.some((prefix) => title.startsWith(prefix)));
    if (!isReport || !ev.documentRefs || ev.documentRefs.length === 0) continue;

    const titleYear = title ? REPORT_TITLE_YEAR_RE.exec(title)?.[1] : undefined;
    const postedYear = new Date(ev.timestamp).getFullYear();
    const taxYear = titleYear
      ? Number(titleYear)
      : Number.isFinite(postedYear)
        ? postedYear - 1
        : null;

    for (const doc of ev.documentRefs) {
      if (!doc.id) continue;
      out.push({ eventId: ev.id, docId: doc.id, taxYear, title });
    }
  }
  return out;
}
