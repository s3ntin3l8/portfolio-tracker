"use client";

import { useMemo, useRef, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { FileText, Upload, Download, Trash2, Loader2 } from "lucide-react";
import { toast } from "sonner";
import type { InboxDocument } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { EmptyState } from "@/components/empty-state";
import { PortfolioPicker, type PickablePortfolio } from "@/components/portfolio-picker";
import { useApiClient } from "@/lib/api";
import { useRouter } from "@/i18n/navigation";

const INBOX_COLS: ColDef<InboxDocument>[] = [
  { key: "document", get: (d) => d.originalFilename ?? "", type: "text" },
  { key: "year", get: (d) => d.taxYear ?? 0, type: "numeric" },
  { key: "source", get: (d) => d.source ?? "", type: "text" },
  { key: "account", get: (d) => d.portfolioLabel ?? "", type: "text" },
  { key: "size", get: (d) => d.sizeBytes ?? 0, type: "numeric" },
  { key: "date", get: (d) => d.storedAt, type: "date" },
];

function formatBytes(n: number | null): string {
  if (n == null) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Source badge: "pytr" (fetched from Trade Republic) vs "upload" (user-provided). */
function SourceBadge({ source }: { source: string | null }) {
  const t = useTranslations("TaxReports");
  if (source === "pytr") return <Badge variant="success">{t("sourcePytr")}</Badge>;
  return <Badge variant="outline">{t("sourceUpload")}</Badge>;
}

/**
 * The tax-reports inbox list + upload — account-level documents (the annual TR tax report,
 * plus user uploads) that don't belong to any single transaction. Mirrors the visual
 * language of ImportHistory (badges, table + mobile cards) at a much smaller scope: no
 * batching/multi-select, since inbox docs are independent rows, not a parse-review flow.
 *
 * portfolioId is required on every uploaded document (see routes/documents.ts) — the same
 * rich {@link PortfolioPicker} used by new-entry-tabs.tsx picks the target, hidden when
 * there's only one portfolio (matching that component's convention).
 */
export function TaxReportsInbox({
  initialDocuments,
  portfolios,
  initialPortfolioId,
}: {
  initialDocuments: InboxDocument[];
  portfolios: PickablePortfolio[];
  initialPortfolioId: string;
}) {
  const t = useTranslations("TaxReports");
  const locale = useLocale();
  const api = useApiClient();
  const router = useRouter();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [documents, setDocuments] = useState(initialDocuments);
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [portfolioId, setPortfolioId] = useState(initialPortfolioId);
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const canUpload = Boolean(portfolioId) && !uploading;
  const { sortKey, sortDir, toggle, sort } = useTableSort<InboxDocument>(INBOX_COLS);
  const sortedDocs = useMemo(() => sort(documents), [documents, sort]);

  async function refresh() {
    try {
      setDocuments(await api.listDocuments("tax_report"));
    } catch {
      // Keep the current list — the page still works from its server-rendered snapshot.
    }
  }

  async function handleUpload(file: File) {
    if (!portfolioId) return;
    setUploading(true);
    try {
      await api.uploadDocument(file, { category: "tax_report", portfolioId });
      toast.success(t("uploadSuccess"));
      await refresh();
      router.refresh();
    } catch {
      toast.error(t("uploadError"));
    } finally {
      setUploading(false);
    }
  }

  async function handleDownload(doc: InboxDocument) {
    try {
      const { url } = await api.getDocumentUrl(doc.id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      toast.error(t("downloadError"));
    }
  }

  async function handleDelete(doc: InboxDocument) {
    if (typeof window !== "undefined" && !window.confirm(t("deleteConfirm"))) return;
    setBusyId(doc.id);
    try {
      await api.deleteDocument(doc.id);
      setDocuments((prev) => prev.filter((d) => d.id !== doc.id));
      toast.success(t("deleteSuccess"));
    } catch {
      toast.error(t("deleteError"));
    } finally {
      setBusyId(null);
    }
  }

  // Only shown with more than one portfolio (matches new-entry-tabs.tsx's convention) —
  // with exactly one, portfolioId is already set from initialPortfolioId and stays fixed.
  const portfolioPicker =
    portfolios.length > 1 ? (
      <div className="space-y-1.5">
        <span className="block text-sm font-medium">{t("portfolioPicker")}</span>
        <PortfolioPicker
          portfolios={portfolios}
          value={portfolioId}
          onChange={setPortfolioId}
          ariaLabel={t("portfolioPicker")}
          triggerClassName="w-full sm:max-w-xs"
        />
      </div>
    ) : null;

  const uploadButton = (
    <div className="space-y-2">
      {portfolioPicker}
      <input
        ref={fileInputRef}
        type="file"
        accept="application/pdf"
        className="hidden"
        disabled={!canUpload}
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = "";
          if (file) void handleUpload(file);
        }}
      />
      <Button size="sm" disabled={!canUpload} onClick={() => fileInputRef.current?.click()}>
        {uploading ? <Loader2 className="animate-spin" /> : <Upload />}
        {t("upload")}
      </Button>
      {portfolios.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("noPortfolio")}</p>
      )}
    </div>
  );

  if (documents.length === 0) {
    return (
      <div className="space-y-4">
        <EmptyState
          icon={FileText}
          title={t("emptyTitle")}
          description={t("emptyBody")}
          action={uploadButton}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        {uploadButton}
      </div>

      {/* Desktop table */}
      <Card className="hidden overflow-hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                colKey="document"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("colDocument")}
              </SortableTableHead>
              <SortableTableHead
                colKey="year"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("colYear")}
              </SortableTableHead>
              <SortableTableHead
                colKey="source"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("colSource")}
              </SortableTableHead>
              <SortableTableHead
                colKey="account"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("colAccount")}
              </SortableTableHead>
              <SortableTableHead
                colKey="size"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("colSize")}
              </SortableTableHead>
              <SortableTableHead
                colKey="date"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("colDate")}
              </SortableTableHead>
              <TableHead className="text-right">{t("colActions")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedDocs.map((doc) => (
              <TableRow key={doc.id}>
                <TableCell className="flex items-center gap-2 font-medium">
                  <FileText className="size-4 shrink-0 text-muted-foreground" />
                  <span className="truncate">{doc.originalFilename ?? t("untitled")}</span>
                </TableCell>
                <TableCell>{doc.taxYear ?? "—"}</TableCell>
                <TableCell>
                  <SourceBadge source={doc.source} />
                </TableCell>
                <TableCell className="text-muted-foreground">{doc.portfolioLabel ?? "—"}</TableCell>
                <TableCell className="text-muted-foreground">
                  {formatBytes(doc.sizeBytes)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {df.format(new Date(doc.storedAt))}
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("download")}
                      onClick={() => void handleDownload(doc)}
                    >
                      <Download />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("delete")}
                      disabled={busyId === doc.id}
                      onClick={() => void handleDelete(doc)}
                    >
                      {busyId === doc.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>

      {/* Mobile cards */}
      <div className="space-y-2 md:hidden">
        {sortedDocs.map((doc) => (
          <Card key={doc.id} className="flex items-center gap-3 p-3">
            <FileText className="size-8 shrink-0 text-muted-foreground" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {doc.originalFilename ?? t("untitled")}
              </p>
              <p className="text-xs text-muted-foreground">
                {doc.taxYear ?? "—"} · {formatBytes(doc.sizeBytes)} ·{" "}
                {df.format(new Date(doc.storedAt))}
              </p>
              <div className="mt-1 flex items-center gap-2">
                <SourceBadge source={doc.source} />
                {doc.portfolioLabel && (
                  <span className="text-xs text-muted-foreground">{doc.portfolioLabel}</span>
                )}
              </div>
            </div>
            <div className="flex shrink-0 flex-col gap-1">
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("download")}
                onClick={() => void handleDownload(doc)}
              >
                <Download />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("delete")}
                disabled={busyId === doc.id}
                onClick={() => void handleDelete(doc)}
              >
                {busyId === doc.id ? <Loader2 className="animate-spin" /> : <Trash2 />}
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}
