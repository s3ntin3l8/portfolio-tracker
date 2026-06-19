"use client";

import React, { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, Loader2, Pencil, Trash2, X } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { ImportDraft, ImportIssue, ReviewDraft } from "@/components/import-flow";

const REVIEW_COLS: ColDef<ReviewDraft>[] = [
  { key: "confidence", get: (d) => d.confidence, type: "numeric" },
  { key: "assetClass", get: (d) => d.assetClass, type: "text" },
  { key: "action", get: (d) => d.action, type: "text" },
  { key: "name", get: (d) => d.name ?? "", type: "text" },
  { key: "isin", get: (d) => d.isin ?? "", type: "text" },
  { key: "wkn", get: (d) => d.wkn ?? "", type: "text" },
  { key: "executedAt", get: (d) => d.executedAt, type: "date" },
  { key: "quantity", get: (d) => d.quantity, type: "numeric" },
  { key: "price", get: (d) => d.price, type: "numeric" },
  { key: "total", get: (d) => d.total ?? "", type: "numeric" },
  { key: "fees", get: (d) => d.fees ?? "", type: "numeric" },
];

// Actions the mapping editor can assign to an unmapped event.
const MAP_ACTIONS = [
  "buy",
  "sell",
  "bonus",
  "dividend",
  "coupon",
  "interest",
  "savings_plan",
  "deposit",
  "withdrawal",
] as const;

// Number of columns in the desktop table (used for empty / issue row colSpan).
const TABLE_COL_COUNT = 14; // checkbox + conf + class + action + name + isin + wkn + date + qty + price + total + fees + currency + actions

/** Format a quantity string to up to 4 decimal places, stripping trailing zeros. */
function fmtQty(s: string): string {
  const n = parseFloat(s);
  if (!isFinite(n)) return s;
  return n.toFixed(4).replace(/\.?0+$/, "") || "0";
}

/** Format a monetary amount string to 2 decimal places. */
function fmtAmt(s: string): string {
  const n = parseFloat(s);
  if (!isFinite(n)) return s;
  return n.toFixed(2);
}

// Confidence below this reads as "needs review" — same threshold as the badge colour.
const NEEDS_REVIEW_BELOW = 0.9;

export interface ImportReviewGroup {
  importId: string;
  filename: string;
}

export interface ImportTargetPortfolio {
  id: string;
  name: string;
}

export interface ImportReviewProps {
  drafts: ReviewDraft[];
  onUpdate: (uid: string, patch: Partial<ImportDraft>) => void;
  onRemove: (uid: string) => void;
  onRemoveMany: (uids: string[]) => void;
  /** Confirm all drafts, or just the passed subset (confirm-selected). */
  onConfirm: (uids?: string[]) => void | Promise<void>;
  onDiscard: () => void | Promise<void>;
  /** Unmapped/skipped events surfaced for review (Trade Republic imports). */
  issues?: ImportIssue[];
  /** Turn an "attention" issue into a draft (user completed it in the map dialog). */
  onMapIssue?: (eventId: string, draft: ImportDraft) => void;
  /**
   * When provided with more than one entry, renders collapsible group-header rows
   * in the table so each source document is clearly delineated. Single-entry or
   * absent = flat list (current behaviour).
   */
  groups?: ImportReviewGroup[];
  /** Available portfolios for per-group portfolio selection. */
  portfolios?: ImportTargetPortfolio[];
  /** Current portfolio id per importId (controlled by the parent). */
  portfolioByImport?: Map<string, string>;
  /** Called when the user changes the portfolio for a group. */
  onPortfolioChange?: (importId: string, portfolioId: string) => void;
  /** Per-import issues for multi-file review (overrides the flat `issues` prop per group). */
  issuesByImport?: Map<string, ImportIssue[]>;
}

/**
 * The review step of the import flow: a compact, filterable, bulk-selectable list of
 * draft transactions. Renders a dense table on desktop and stacked cards on mobile;
 * editing happens in a focused dialog. Every action keys off the draft's stable `uid`,
 * so selection and edits stay correct while filtering hides rows or removals reindex
 * the underlying array.
 */
