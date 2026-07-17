"use client";

import { useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { Eye, EyeOff, ListChecks, Trash2, X } from "lucide-react";
import { Spinner } from "@/components/ui/spinner";
import type { ImportRecord } from "@portfolio/api-client";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useApiClient } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ReassignDialog } from "@/components/reassign-dialog";
import type { PickablePortfolio } from "@/components/portfolio-picker";
import { useRouter } from "@/i18n/navigation";
import { useTableSort } from "@/lib/table-sort";
import { IH_COLS } from "./import-history/types";
import { isDeadSyncAnchor } from "./import-history/utils";
export { isDeadSyncAnchor } from "./import-history/utils";
import { useImportActions } from "./import-history/actions";
import { useImportSelection } from "./import-history/selection";
import { useBatchGroups } from "./import-history/batch";
import { RowActions, DesktopRow, MobileRow } from "./import-history/rows";

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
 *
 * Desktop keeps the full table (always-visible checkboxes, sortable Parser/Status/Items/
 * Timestamp columns). Mobile (`md:hidden`) swaps in a compact card list — reference-style
 * tinted source icon + filename + status, long-press to reveal checkboxes for bulk actions
 * (mirroring `transactions-table.tsx`'s own gesture, via `useLongPressSelect`). Per-row
 * actions are icon-only (native `title=`/`aria-label=` tooltip) in both layouts, except the
 * transient 2-step Undo confirmation, which keeps visible text — a destructive step
 * shouldn't hide behind an icon.
 */
export function ImportHistory({
  items,
  showTitle = true,
  portfolios = [],
}: {
  items: ImportRecord[];
  showTitle?: boolean;
  portfolios?: PickablePortfolio[];
}) {
  const t = useTranslations("ImportHistory");
  const ts = useTranslations("Transactions");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const shortDf = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
  const api = useApiClient();
  const router = useRouter();

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<ImportRecord>(IH_COLS);
  const [showCompleted, setShowCompleted] = useState(false);

  const {
    busyId,
    confirmId,
    clearingAll,
    actionError,
    reassignId,
    setConfirmId,
    setReassignId,
    setClearingAll,
    setActionError,
    discard,
    undo,
    clear,
    doReassignImport,
    downloadDocument,
  } = useImportActions(api, router);

  const visibleItems = (
    showCompleted ? items : items.filter((i) => i.status !== "confirmed")
  ).filter((i) => !isDeadSyncAnchor(i));

  const { batchGroups, looseItems } = useBatchGroups(visibleItems);

  const {
    selected,
    bulkBusy,
    confirmingBulk,
    setConfirmingBulk,
    selectionMode,
    setSelectionMode,
    longPressHandlers,
    consumeLongPress,
    discardedIds,
    confirmedCount,
    allSelected,
    selectedConfirmedTx,
    exitSelection,
    toggleOne,
    setMany,
    toggleAllVisible,
    bulkDelete,
    clearAllDiscarded,
  } = useImportSelection(
    items,
    visibleItems,
    api,
    router,
    () => {
      setActionError(null);
      setActionError(t("actionError"));
    },
    (busy: boolean) => setClearingAll(busy),
    () => setActionError(null),
  );

  const canReassign = portfolios.length > 1;

  return (
    <Card>
      {(showTitle || discardedIds.length > 0 || confirmedCount > 0) && (
        <CardHeader
          className={cn(
            "flex flex-row items-center gap-2 py-2",
            showTitle ? "justify-between" : "justify-end",
          )}
        >
          {showTitle && <CardTitle>{t("title")}</CardTitle>}
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
                {clearingAll ? <Spinner size="xs" /> : <Trash2 className="size-3.5" />}
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
      {selectionMode && (
        <div className="mx-6 mb-3 flex min-h-12 items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {selected.size > 0 ? t("selectedCount", { count: selected.size }) : t("selectPrompt")}
          </span>
          {confirmingBulk ? (
            <span className="flex items-center gap-2">
              <span className="text-muted-foreground">
                {t("bulkConfirmPrompt", { count: selectedConfirmedTx })}
              </span>
              <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
                {bulkBusy && <Spinner size="xs" />}
                {t("deleteSelected")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={bulkBusy}
                onClick={() => setConfirmingBulk(false)}
              >
                {t("cancel")}
              </Button>
            </span>
          ) : (
            <span className="flex items-center gap-1">
              {selected.size > 0 && (
                <Button size="sm" variant="destructive" disabled={bulkBusy} onClick={bulkDelete}>
                  {bulkBusy ? <Spinner size="xs" /> : <Trash2 className="size-3.5" />}
                  {t("deleteSelected")}
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                className="size-8"
                title={t("cancelSelection")}
                aria-label={t("cancelSelection")}
                disabled={bulkBusy}
                onClick={exitSelection}
              >
                <X className="size-4" />
              </Button>
            </span>
          )}
        </div>
      )}
      <CardContent className="p-0">
        <div className="hidden md:block">
          <Table>
            <TableHeader>
              <TableRow>
                <TableCell className="h-10 w-16 px-3 align-middle">
                  {selectionMode ? (
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={t("selectAll")}
                      checked={allSelected}
                      onChange={toggleAllVisible}
                    />
                  ) : (
                    <Button
                      size="icon"
                      variant="ghost"
                      className="size-6"
                      title={t("selectRows")}
                      aria-label={t("selectRows")}
                      onClick={() => setSelectionMode(true)}
                    >
                      <ListChecks className="size-4" />
                    </Button>
                  )}
                </TableCell>
                <TableCell className="h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground">
                  {t("file")}
                </TableCell>
                <SortableTableHead
                  colKey="parser"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                >
                  Parser
                </SortableTableHead>
                <SortableTableHead
                  colKey="status"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                >
                  Status
                </SortableTableHead>
                <SortableTableHead
                  colKey="count"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                >
                  Items
                </SortableTableHead>
                <SortableTableHead
                  colKey="createdAt"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                >
                  Timestamp
                </SortableTableHead>
                <TableCell className="h-10 px-3 text-left align-middle text-xs font-medium text-muted-foreground">
                  <span className="sr-only">Actions</span>
                </TableCell>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visibleItems.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="h-16 text-center text-sm text-muted-foreground">
                    {t("onlyCompleted", { count: confirmedCount })}
                  </TableCell>
                </TableRow>
              )}
              {batchGroups.map((group) => {
                const groupIds = group.rows.map((r) => r.id);
                const allInGroupSelected = groupIds.every((id) => selected.has(id));
                return [
                  <TableRow key={`batch-${group.batchId}`} className="bg-muted/40">
                    <TableCell className="w-16">
                      {selectionMode && (
                        <input
                          type="checkbox"
                          className="size-4 align-middle accent-primary"
                          aria-label={t("selectBatch")}
                          checked={allInGroupSelected}
                          onChange={() => setMany(groupIds, !allInGroupSelected)}
                        />
                      )}
                    </TableCell>
                    <TableCell
                      colSpan={6}
                      className="text-xs font-medium text-muted-foreground"
                      suppressHydrationWarning
                    >
                      {t("batchLabel", { count: group.rows.length })} ·{" "}
                      {df.format(new Date(group.uploadedAt))}
                    </TableCell>
                  </TableRow>,
                  ...group.rows.map((imp) => (
                    <DesktopRow
                      key={imp.id}
                      imp={imp}
                      selected={selected}
                      selectionMode={selectionMode}
                      t={t}
                      ts={ts}
                      df={df}
                      onToggleOne={toggleOne}
                      actions={
                        <RowActions
                          imp={imp}
                          busyId={busyId}
                          confirmId={confirmId}
                          canReassign={canReassign}
                          t={t}
                          onDiscard={discard}
                          onClear={clear}
                          onUndo={undo}
                          onDownload={downloadDocument}
                          onReassign={setReassignId}
                          onSetConfirmId={setConfirmId}
                        />
                      }
                    />
                  )),
                ];
              })}
              {sort(looseItems).map((imp) => (
                <DesktopRow
                  key={imp.id}
                  imp={imp}
                  selected={selected}
                  selectionMode={selectionMode}
                  t={t}
                  ts={ts}
                  df={df}
                  onToggleOne={toggleOne}
                  actions={
                    <RowActions
                      imp={imp}
                      busyId={busyId}
                      confirmId={confirmId}
                      canReassign={canReassign}
                      t={t}
                      onDiscard={discard}
                      onClear={clear}
                      onUndo={undo}
                      onDownload={downloadDocument}
                      onReassign={setReassignId}
                      onSetConfirmId={setConfirmId}
                    />
                  }
                />
              ))}
            </TableBody>
          </Table>
        </div>

        <div className="divide-y divide-line md:hidden">
          {visibleItems.length === 0 && (
            <div className="px-4 py-8 text-center text-sm text-muted-foreground">
              {t("onlyCompleted", { count: confirmedCount })}
            </div>
          )}
          {batchGroups.map((group) => (
            <div key={`m-batch-${group.batchId}`}>
              <div
                className="bg-muted/40 px-[15px] py-2 text-xs font-medium text-muted-foreground"
                suppressHydrationWarning
              >
                {t("batchLabel", { count: group.rows.length })} ·{" "}
                {df.format(new Date(group.uploadedAt))}
              </div>
              {group.rows.map((imp) => (
                <MobileRow
                  key={imp.id}
                  imp={imp}
                  selected={selected}
                  selectionMode={selectionMode}
                  t={t}
                  ts={ts}
                  shortDf={shortDf}
                  onToggleOne={toggleOne}
                  longPressHandlers={longPressHandlers}
                  consumeLongPress={consumeLongPress}
                  actions={
                    <RowActions
                      imp={imp}
                      busyId={busyId}
                      confirmId={confirmId}
                      canReassign={canReassign}
                      t={t}
                      onDiscard={discard}
                      onClear={clear}
                      onUndo={undo}
                      onDownload={downloadDocument}
                      onReassign={setReassignId}
                      onSetConfirmId={setConfirmId}
                    />
                  }
                />
              ))}
            </div>
          ))}
          {sort(looseItems).map((imp) => (
            <MobileRow
              key={imp.id}
              imp={imp}
              selected={selected}
              selectionMode={selectionMode}
              t={t}
              ts={ts}
              shortDf={shortDf}
              onToggleOne={toggleOne}
              longPressHandlers={longPressHandlers}
              consumeLongPress={consumeLongPress}
              actions={
                <RowActions
                  imp={imp}
                  busyId={busyId}
                  confirmId={confirmId}
                  canReassign={canReassign}
                  t={t}
                  onDiscard={discard}
                  onClear={clear}
                  onUndo={undo}
                  onDownload={downloadDocument}
                  onReassign={setReassignId}
                  onSetConfirmId={setConfirmId}
                />
              }
            />
          ))}
        </div>
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
