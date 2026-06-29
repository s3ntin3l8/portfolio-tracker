"use client";

import { useMemo, useState } from "react";
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
 *
 * Multi-select + batch grouping (so a large upload can be cleaned up as one unit): rows
 * carry a checkbox, files uploaded in one step share a `batchId` and render under a group
 * header that selects the whole batch, and "Delete selected" fires a single batched request
 * (per-status dispatch server-side) followed by one refresh — instead of N per-row deletes
 * that trip the API rate limiter.
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
  // Multi-select state for the bulk-delete bar.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Two-click confirm guard, only needed when the selection includes confirmed imports
  // (whose deletion removes real transactions).
  const [confirmingBulk, setConfirmingBulk] = useState(false);

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

  // Group visible rows by their upload-step batchId; only batches with ≥2 visible members
  // are rendered as a group (a singleton batch is just a normal row). Newest batch first.
  const batchGroups = useMemo(() => {
    const byBatch = new Map<string, ImportRecord[]>();
    for (const it of visibleItems) {
      if (!it.batchId) continue;
      const arr = byBatch.get(it.batchId) ?? [];
      arr.push(it);
      byBatch.set(it.batchId, arr);
    }
    return [...byBatch.entries()]
      .filter(([, arr]) => arr.length >= 2)
      .map(([batchId, arr]) => ({
        batchId,
        rows: [...arr].sort((a, b) => +new Date(a.createdAt) - +new Date(b.createdAt)),
        uploadedAt: arr.reduce(
          (min, r) => (r.createdAt < min ? r.createdAt : min),
          arr[0]!.createdAt,
        ),
      }))
      .sort((a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt));
  }, [visibleItems]);

  const batchedIds = useMemo(
    () => new Set(batchGroups.flatMap((g) => g.rows.map((r) => r.id))),
    [batchGroups],
  );
  // Rows not part of a multi-file batch — rendered as a plain sorted list below the groups.
  const looseItems = useMemo(
    () => visibleItems.filter((i) => !batchedIds.has(i.id)),
    [visibleItems, batchedIds],
  );

  const allSelected =
    visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    setConfirmingBulk(false);
  }

  function setMany(ids: string[], on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
    setConfirmingBulk(false);
  }

  function toggleAllVisible() {
    setMany(visibleItems.map((i) => i.id), !allSelected);
  }

  const selectedItems = visibleItems.filter((i) => selected.has(i.id));
  // Transactions that would be removed if the selection's confirmed rows are undone — drives
  // the two-click warning. `count` is the import's draft count (the per-row Undo uses it too).
  const selectedConfirmedTx = selectedItems
    .filter((i) => i.status === "confirmed")
    .reduce((sum, i) => sum + i.count, 0);

  async function bulkDelete() {
    // First click on a selection that includes confirmed rows → ask for confirmation.
    if (selectedConfirmedTx > 0 && !confirmingBulk) {
      setConfirmingBulk(true);
      return;
    }
    setBulkBusy(true);
    setActionError(null);
    try {
      await api.bulkDeleteImports([...selected]);
      setSelected(new Set());
      setConfirmingBulk(false);
      router.refresh();
    } catch {
      setActionError(t("actionError"));
    } finally {
      setBulkBusy(false);
    }
  }

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

  // Render the action cell for a data row (Review/Discard/Undo/Clear/Download/Reassign).
  function rowActions(imp: ImportRecord) {
    const busy = busyId === imp.id;
    return (
      <span className="flex items-center justify-end gap-1">
        {imp.status === "draft" && (
          <>
            <Button size="sm" variant="secondary" asChild>
              <Link href={`/transactions/import/${imp.id}`}>
                <Eye className="size-3.5" />
                {t("review")}
              </Link>
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => discard(imp.id)}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t("discard")}
            </Button>
          </>
        )}
        {imp.status === "discarded" && (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => clear(imp.id)}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
            {t("clear")}
          </Button>
        )}
        {imp.status === "confirmed" &&
          (confirmId === imp.id ? (
            <>
              <span className="text-xs text-muted-foreground">
                {t("undoWarning", { count: imp.count })}
              </span>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => undo(imp.id)}>
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {t("undo")}
              </Button>
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmId(null)}>
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
                <Button size="sm" variant="ghost" onClick={() => setReassignId(imp.id)}>
                  <FolderInput className="size-3.5" />
                  {t("reassign")}
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={() => setConfirmId(imp.id)}>
                <Undo2 className="size-3.5" />
                {t("undo")}
              </Button>
            </>
          ))}
      </span>
    );
  }

  // Render a data row (used for both batch members and loose rows).
  function dataRow(imp: ImportRecord) {
    return (
      <TableRow key={imp.id} data-state={selected.has(imp.id) ? "selected" : undefined}>
        <TableCell className="w-10">
          <input
            type="checkbox"
            className="size-4 align-middle accent-primary"
            aria-label={t("selectRow")}
            checked={selected.has(imp.id)}
            onChange={() => toggleOne(imp.id)}
          />
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="uppercase">
            {imp.parser}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_VARIANT[imp.status]}>{t(`status.${imp.status}`)}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{t("items", { count: imp.count })}</TableCell>
        <TableCell className="tabular whitespace-nowrap text-muted-foreground" suppressHydrationWarning>
          {df.format(new Date(imp.createdAt))}
        </TableCell>
        <TableCell className="text-right">{rowActions(imp)}</TableCell>
      </TableRow>
    );
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
                {showCompleted ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
                {showCompleted ? t("hideCompleted") : t("showCompleted", { count: confirmedCount })}
              </Button>
            )}
            {discardedIds.length > 0 && (
              <Button size="sm" variant="ghost" disabled={clearingAll} onClick={clearAllDiscarded}>
                {clearingAll ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
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
      {selected.size > 0 && (
        <div className="mx-6 mb-3 flex items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">{t("selectedCount", { count: selected.size })}</span>
          {confirmingBulk ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {t("bulkConfirmPrompt", { count: selectedConfirmedTx })}
              </span>
              <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
                {bulkBusy && <Loader2 className="size-3.5 animate-spin" />}
                {t("deleteSelected")}
              </Button>
              <Button size="sm" variant="ghost" disabled={bulkBusy} onClick={() => setConfirmingBulk(false)}>
                {t("cancel")}
              </Button>
            </span>
          ) : (
            <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
              {bulkBusy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              {t("deleteSelected")}
            </Button>
          )}
        </div>
      )}
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableCell className="h-10 w-10 px-3 align-middle">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={t("selectAll")}
                  checked={allSelected}
                  onChange={toggleAllVisible}
                />
              </TableCell>
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
                <TableCell colSpan={6} className="h-16 text-center text-sm text-muted-foreground">
                  {t("onlyCompleted", { count: confirmedCount })}
                </TableCell>
              </TableRow>
            )}
            {batchGroups.map((group) => {
              const groupIds = group.rows.map((r) => r.id);
              const allInGroupSelected = groupIds.every((id) => selected.has(id));
              return [
                <TableRow key={`batch-${group.batchId}`} className="bg-muted/40">
                  <TableCell className="w-10">
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={t("selectBatch")}
                      checked={allInGroupSelected}
                      onChange={() => setMany(groupIds, !allInGroupSelected)}
                    />
                  </TableCell>
                  <TableCell colSpan={5} className="text-xs font-medium text-muted-foreground" suppressHydrationWarning>
                    {t("batchLabel", { count: group.rows.length })} · {df.format(new Date(group.uploadedAt))}
                  </TableCell>
                </TableRow>,
                ...group.rows.map((imp) => dataRow(imp)),
              ];
            })}
            {sort(looseItems).map((imp) => dataRow(imp))}
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
