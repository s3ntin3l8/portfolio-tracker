"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { Download, Loader2 } from "lucide-react";
import type { SourceSummary } from "@portfolio/api-client";
import { useApiClient } from "@/lib/api";
import { SRC_STYLE, DEFAULT_SRC } from "@/lib/source-style";

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
 * Renders the import-provenance rows for a transaction: a tinted source-type icon, a clean
 * type label, the import date + filename, an optional per-component tax breakdown, and (when
 * a documentId is set) a per-source download button. Styled to the reference "Sources &
 * documents" list (rounded-18 card, hairline dividers, 40×40 tinted icons, 36×36 download).
 *
 * We deliberately show the *imported date + filename* rather than the raw dedup `externalId`
 * (a broker fingerprint like `dkb:12345` is meaningless to the user).
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
    <div>
      <p className="mb-2 ml-0.5 text-[12px] font-bold uppercase tracking-[.04em] text-text-3">
        {t("sourcesSection.title")}
      </p>
      <div className="divide-y divide-line overflow-hidden rounded-[18px] border border-border bg-card">
        {sources.map((src) => {
          const style = SRC_STYLE[src.sourceType] ?? DEFAULT_SRC;
          const Icon = style.icon;
          const tc = src.taxComponents;
          const tcEntries = tc
            ? Object.entries(tc).filter(([, v]) => v && Number(v) !== 0)
            : [];
          // Prefer the localized source name ("PDF", "Trade Republic"…); fall back to raw.
          let label = src.sourceType;
          try {
            label = t(`sources.${src.sourceType}`);
          } catch {
            /* unknown source type — keep the raw value */
          }
          return (
            <div key={src.id} className="flex items-center gap-3 px-[15px] py-[13px]">
              <span
                className="flex size-10 shrink-0 items-center justify-center rounded-[12px]"
                style={{ background: style.bg, color: style.fg }}
              >
                <Icon className="size-5" strokeWidth={1.9} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-bold text-foreground">{label}</p>
                <p className="truncate text-[12px] font-medium text-text-2">
                  {t("sourcesSection.importedAt", { date: df.format(new Date(src.createdAt)) })}
                  {src.filename ? ` · ${src.filename}` : ""}
                </p>
                {tcEntries.length > 0 && (
                  <p className="mt-0.5 text-[11px] font-semibold text-[#0E9F6E]">
                    {tcEntries
                      .map(([k, v]) => `${TAX_COMPONENT_LABELS[k] ?? k}: ${v}`)
                      .join(" · ")}
                  </p>
                )}
              </div>
              {!readOnly && src.hasDocument && (
                <button
                  type="button"
                  aria-label={t("sourcesSection.download")}
                  title={t("sourcesSection.download")}
                  disabled={downloading === src.id}
                  onClick={() => void downloadSource(src.id)}
                  className="flex size-9 shrink-0 items-center justify-center rounded-[11px] border border-border bg-background text-foreground transition-colors hover:bg-secondary disabled:opacity-50"
                >
                  {downloading === src.id ? (
                    <Loader2 className="size-[17px] animate-spin" />
                  ) : (
                    <Download className="size-[17px]" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      {hasFullTaxDetail && (
        <p className="mt-2 text-xs text-muted-foreground">{t("sourcesSection.fullDetailBadge")}</p>
      )}
    </div>
  );
}
