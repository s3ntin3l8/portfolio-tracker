"use client";

import { useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import {
  Download,
  Eye,
  EyeOff,
  FolderInput,
  ListChecks,
  Loader2,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { toast } from "sonner";
import type { ImportRecord } from "@portfolio/api-client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHeader, TableRow } from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useApiClient } from "@/lib/api";
import { haptics } from "@/lib/haptics";
import { SRC_STYLE, DEFAULT_SRC, parserToSourceType } from "@/lib/source-style";
import { useLongPressSelect } from "@/lib/use-long-press-select";
import { cn } from "@/lib/utils";
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

const STATUS_VARIANT: Record<ImportRecord["status"], "warning" | "success" | "outline"> = {
  draft: "warning",
  confirmed: "success",
  discarded: "outline",
};

/**
 * A connection sync (IBKR/Trade Republic) keeps one permanent "anchor" row per connection —
 * provenance for its drafted transactions' importId, not a real import a user would review.
 * Once it's clean (`confirmed`: the last sync left no unresolved attention error) it never
 * renders inside {@link ImportHistory} (even with "Show completed" on), so callers counting
 * "recent imports" must exclude it too, or a header count can include rows the list never
 * shows. A *draft* anchor is left alone: that status means the last sync left an unresolved
 * attention error the user still needs to see, so it stays visible like any other draft.
 *
 * Keyed on `status` alone, NOT `count` — `count` now reflects real materialized transactions
 * (see the imports route), so a healthy, actively-syncing connection can have a large count
 * on a `confirmed` anchor. Those transactions already show up in the regular transactions
 * list; this row's only job is to surface residual attention errors, which `status` alone
 * already encodes.
 */
export const isDeadSyncAnchor = (i: ImportRecord) =>
  (i.parser === "ibkr" || i.parser === "pytr") && i.status === "confirmed";

/**
 * A visible sync anchor (parser pytr/ibkr) is, by construction, always `draft` — a clean
 * `confirmed` one is filtered out by {@link isDeadSyncAnchor} before rendering. Its `draft`
 * doesn't mean "unreviewed" like a real CSV/screenshot import; it means the last sync left
 * an unresolved attention error. Reusing the generic "Draft" badge would read as "this
 * import hasn't been looked at yet," which is misleading for a row with real, already-live
 * transactions — so it gets its own label instead.
 */
function statusLabelKey(imp: ImportRecord): string {
  if ((imp.parser === "ibkr" || imp.parser === "pytr") && imp.status === "draft") {
    return "status.syncNeedsAttention";
  }
  return `status.${imp.status}`;
}

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
  /** Hide the card's own title when an outer section (e.g. a collapsible) supplies it. */
  showTitle?: boolean;
  /** All of the user's portfolios — enables "Reassign all to…" (hidden when < 2 exist). */
  portfolios?: PickablePortfolio[];
}) {
  const t = useTranslations("ImportHistory");
  const trx = useTranslations("Transactions.reassign");
  // Friendly source-type labels ("CSV", "Trade Republic"…) already exist under this
  // namespace for the transaction sources list — reused here instead of duplicating them.
  const ts = useTranslations("Transactions");
  const locale = useLocale();
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" });
  const shortDf = new Intl.DateTimeFormat(locale, { day: "numeric", month: "short" });
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
  // Multi-select state for the bulk-delete bar — shared by both layouts (desktop checkboxes
  // are always visible; mobile reveals them via `selectionMode` below).
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);
  // Two-click confirm guard, only needed when the selection includes confirmed imports
  // (whose deletion removes real transactions).
  const [confirmingBulk, setConfirmingBulk] = useState(false);

  // Checkboxes stay hidden (both layouts) until selection mode is entered — a mobile
  // long-press (below), or the desktop header's select-rows toggle. See
  // `use-long-press-select.ts` — mirrors transactions-table.tsx's own inline mechanism.
  const { selectionMode, setSelectionMode, longPressHandlers, consumeLongPress } =
    useLongPressSelect((id) => toggleOne(id));

  function exitSelection() {
    setSelected(new Set());
    setSelectionMode(false);
    setConfirmingBulk(false);
  }

  // Friendly source-type icon/tint + display label for a row, from the raw `parser` tag.
  function sourceMeta(imp: ImportRecord) {
    const sourceType = parserToSourceType(imp.parser);
    const style = SRC_STYLE[sourceType] ?? DEFAULT_SRC;
    let sourceLabel = sourceType;
    try {
      sourceLabel = ts(`sources.${sourceType}`);
    } catch {
      /* unknown source type — keep the raw value */
    }
    // `originalFilename` is available pre-confirm too (a staged document), unlike `document`
    // (retained-only) — prefer it so a draft shows its real filename before review.
    return { style, sourceLabel, label: imp.originalFilename ?? sourceLabel };
  }

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
  const confirmedCount = items.filter(
    (i) => i.status === "confirmed" && !isDeadSyncAnchor(i),
  ).length;
  // Hide confirmed rows unless the user opted to show them. Drafts (actionable) and
  // discarded (still have a Clear action) always stay visible.
  const visibleItems = (
    showCompleted ? items : items.filter((i) => i.status !== "confirmed")
  ).filter((i) => !isDeadSyncAnchor(i));

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

  const allSelected = visibleItems.length > 0 && visibleItems.every((i) => selected.has(i.id));

  // Shared by desktop checkboxes and the mobile long-press gesture — deselecting the last
  // row also exits mobile selection mode (hides the checkboxes again).
  function toggleOne(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
    if (next.size === 0) setSelectionMode(false);
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
    setMany(
      visibleItems.map((i) => i.id),
      !allSelected,
    );
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
    haptics.destructiveConfirm();
    setBulkBusy(true);
    setActionError(null);
    try {
      await api.bulkDeleteImports([...selected]);
      setSelected(new Set());
      setSelectionMode(false);
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

  // Stops a per-row action press from also activating the row it's nested in (mobile's
  // tap-to-navigate / long-press-to-select) or bubbling into the desktop row hover state.
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();

  // Render the action cell for a data row (Review/Discard/Undo/Clear/Download/Reassign).
  // Icon-only (native title+aria-label tooltip) for the steady state of every status;
  // shared verbatim by the desktop Actions column and the mobile card's trailing cluster.
  // The transient 2-step Undo confirmation is the one exception and keeps visible text.
  function rowActions(imp: ImportRecord) {
    const busy = busyId === imp.id;
    return (
      <span className="flex items-center justify-end gap-1">
        {imp.status === "draft" && (
          <>
            <Button size="icon" variant="ghost" asChild>
              <Link
                href={`/transactions/import/${imp.id}`}
                title={t("review")}
                aria-label={t("review")}
                onPointerDown={stop}
                onClick={stop}
              >
                <Eye className="size-4" />
              </Link>
            </Button>
            <Button
              size="icon"
              variant="ghost"
              title={t("discard")}
              aria-label={t("discard")}
              disabled={busy}
              onPointerDown={stop}
              onClick={(e) => {
                stop(e);
                discard(imp.id);
              }}
            >
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            </Button>
          </>
        )}
        {imp.status === "discarded" && (
          <Button
            size="icon"
            variant="ghost"
            title={t("clear")}
            aria-label={t("clear")}
            disabled={busy}
            onPointerDown={stop}
            onClick={(e) => {
              stop(e);
              clear(imp.id);
            }}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
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
                onPointerDown={stop}
                onClick={(e) => {
                  stop(e);
                  undo(imp.id);
                }}
              >
                {busy && <Loader2 className="size-3.5 animate-spin" />}
                {t("undo")}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onPointerDown={stop}
                onClick={(e) => {
                  stop(e);
                  setConfirmId(null);
                }}
              >
                {t("cancel")}
              </Button>
            </>
          ) : (
            <>
              {imp.document && (
                <Button
                  size="icon"
                  variant="ghost"
                  title={imp.document.originalFilename ?? t("downloadReceipt")}
                  aria-label={t("downloadReceipt")}
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    downloadDocument(imp.id);
                  }}
                >
                  <Download className="size-4" />
                </Button>
              )}
              {canReassign && (
                <Button
                  size="icon"
                  variant="ghost"
                  title={t("reassign")}
                  aria-label={t("reassign")}
                  onPointerDown={stop}
                  onClick={(e) => {
                    stop(e);
                    setReassignId(imp.id);
                  }}
                >
                  <FolderInput className="size-4" />
                </Button>
              )}
              <Button
                size="icon"
                variant="ghost"
                title={t("undo")}
                aria-label={t("undo")}
                onPointerDown={stop}
                onClick={(e) => {
                  stop(e);
                  setConfirmId(imp.id);
                }}
              >
                <Undo2 className="size-4" />
              </Button>
            </>
          ))}
      </span>
    );
  }

  // Render a desktop data row (used for both batch members and loose rows).
  function dataRow(imp: ImportRecord) {
    const { style, label } = sourceMeta(imp);
    const Icon = style.icon;
    return (
      <TableRow key={imp.id} data-state={selected.has(imp.id) ? "selected" : undefined}>
        <TableCell className="w-16">
          {selectionMode && (
            <input
              type="checkbox"
              className="size-4 align-middle accent-primary"
              aria-label={t("selectRow")}
              checked={selected.has(imp.id)}
              onChange={() => toggleOne(imp.id)}
            />
          )}
        </TableCell>
        <TableCell className="max-w-[220px]">
          <span className="flex min-w-0 items-center gap-2.5">
            <span
              className="flex size-7 shrink-0 items-center justify-center rounded-[9px]"
              style={{ background: style.bg, color: style.fg }}
            >
              <Icon className="size-3.5" strokeWidth={2} />
            </span>
            <span className="min-w-0 truncate text-[13px] font-bold" title={label}>
              {label}
            </span>
          </span>
        </TableCell>
        <TableCell>
          <Badge variant="outline" className="uppercase">
            {imp.parser}
          </Badge>
        </TableCell>
        <TableCell>
          <Badge variant={STATUS_VARIANT[imp.status]}>{t(statusLabelKey(imp))}</Badge>
        </TableCell>
        <TableCell className="text-muted-foreground">{t("items", { count: imp.count })}</TableCell>
        <TableCell
          className="tabular whitespace-nowrap text-muted-foreground"
          suppressHydrationWarning
        >
          {df.format(new Date(imp.createdAt))}
        </TableCell>
        <TableCell className="text-right">{rowActions(imp)}</TableCell>
      </TableRow>
    );
  }

  // Render a mobile compact card row — tinted source icon, filename, source·date·count
  // subline with an inline status badge, and the same icon-only actions, trailing.
  function mobileRow(imp: ImportRecord) {
    const { style, sourceLabel, label } = sourceMeta(imp);
    const Icon = style.icon;
    const isSelected = selected.has(imp.id);

    function handleTap() {
      if (consumeLongPress()) return;
      if (selectionMode) {
        toggleOne(imp.id);
        return;
      }
      // The only safe, expected tap target: mirrors the explicit "Review" action. Anything
      // else (confirmed/discarded) is a no-op tap — a surprise download on tap would be a
      // worse outcome than doing nothing.
      if (imp.status === "draft") {
        router.push(`/transactions/import/${imp.id}`);
      }
    }

    return (
      <div
        key={imp.id}
        data-testid={`import-mobile-${imp.id}`}
        data-state={isSelected ? "selected" : undefined}
        onClick={handleTap}
        {...longPressHandlers(imp.id)}
        className={cn(
          "flex cursor-pointer select-none items-center gap-3 px-[15px] py-[13px]",
          isSelected && "bg-primary/10",
        )}
      >
        {selectionMode && (
          <input
            type="checkbox"
            readOnly
            aria-label={t("selectRow")}
            checked={isSelected}
            className="size-4 shrink-0 accent-primary"
          />
        )}
        <span
          className="flex size-10 shrink-0 items-center justify-center rounded-[12px]"
          style={{ background: style.bg, color: style.fg }}
        >
          <Icon className="size-5" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[13px] font-bold" title={label}>
            {label}
          </p>
          <div className="flex min-w-0 items-center gap-1.5 text-[11px] font-medium text-text-2">
            <span className="truncate">
              {sourceLabel} · {shortDf.format(new Date(imp.createdAt))} ·{" "}
              {t("items", { count: imp.count })}
            </span>
            <Badge variant={STATUS_VARIANT[imp.status]} className="shrink-0 px-1.5 py-0 text-[9px]">
              {t(statusLabelKey(imp))}
            </Badge>
          </div>
        </div>
        <span className="shrink-0">{rowActions(imp)}</span>
      </div>
    );
  }

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
                {bulkBusy && <Loader2 className="size-3.5 animate-spin" />}
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
                  {bulkBusy ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
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
        {/* Desktop (≥ md): full table — checkboxes, sortable Parser/Status/Items/Timestamp. */}
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
                  ...group.rows.map((imp) => dataRow(imp)),
                ];
              })}
              {sort(looseItems).map((imp) => dataRow(imp))}
            </TableBody>
          </Table>
        </div>

        {/* Mobile (< md): compact card list — tinted source icon + filename + status,
            long-press a row to reveal checkboxes for bulk actions. */}
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
              {group.rows.map((imp) => mobileRow(imp))}
            </div>
          ))}
          {sort(looseItems).map((imp) => mobileRow(imp))}
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