export function ImportReview({
  drafts,
  onUpdate,
  onRemove,
  onRemoveMany,
  onConfirm,
  onDiscard,
  issues = [],
  onMapIssue,
  groups,
  portfolios,
  portfolioByImport,
  onPortfolioChange,
  issuesByImport,
}: ImportReviewProps) {
  // When more than one group is passed, render group-header rows in the table.
  const isGrouped = (groups?.length ?? 0) > 1;
  const t = useTranslations("Import");
  const tm = useTranslations("Manage");

  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<ReviewDraft>(REVIEW_COLS);

  // When issuesByImport is provided, flatten all per-group issues into a single list
  // for the attention/ignorable banners (same as the single-import `issues` prop).
  const allIssues = useMemo(() => {
    if (issuesByImport) {
      return Array.from(issuesByImport.values()).flat();
    }
    return issues;
  }, [issues, issuesByImport]);

  const attention = allIssues.filter((i) => i.severity === "attention" && i.eventId);
  const ignorable = allIssues.filter((i) => !(i.severity === "attention" && i.eventId));

  // Group collapse state — empty set means all groups are expanded (default).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  function toggleCollapse(importId: string) {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(importId)) next.delete(importId);
      else next.add(importId);
      return next;
    });
  }
  // The issue currently open in the map dialog, plus its in-progress draft fields.
  const [mapping, setMapping] = useState<ImportIssue | null>(null);
  const [mapForm, setMapForm] = useState<ImportDraft | null>(null);

  function openMap(issue: ImportIssue) {
    const raw = issue.raw ?? {};
    const amount = raw.amount != null ? Math.abs(raw.amount) : 0;
    // Derive a sensible default action from the event type so the user doesn't
    // have to change it for the common cases (share corp actions → bonus).
    const defaultAction =
      issue.eventType === "SSP_CORPORATE_ACTION_INSTRUMENT" ? "bonus" : "buy";
    // Use the raw share count if available (Python may have extracted it for corp actions).
    const defaultQty =
      raw.shares != null && raw.shares > 0 ? String(raw.shares) : "0";
    setMapping(issue);
    setMapForm({
      assetClass: "equity",
      action: defaultAction,
      isin: raw.isin ?? null,
      name: raw.name ?? issue.eventType ?? "",
      quantity: defaultQty,
      unit: "shares",
      price: defaultAction === "bonus" ? "0" : String(amount),
      fees: "0",
      currency: raw.currency ?? "EUR",
      executedAt: (raw.executedAt ?? new Date().toISOString()).slice(0, 10),
      confidence: 1,
      externalId: issue.eventId ?? null,
    });
  }

  function saveMap() {
    if (mapping?.eventId && mapForm && onMapIssue) onMapIssue(mapping.eventId, mapForm);
    setMapping(null);
    setMapForm(null);
  }

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [editingUid, setEditingUid] = useState<string | null>(null);
  // Which write is in flight, so we can disable + spin its button. A large import
  // (hundreds of rows) can take 20–30s to commit; without this the button looks idle.
  const [pending, setPending] = useState<
    "confirm" | "confirmSelected" | "discard" | null
  >(null);
  const busy = pending !== null;

  async function runConfirm(
    action: "confirm" | "confirmSelected",
    uids?: string[],
  ) {
    setPending(action);
    try {
      await onConfirm(uids);
      // After a successful (partial) confirm: reset filters and selection so the user
      // sees all remaining drafts. For a full confirm, onConfirm navigates away anyway.
      clearFilters();
      setSelected(new Set());
    } finally {
      setPending(null);
    }
  }

  async function runDiscard() {
    setPending("discard");
    try {
      await onDiscard();
    } finally {
      setPending(null);
    }
  }

  // Multi-select filters: an empty set means "all". A non-empty set is OR within the
  // dimension (e.g. buy OR sell), and dimensions AND together — so you can isolate exactly
  // the rows you want to confirm in one pass.
  const [assetClassFilter, setAssetClassFilter] = useState<Set<string>>(new Set());
  const [actionFilter, setActionFilter] = useState<Set<string>>(new Set());
  const [needsReviewOnly, setNeedsReviewOnly] = useState(false);
  const [query, setQuery] = useState("");

  function toggleFilter(
    setter: React.Dispatch<React.SetStateAction<Set<string>>>,
    value: string,
  ) {
    setter((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  }

  const assetClasses = useMemo(
    () => [...new Set(drafts.map((d) => d.assetClass))].sort(),
    [drafts],
  );
  const actions = useMemo(
    () => [...new Set(drafts.map((d) => d.action))].sort(),
    [drafts],
  );

  const filtersActive =
    assetClassFilter.size > 0 ||
    actionFilter.size > 0 ||
    needsReviewOnly ||
    query.trim() !== "";

  const view = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = drafts.filter((d) => {
      if (assetClassFilter.size && !assetClassFilter.has(d.assetClass)) return false;
      if (actionFilter.size && !actionFilter.has(d.action)) return false;
      if (needsReviewOnly && d.confidence >= NEEDS_REVIEW_BELOW) return false;
      if (q && !(d.name ?? "").toLowerCase().includes(q)) return false;
      return true;
    });
    return sort(filtered);
  }, [drafts, assetClassFilter, actionFilter, needsReviewOnly, query, sort]);

  // Attention issues are rendered as table rows (confidence 0%) so they appear under the
  // "needs review" filter. They are hidden when a dimension-specific filter is active
  // (they have no action/class to match) but visible otherwise.
  const visibleIssueRows = useMemo(() => {
    if (assetClassFilter.size > 0 || actionFilter.size > 0) return [];
    const q = query.trim().toLowerCase();
    return attention.filter(
      (i) => !q || (i.raw?.name ?? i.eventType ?? "").toLowerCase().includes(q),
    );
  }, [attention, assetClassFilter, actionFilter, query]);

  // Resolve selection through the live drafts so stale uids (from removals) never count.
  const selectedIds = useMemo(
    () => drafts.filter((d) => selected.has(d.uid)).map((d) => d.uid),
    [drafts, selected],
  );
  const allVisibleSelected =
    view.length > 0 && view.every((d) => selected.has(d.uid));

  function toggle(uid: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(uid)) next.delete(uid);
      else next.add(uid);
      return next;
    });
  }

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) for (const d of view) next.delete(d.uid);
      else for (const d of view) next.add(d.uid);
      return next;
    });
  }

  function handleRemove(uid: string) {
    onRemove(uid);
    setSelected((prev) => {
      if (!prev.has(uid)) return prev;
      const next = new Set(prev);
      next.delete(uid);
      return next;
    });
  }

  function removeSelected() {
    onRemoveMany(selectedIds);
    setSelected(new Set());
    setConfirming(false);
  }

  function clearFilters() {
    setAssetClassFilter(new Set());
    setActionFilter(new Set());
    setNeedsReviewOnly(false);
    setQuery("");
  }

  const editingDraft = drafts.find((d) => d.uid === editingUid) ?? null;
  const pct = (c: number) => t("confidence", { pct: Math.round(c * 100) });
  const dateOf = (d: ReviewDraft) => d.executedAt.slice(0, 10);

  // Drafts flagged as cross-format duplicates (#196). They're excluded from the default
  // "Confirm" (the parent handles that); here we badge them and explain the exclusion.
  const duplicateCount = useMemo(
    () => drafts.filter((d) => d.likelyDuplicate).length,
    [drafts],
  );
  const dupLabel = (d: ReviewDraft) =>
    t("review.duplicate", {
      source: d.likelyDuplicate?.source ?? "—",
      date: (d.likelyDuplicate?.executedAt ?? "").slice(0, 10),
    });

  function draftCells(d: ReviewDraft, isSelected: boolean) {
    return (
      <>
        <TableCell>
          <input
            type="checkbox"
            className="size-4 align-middle accent-primary"
            aria-label={t("review.selectRow")}
            checked={isSelected}
            onChange={() => toggle(d.uid)}
          />
        </TableCell>
        <TableCell>
          <div className="flex flex-col items-start gap-1">
            <Badge variant={d.confidence >= NEEDS_REVIEW_BELOW ? "success" : "warning"}>
              {pct(d.confidence)}
            </Badge>
            {d.likelyDuplicate && (
              <Badge variant="warning" title={dupLabel(d)}>
                {dupLabel(d)}
              </Badge>
            )}
          </div>
        </TableCell>
        <TableCell>
          <Badge variant="outline">{d.assetClass}</Badge>
        </TableCell>
        <TableCell>
          <Badge
            variant={
              d.action === "sell" || d.action === "withdrawal" ? "destructive" : "success"
            }
          >
            {d.action}
          </Badge>
        </TableCell>
        <TableCell className="font-medium">{d.name ?? "—"}</TableCell>
        <TableCell className="tabular text-xs text-muted-foreground">{d.isin ?? "—"}</TableCell>
        <TableCell className="tabular text-xs text-muted-foreground">{d.wkn ?? "—"}</TableCell>
        <TableCell className="tabular whitespace-nowrap text-muted-foreground">
          {dateOf(d)}
        </TableCell>
        <TableCell className="tabular text-right">{fmtQty(d.quantity)}</TableCell>
        <TableCell className="tabular text-right">{fmtAmt(d.price)}</TableCell>
        <TableCell className="tabular text-right text-muted-foreground">
          {d.total ? fmtAmt(d.total) : "—"}
        </TableCell>
        <TableCell className="tabular text-right text-muted-foreground">
          {d.fees ? fmtAmt(d.fees) : "—"}
        </TableCell>
        <TableCell className="text-xs text-muted-foreground">{d.currency}</TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("review.edit.open")}
              onClick={() => setEditingUid(d.uid)}
            >
              <Pencil className="size-4" />
            </Button>
            {drafts.length > 1 && (
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("remove")}
                onClick={() => handleRemove(d.uid)}
              >
                <Trash2 className="size-4" />
              </Button>
            )}
          </div>
        </TableCell>
      </>
    );
  }

  function issueCells(issue: ImportIssue) {
    return (
      <>
        <TableCell>
          <input
            type="checkbox"
            className="size-4 align-middle opacity-40"
            disabled
            aria-label={t("review.selectRow")}
            checked={false}
            onChange={() => undefined}
          />
        </TableCell>
        <TableCell>
          <Badge variant="warning">{pct(0)}</Badge>
        </TableCell>
        <TableCell>
          <Badge variant="outline">—</Badge>
        </TableCell>
        <TableCell>
          <Badge variant="outline">—</Badge>
        </TableCell>
        <TableCell className="font-medium">
          {issue.raw?.name ?? issue.eventType ?? "—"}
        </TableCell>
        <TableCell className="tabular text-xs text-muted-foreground">
          {issue.raw?.isin ?? "—"}
        </TableCell>
        <TableCell className="tabular text-xs text-muted-foreground">
          {issue.raw?.wkn ?? "—"}
        </TableCell>
        <TableCell className="tabular whitespace-nowrap text-muted-foreground">
          {issue.raw?.executedAt?.slice(0, 10) ?? "—"}
        </TableCell>
        <TableCell className="tabular text-right text-muted-foreground">
          {issue.raw?.shares != null ? fmtQty(String(issue.raw.shares)) : "—"}
        </TableCell>
        <TableCell className="tabular text-right text-muted-foreground">
          {issue.raw?.amount != null ? fmtAmt(String(Math.abs(issue.raw.amount))) : "—"}
        </TableCell>
        <TableCell />
        <TableCell />
        <TableCell className="text-xs text-muted-foreground">
          {issue.raw?.currency ?? "—"}
        </TableCell>
        <TableCell className="text-right">
          {onMapIssue && (
            <Button size="sm" variant="secondary" onClick={() => openMap(issue)}>
              {t("review.issues.map")}
            </Button>
          )}
        </TableCell>
      </>
    );
  }

  function mobileDraftCard(d: ReviewDraft) {
    return (
      <div key={d.uid} className="rounded-lg border border-border p-3">
        <div className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 size-4 shrink-0 align-middle accent-primary"
            aria-label={t("review.selectRow")}
            checked={selected.has(d.uid)}
            onChange={() => toggle(d.uid)}
          />
          <button
            type="button"
            className="min-w-0 flex-1 text-left"
            onClick={() => setEditingUid(d.uid)}
          >
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-medium">{d.name ?? "—"}</span>
              <Badge
                variant={d.confidence >= NEEDS_REVIEW_BELOW ? "success" : "warning"}
              >
                {pct(d.confidence)}
              </Badge>
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs">
              <Badge variant="outline">{d.assetClass}</Badge>
              <Badge
                variant={
                  d.action === "sell" || d.action === "withdrawal"
                    ? "destructive"
                    : "success"
                }
              >
                {d.action}
              </Badge>
              <span className="text-muted-foreground">{dateOf(d)}</span>
              {d.isin && (
                <span className="font-mono text-muted-foreground">{d.isin}</span>
              )}
              {d.wkn && (
                <span className="font-mono text-muted-foreground">{d.wkn}</span>
              )}
              {d.likelyDuplicate && <Badge variant="warning">{dupLabel(d)}</Badge>}
            </div>
            <div className="mt-1 tabular text-sm text-muted-foreground">
              {fmtQty(d.quantity)} × {fmtAmt(d.price)} {d.currency}
              {d.total && <span className="ml-2">= {fmtAmt(d.total)}</span>}
              {d.fees && d.fees !== "0" && (
                <span className="ml-1">(+{fmtAmt(d.fees)} fees)</span>
              )}
            </div>
          </button>
          {drafts.length > 1 && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("remove")}
              onClick={() => handleRemove(d.uid)}
            >
              <Trash2 className="size-4" />
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("draftCount", { count: drafts.length })} — {t("reviewHint")}
      </p>

      {/* Cross-format duplicate notice (#196): flagged rows are excluded from "Confirm";
          to import one anyway the user selects it and uses "Confirm selected". */}
      {duplicateCount > 0 && (
        <div className="rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-sm text-warning">
          {t("review.duplicateNotice", { count: duplicateCount })}
        </div>
      )}

      {/* Issues: attention events become rows in the table (see below); only the count
          is shown here as a banner so users know to check the "needs review" filter.
          Ignorable info events are tucked behind a disclosure as before. */}
      {(attention.length > 0 || ignorable.length > 0) && (
        <div className="space-y-2">
          {attention.length > 0 && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
              <span className="font-medium">
                {t("review.issues.attention", { count: attention.length })}
              </span>
              <span className="text-amber-700/70 dark:text-amber-400/70">
                — {t("review.issues.attentionHint")}
              </span>
            </div>
          )}
          {ignorable.length > 0 && (
            <details className="text-sm text-muted-foreground">
              <summary className="cursor-pointer">
                {t("review.issues.ignored", { count: ignorable.length })}
              </summary>
              <ul className="mt-1.5 space-y-1 pl-4">
                {ignorable.map((issue, i) => (
                  <li key={issue.eventId ?? i}>{issue.message}</li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* Filter bar */}
      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center">
        {assetClasses.length > 1 && (
          <ChipGroup
            label={t("review.filters.assetClass")}
            values={assetClasses}
            selected={assetClassFilter}
            onToggle={(v) => toggleFilter(setAssetClassFilter, v)}
          />
        )}
        {actions.length > 1 && (
          <ChipGroup
            label={t("review.filters.action")}
            values={actions}
            selected={actionFilter}
            onToggle={(v) => toggleFilter(setActionFilter, v)}
          />
        )}
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          <input
            type="checkbox"
            className="size-4 align-middle accent-primary"
            checked={needsReviewOnly}
            onChange={(e) => setNeedsReviewOnly(e.target.checked)}
          />
          {t("review.filters.needsReview")}
        </label>
        <Input
          type="search"
          aria-label={t("review.filters.search")}
          placeholder={t("review.filters.search")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="h-9 sm:w-48"
        />
        {filtersActive && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <span>
              {t("review.filters.showing", { shown: view.length, total: drafts.length })}
            </span>
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              {t("review.filters.clear")}
            </Button>
          </div>
        )}
      </div>

      {/* Bulk-action toolbar (shown when anything is selected) */}
      {selectedIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {t("review.batch.selected", { count: selectedIds.length })}
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => runConfirm("confirmSelected", selectedIds)}
            >
              {pending === "confirmSelected" && (
                <Loader2 className="size-3.5 animate-spin" />
              )}
              {t("review.batch.confirmSelected")}
            </Button>
            {confirming ? (
              <span className="flex items-center gap-2">
                <span className="text-muted-foreground">
                  {t("review.batch.removePrompt")}
                </span>
                <Button size="sm" variant="destructive" onClick={removeSelected}>
                  {t("review.batch.removeConfirm")}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirming(false)}
                >
                  {t("review.batch.cancel")}
                </Button>
              </span>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => setConfirming(true)}
              >
                <Trash2 className="size-3.5" />
                {t("review.batch.remove")}
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Desktop: dense table */}
      <div className="hidden rounded-xl border border-border md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={t("review.selectAll")}
                  checked={allVisibleSelected}
                  onChange={toggleAll}
                />
              </TableHead>
              <SortableTableHead colKey="confidence" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("review.columns.confidence")}</SortableTableHead>
              <SortableTableHead colKey="assetClass" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("review.columns.assetClass")}</SortableTableHead>
              <SortableTableHead colKey="action" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("review.columns.action")}</SortableTableHead>
              <SortableTableHead colKey="name" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("fields.name")}</SortableTableHead>
              <SortableTableHead colKey="isin" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("fields.isin")}</SortableTableHead>
              <SortableTableHead colKey="wkn" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("fields.wkn")}</SortableTableHead>
              <SortableTableHead colKey="executedAt" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort}>{t("fields.executedAt")}</SortableTableHead>
              <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("fields.quantity")}</SortableTableHead>
              <SortableTableHead colKey="price" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("fields.price")}</SortableTableHead>
              <SortableTableHead colKey="total" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("fields.total")}</SortableTableHead>
              <SortableTableHead colKey="fees" sortKey={sortKey} sortDir={sortDir} onToggle={toggleSort} className="text-right">{t("fields.fees")}</SortableTableHead>
              <TableHead>{t("fields.currency")}</TableHead>
              <TableHead className="text-right">
                <span className="sr-only">{tm("actions")}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {isGrouped
              ? groups!.map((g) => {
                  const isCollapsed = collapsed.has(g.importId);
                  const groupView = view.filter((d) => d.importId === g.importId);
                  const groupAttn = (issuesByImport?.get(g.importId) ?? []).filter(
                    (i) => i.severity === "attention" && i.eventId,
                  );
                  const q = query.trim().toLowerCase();
                  const groupIssueRows =
                    assetClassFilter.size > 0 || actionFilter.size > 0
                      ? []
                      : groupAttn.filter(
                          (i) =>
                            !q ||
                            (i.raw?.name ?? i.eventType ?? "").toLowerCase().includes(q),
                        );
                  return (
                    <React.Fragment key={g.importId}>
                      <TableRow className="bg-muted/30 hover:bg-muted/40">
                        <TableCell colSpan={TABLE_COL_COUNT} className="py-2">
                          <div className="flex items-center gap-3">
                            <button
                              type="button"
                              aria-label={
                                isCollapsed ? t("group.expand") : t("group.collapse")
                              }
                              onClick={() => toggleCollapse(g.importId)}
                              className="flex items-center gap-1.5 text-sm font-medium text-foreground"
                            >
                              <ChevronDown
                                className={cn(
                                  "size-4 shrink-0 transition-transform",
                                  isCollapsed && "-rotate-90",
                                )}
                              />
                              {g.filename}
                            </button>
                            <span className="text-xs text-muted-foreground">
                              ({groupView.length + groupIssueRows.length})
                            </span>
                            {portfolios && portfolios.length > 1 && onPortfolioChange && (
                              <Select
                                aria-label={t("group.portfolio")}
                                value={
                                  portfolioByImport?.get(g.importId) ??
                                  portfolios[0]?.id ??
                                  ""
                                }
                                onChange={(e) =>
                                  onPortfolioChange(g.importId, e.target.value)
                                }
                                className="ml-auto h-7 w-auto text-xs"
                              >
                                {portfolios.map((p) => (
                                  <option key={p.id} value={p.id}>
                                    {p.name}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </div>
                        </TableCell>
                      </TableRow>
                      {!isCollapsed &&
                        groupView.map((d) => {
                          const isSelected = selected.has(d.uid);
                          return (
                            <TableRow
                              key={d.uid}
                              data-state={isSelected ? "selected" : undefined}
                            >
                              {draftCells(d, isSelected)}
                            </TableRow>
                          );
                        })}
                      {!isCollapsed &&
                        groupIssueRows.map((issue) => (
                          <TableRow
                            key={issue.eventId ?? issue.eventType}
                            className="opacity-80"
                          >
                            {issueCells(issue)}
                          </TableRow>
                        ))}
                    </React.Fragment>
                  );
                })
              : view.map((d) => {
                  const isSelected = selected.has(d.uid);
                  return (
                    <TableRow
                      key={d.uid}
                      data-state={isSelected ? "selected" : undefined}
                    >
                      {draftCells(d, isSelected)}
                    </TableRow>
                  );
                })}
            {/* Attention issue rows (flat mode only — grouped mode inlines them per group) */}
            {!isGrouped &&
              visibleIssueRows.map((issue) => (
                <TableRow key={issue.eventId ?? issue.eventType} className="opacity-80">
                  {issueCells(issue)}
                </TableRow>
              ))}
            {view.length === 0 && visibleIssueRows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={TABLE_COL_COUNT}
                  className="py-8 text-center text-sm text-muted-foreground"
                >
                  {t("review.empty")}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      {/* Mobile: stacked cards */}
      <div className="space-y-2 md:hidden">
        {isGrouped
          ? groups!.map((g) => {
              const isCollapsed = collapsed.has(g.importId);
              const groupView = view.filter((d) => d.importId === g.importId);
              return (
                <React.Fragment key={g.importId}>
                  <div className="flex items-center gap-2 rounded-lg bg-muted/30 px-3 py-2">
                    <button
                      type="button"
                      aria-label={isCollapsed ? t("group.expand") : t("group.collapse")}
                      onClick={() => toggleCollapse(g.importId)}
                      className="flex flex-1 items-center gap-1.5 text-sm font-medium"
                    >
                      <ChevronDown
                        className={cn(
                          "size-4 shrink-0 transition-transform",
                          isCollapsed && "-rotate-90",
                        )}
                      />
                      <span className="truncate">{g.filename}</span>
                      <span className="ml-1 text-xs text-muted-foreground">
                        ({groupView.length})
                      </span>
                    </button>
                    {portfolios && portfolios.length > 1 && onPortfolioChange && (
                      <Select
                        aria-label={t("group.portfolio")}
                        value={
                          portfolioByImport?.get(g.importId) ?? portfolios[0]?.id ?? ""
                        }
                        onChange={(e) => onPortfolioChange(g.importId, e.target.value)}
                        className="h-7 w-auto text-xs"
                      >
                        {portfolios.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                  {!isCollapsed && groupView.map((d) => mobileDraftCard(d))}
                </React.Fragment>
              );
            })
          : view.map((d) => mobileDraftCard(d))}
        {view.length === 0 && (
          <p className="py-8 text-center text-sm text-muted-foreground">
            {t("review.empty")}
          </p>
        )}
      </div>

      {/* Footer — always rendered; the parent no longer provides a separate one. */}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={runDiscard} disabled={busy}>
          {pending === "discard" && <Loader2 className="size-4 animate-spin" />}
          {t("discard")}
        </Button>
        <Button
          onClick={() => runConfirm("confirm")}
          disabled={busy || drafts.length === 0}
        >
          {pending === "confirm" && <Loader2 className="size-4 animate-spin" />}
          {t("confirm")}
        </Button>
      </div>

      {/* Edit dialog */}
      <Dialog
        open={editingUid !== null}
        onOpenChange={(open) => {
          if (!open) setEditingUid(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("review.edit.title")}</DialogTitle>
          </DialogHeader>
          {editingDraft && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("fields.name")}>
                <Input
                  value={editingDraft.name ?? ""}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { name: e.target.value })
                  }
                />
              </Field>
              <Field label="ISIN">
                <Input
                  value={editingDraft.isin ?? ""}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { isin: e.target.value || null })
                  }
                />
              </Field>
              <Field label="WKN">
                <Input
                  value={editingDraft.wkn ?? ""}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { wkn: e.target.value || null })
                  }
                />
              </Field>
              <Field label={t("fields.executedAt")}>
                <Input
                  type="date"
                  value={editingDraft.executedAt.slice(0, 10)}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { executedAt: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.quantity")}>
                <Input
                  value={editingDraft.quantity}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { quantity: e.target.value })
                  }
                />
              </Field>
              <Field label={t("fields.price")}>
                <Input
                  value={editingDraft.price}
                  onChange={(e) =>
                    onUpdate(editingDraft.uid, { price: e.target.value })
                  }
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setEditingUid(null)}>
              <X className="size-4" />
              {t("review.edit.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Map dialog: complete an unmapped event into a confirmable draft */}
      <Dialog
        open={mapping !== null}
        onOpenChange={(open) => {
          if (!open) {
            setMapping(null);
            setMapForm(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("review.issues.mapTitle")}</DialogTitle>
          </DialogHeader>
          {mapForm && (
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label={t("review.columns.action")}>
                <Select
                  value={mapForm.action}
                  onChange={(e) => setMapForm({ ...mapForm, action: e.target.value })}
                >
                  {MAP_ACTIONS.map((a) => (
                    <option key={a} value={a}>
                      {a}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t("fields.name")}>
                <Input
                  value={mapForm.name ?? ""}
                  onChange={(e) => setMapForm({ ...mapForm, name: e.target.value })}
                />
              </Field>
              <Field label="ISIN">
                <Input
                  value={mapForm.isin ?? ""}
                  onChange={(e) => setMapForm({ ...mapForm, isin: e.target.value })}
                />
              </Field>
              <Field label="WKN">
                <Input
                  value={mapForm.wkn ?? ""}
                  onChange={(e) => setMapForm({ ...mapForm, wkn: e.target.value })}
                />
              </Field>
              <Field label={t("fields.executedAt")}>
                <Input
                  type="date"
                  value={mapForm.executedAt.slice(0, 10)}
                  onChange={(e) => setMapForm({ ...mapForm, executedAt: e.target.value })}
                />
              </Field>
              <Field label={t("fields.quantity")}>
                <Input
                  value={mapForm.quantity}
                  onChange={(e) => setMapForm({ ...mapForm, quantity: e.target.value })}
                />
              </Field>
              <Field label={t("fields.price")}>
                <Input
                  value={mapForm.price}
                  onChange={(e) => setMapForm({ ...mapForm, price: e.target.value })}
                />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button onClick={saveMap}>{t("review.issues.mapSave")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}

// A labelled row of multi-select toggle chips (OR within the dimension). Empty = all.
function ChipGroup({
  label,
  values,
  selected,
  onToggle,
}: {
  label: string;
  values: string[];
  selected: Set<string>;
  onToggle: (value: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {values.map((v) => (
        <Button
          key={v}
          type="button"
          size="sm"
          variant={selected.has(v) ? "default" : "outline"}
          aria-pressed={selected.has(v)}
          className="h-7 px-2 text-xs"
          onClick={() => onToggle(v)}
        >
          {v}
        </Button>
      ))}
    </div>
  );
}
