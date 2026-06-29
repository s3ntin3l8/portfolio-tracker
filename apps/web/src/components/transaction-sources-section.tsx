"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, FileCheck2, Loader2, PencilLine } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { SourceSummary } from "@portfolio/api-client";
import { useApiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";

/** Map sourceType → icon (local copy to avoid circular dep with transactions-table). */
const SOURCE_ICON_LOCAL: Record<string, LucideIcon> = {
  screenshot: FileCheck2,
  csv: FileCheck2,
  manual: PencilLine,
  pytr: FileCheck2,
  pdf: FileCheck2,
};

/** Per-source tax component label map — keys match TaxComponents. */
export const TAX_COMPONENT_LABELS: Record<string, string> = {
  kapitalertragsteuer: "KapSt",
  solidaritaetszuschlag: "SolZ",
  kirchensteuer: "KiSt",
  quellensteuer: "QSt",
  stueckzinsen: "Stückzinsen",
};

interface TransactionSourcesSectionProps {
  portfolioId: string;
  txId: string;
  sources: SourceSummary[];
  hasFullTaxDetail: boolean;
  /** When true the section is read-only (no download buttons). Defaults to false. */
  readOnly?: boolean;
}

/**
 * Renders the import-provenance rows for a transaction: sourceType chip, externalId,
 * per-component tax breakdown, and (when a documentId is set) a per-source download button.
 *
 * Used in both the transaction edit form (read-write) and the transaction detail sheet
 * (read-only=false still allows downloads — the buttons call the source-document-url API).
 */
export function TransactionSourcesSection({
  portfolioId,
  txId,
  sources,
  hasFullTaxDetail,
  readOnly = false,
}: TransactionSourcesSectionProps) {
  const t = useTranslations("Transactions");
  const locale = useLocale();
  const api = useApiClient();
  const [downloading, setDownloading] = useState<string | null>(null);
  const df = useMemo(
    () => new Intl.DateTimeFormat(locale, { dateStyle: "medium" }),
    [locale],
  );

  async function downloadSource(sourceId: string) {
    setDownloading(sourceId);
    try {
      const { url } = await api.getSourceDocumentUrl(portfolioId, txId, sourceId);
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(null);
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-sm font-medium">{t("sourcesSection.title")}</p>
      <div className="divide-y divide-border rounded-md border text-sm">
        {sources.map((src) => {
          const Icon = SOURCE_ICON_LOCAL[src.sourceType] ?? FileCheck2;
          const tc = src.taxComponents;
          const tcEntries = tc
            ? Object.entries(tc).filter(([, v]) => v && Number(v) !== 0)
            : [];
          return (
            <div key={src.id} className="flex items-start gap-2 px-3 py-2">
              <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <p className="font-medium capitalize">{src.sourceType}</p>
                <p className="text-xs text-muted-foreground truncate">
                  {t("sourcesSection.importedAt", { date: df.format(new Date(src.createdAt)) })}
                  {src.filename ? ` · ${src.filename}` : ""}
                </p>
                {tcEntries.length > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {tcEntries
                      .map(([k, v]) => `${TAX_COMPONENT_LABELS[k] ?? k}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
              {!readOnly && src.hasDocument && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-7 shrink-0"
                  disabled={downloading === src.id}
                  onClick={() => void downloadSource(src.id)}
                >
                  {downloading === src.id
                    ? <Loader2 className="size-3 animate-spin" />
                    : <Download className="size-3" />}
                  <span className="sr-only">{t("sourcesSection.download")}</span>
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {hasFullTaxDetail && (
        <p className="text-xs text-muted-foreground">{t("sourcesSection.fullDetailBadge")}</p>
      )}
    </div>
  );
}
