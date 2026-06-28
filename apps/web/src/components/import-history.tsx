"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Download, Eye, EyeOff, FolderInput, Loader2, Trash2, Undo2 } from "lucide-react";
import { toast } from "sonner";
import type { ImportRecord } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useApiClient } from "@/lib/api";
import { ReassignDialog } from "@/components/reassign-dialog";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { Link, useRouter } from "@/i18n/navigation";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const IH_COLS: ColDef<ImportRecord>[] = [
  { key: "parser", get: (r) => r.parser, type: "text" },
  { key: "status", get: (r) => r.status, type: "text" },
  { key: "count", get: (r) => r.count, type: "numeric" },
  { key: "createdAt", get: (r) => r.createdAt, type: "date" },
];

const STATUS_VARIANT: Record<
  ImportRecord["status"],
  "warning" | "success" | "outline"
> = {
  draft: "warning",
  confirmed: "success",
  discarded: "outline",
};

/**
 * The user's import history with per-row actions: discard a draft, or undo a
 * confirmed import (which removes the transactions it wrote). Discarded rows are
 * shown for the audit trail but carry no action.
 */
export function ImportHistory({
  items,
  showTitle = true,
  portfolios = [],
}: {
  items: ImportRecord[];
  /** Hide the card's own title when an outer section (e.g. a collapsible) supplies it. */
  showTitle?: boolean;
  /** All of the user's portfolios — enables "Reassign all to…" (hidden when < 2 exist). */
  portfolios?: PickablePortfolio[];
}) {
  const t = useTranslations("ImportHistory");
  const trx = useTranslations("Transactions.reassign");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const api = useApiClient();
  const router = useRouter();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<ImportRecord>(IH_COLS);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [clearingAll, setClearingAll] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  // Completed (confirmed) imports are an audit trail, not an action queue — hide them by
  // default so the list surfaces only what still needs attention, with a toggle to reveal.
  const [showCompleted, setShowCompleted] = useState(false);

  async function discard(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.discardImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
    }
  }

  async function undo(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.deleteImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
      setConfirmId(null);
    }
  }

  async function clear(id: string) {
    setBusyId(id);
    setActionError(null);
    try {
      await api.clearImport(id);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBusyId(null);
    }
  }

  // Import currently queued for "Reassign all to…" (dialog open when non-null).
  const [reassignId, setReassignId] = useState<string | null>(null);
  const canReassign = portfolios.length > 1;

  async function doReassignImport(targetPortfolioId: string) {
    if (!reassignId) return;
    try {
      const r = await api.reassignImport(reassignId, targetPortfolioId);
      const skipped = r.skippedConflicts + r.skippedLoans;
      if (r.moved === 0) toast.info(trx("none"));
      else if (skipped > 0) toast.success(trx("successWithSkips", { moved: r.moved, skipped }));
      else toast.success(trx("success", { count: r.moved }));
      setReassignId(null);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    }
  }

  async function downloadDocument(id: string) {
    try {
      const { url } = await api.getImportDocumentUrl(id);
      window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      setActionError(t("downloadError"));
    }
  }

  const discardedIds = items.filter((i) => i.status === "discarded").map((i) => i.id);
  const confirmedCount = items.filter((i) => i.status === "confirmed").length;
  // Hide confirmed rows unless the user opted to show them. Drafts (actionable) and
  // discarded (still have a Clear action) always stay visible.
  const visibleItems = showCompleted
    ? items
    : items.filter((i) => i.status !== "confirmed");

  async function clearAllDiscarded() {
    setClearingAll(true);
    setActionError(null);
    try {
      await api.bulkClearImports(discardedIds);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setClearingAll(false);
    }
  }

  return (
    <Card>
      {(showTitle || discardedIds.length > 0 || confirmedCount > 0) && (
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          {showTitle ? <CardTitle>{t("title")}</CardTitle> : <span />}
          <div className="flex items-center gap-1">
            {confirmedCount > 0 && (
              <Button
                size="sm"
                variant="ghost"
                aria-pressed={showCompleted}
                onClick={() => setShowCompleted((v) => !v)}
              >
                {showCompleted ? (
                  <EyeOff className="size-3.5" />
                ) : (
                  <Eye className="size-3.5" />
                )}
                {showCompleted
                  ? t("hideCompleted")
                  : t("showCompleted", { count: confirmedCount })}
              </Button>
            )}
            {discardedIds.length > 0 && (
              <Button
                size="sm"
                variant="ghost"
                disabled={clearingAll}
                onClick={clearAllDiscarded}
              >
                {clearingAll ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <Trash2 className="size-3.5" />
                )}
                {t("clearAll")}
              </Button>
            )}
          </div>
        </CardHeader>
      )}
      {actionError && (
        <div
          role="alert"
          className="mx-6 mb-3 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          {actionError}
        </div>
      )}
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead colKey="parser" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Parser</SortableTableHead>
              <SortableTableHead colKey="status" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Status</SortableTableHead>
              <SortableTableHead colKey="count" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Items</SortableTableHead>
              <SortableTableHead colKey="createdAt" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>Timestamp</SortableTableHead>
              <TableCell className="h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground">
                <span className="sr-only">Actions</span>
              </TableCell>
            </TableRow>
          </TableHeader>
          <TableBody>
            {visibleItems.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={5}
                  className="h-16 text-center text-sm text-muted-foreground"
                >
                  {t("onlyCompleted", { count: confirmedCount })}
                </TableCell>
              </TableRow>
            )}
            {sort(visibleItems).map((imp) => {
              const busy = busyId === imp.id;
              return (
                <TableRow key={imp.id}>
                  <TableCell>
                    <Badge variant="outline" className="uppercase">
                      {imp.parser}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant={STATUS_VARIANT[imp.status]}>
                      {t(`status.${imp.status}`)}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {t("items", { count: imp.count })}
                  </TableCell>
                  <TableCell
                    className="tabular whitespace-nowrap text-muted-foreground"
                    suppressHydrationWarning
                  >
                    {df.format(new Date(imp.createdAt))}
                  </TableCell>
                  <TableCell className="text-right">
                    <span className="flex items-center justify-end gap-1">
                      {imp.status === "draft" && (
                        <>
                          <Button size="sm" variant="secondary" asChild>
                            <Link href={`/transactions/import/${imp.id}`}>
                              <Eye className="size-3.5" />
                              {t("review")}
                            </Link>
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => discard(imp.id)}
                          >
                            {busy ? (
                              <Loader2 className="size-3.5 animate-spin" />
                            ) : (
                              <Trash2 className="size-3.5" />
                            )}
                            {t("discard")}
                          </Button>
                        </>
                      )}
                      {imp.status === "discarded" && (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy}
                          onClick={() => clear(imp.id)}
                        >
                          {busy ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="size-3.5" />
                          )}
                          {t("clear")}
                        </Button>
                      )}
                      {imp.status === "confirmed" &&
                        (confirmId === imp.id ? (
                          <>
                            <span className="text-xs text-muted-foreground">
                              {t("undoWarning", { count: imp.count })}
                            </span>
                            <Button
                              size="sm"
                              variant="destructive"
                              disabled={busy}
                              onClick={() => undo(imp.id)}
                            >
                              {busy && <Loader2 className="size-3.5 animate-spin" />}
                              {t("undo")}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              disabled={busy}
                              onClick={() => setConfirmId(null)}
                            >
                              {t("cancel")}
                            </Button>
                          </>
                        ) : (
                          <>
                            {imp.document && (
                              <Button
                                size="sm"
                                variant="ghost"
                                title={imp.document.originalFilename ?? t("downloadReceipt")}
                                onClick={() => downloadDocument(imp.id)}
                              >
                                <Download className="size-3.5" />
                                {t("downloadReceipt")}
                              </Button>
                            )}
                            {canReassign && (
                              <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => setReassignId(imp.id)}
                              >
                                <FolderInput className="size-3.5" />
                                {t("reassign")}
                              </Button>
                            )}
                            <Button
                              size="sm"
                              variant="ghost"
                              onClick={() => setConfirmId(imp.id)}
                            >
                              <Undo2 className="size-3.5" />
                              {t("undo")}
                            </Button>
                          </>
                        ))}
                    </span>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
      {reassignId && (
        <ReassignDialog
          open
          onOpenChange={(o) => {
            if (!o) setReassignId(null);
          }}
          portfolios={portfolios}
          onConfirm={doReassignImport}
        />
      )}
    </Card>
  );
}
