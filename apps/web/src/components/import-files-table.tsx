"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { Badge } from "@/components/ui/badge";
import { PortfolioPicker } from "@/components/portfolio-picker";
import type { ImportTargetPortfolio } from "@/components/import-flow";

export interface ImportFilesTableProps {
  /** One row per imported file, in upload order. */
  groups: { importId: string; filename: string }[];
  portfolios: ImportTargetPortfolio[];
  /** importId → selected portfolioId. */
  portfolioByImport: Map<string, string>;
  /** importIds whose portfolio was auto-detected from the file's account number. */
  matchedImports: Set<string>;
  countByImport: (importId: string) => number;
  issueCountByImport: (importId: string) => number;
  onPortfolioChange: (importId: string, portfolioId: string) => void;
}

/**
 * Compact one-row-per-file confirm table for multi-file imports. Replaces the stack of large
 * per-file cards: each row has a compact portfolio picker (pre-filled from auto-detection), and
 * checking one or more rows reveals a bulk-assign control that sets the chosen portfolio for just
 * the checked files — so a 90-file batch is assignable in a couple of clicks while individual
 * rows can still be re-fixed.
 */
export function ImportFilesTable({
  groups,
  portfolios,
  portfolioByImport,
  matchedImports,
  countByImport,
  issueCountByImport,
  onPortfolioChange,
}: ImportFilesTableProps) {
  const t = useTranslations("Import");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const multiPortfolio = portfolios.length > 1;

  // The `count` col's `get` closes over the per-render `countByImport` prop, so this
  // `COLS` array is rebuilt every render. That's fine for `useTableSort`'s state
  // (sortKey/sortDir/toggle), but the hook's `sort` callback is memoized on
  // `[sortKey, sortDir]` only and reads `cols` from its closure — using the hook's
  // `sort` here would close over a stale `countByImport` and lag behind the displayed
  // counts whenever the parent re-renders. Compute the sort in a local `useMemo`
  // below instead, depending on `countByImport` directly so the row order recomputes
  // when the underlying data changes.
  const COLS: ColDef<{ importId: string; filename: string }>[] = [
    { key: "file", get: (g) => g.filename, type: "text" },
    { key: "count", get: (g) => countByImport(g.importId), type: "numeric" },
  ];
  const {
    sortKey,
    sortDir,
    toggle: toggleSort,
  } = useTableSort<{
    importId: string;
    filename: string;
  }>(COLS);
  const sortedGroups = useMemo(() => {
    if (sortKey === null) return groups;
    const sign = sortDir === "asc" ? 1 : -1;
    const cmp = (
      a: { importId: string; filename: string },
      b: { importId: string; filename: string },
    ): number => {
      if (sortKey === "file") {
        return (
          sign *
          a.filename.localeCompare(b.filename, undefined, {
            sensitivity: "base",
            numeric: true,
          })
        );
      }
      return sign * (countByImport(a.importId) - countByImport(b.importId));
    };
    return [...groups].sort(cmp);
  }, [groups, countByImport, sortKey, sortDir]);

  const allSelected = groups.length > 0 && selected.size === groups.length;
  const toggleAll = () =>
    setSelected(allSelected ? new Set() : new Set(groups.map((g) => g.importId)));
  const toggle = (iid: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(iid)) next.delete(iid);
      else next.add(iid);
      return next;
    });

  const assignSelected = (pid: string) => {
    for (const iid of selected) onPortfolioChange(iid, pid);
  };

  return (
    <div className="space-y-3">
      {/* Bulk-assign toolbar — only when rows are checked and there's a choice to make. */}
      {multiPortfolio && selected.size > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card/60 px-4 py-2 text-sm">
          <span className="text-muted-foreground">
            {t("confirmPortfolio.selectedCount", { count: selected.size })}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-muted-foreground">{t("confirmPortfolio.assignSelected")}</span>
            <PortfolioPicker
              ariaLabel={t("confirmPortfolio.assignSelected")}
              portfolios={portfolios}
              value=""
              onChange={assignSelected}
              triggerClassName="h-8 w-auto text-xs"
            />
          </div>
        </div>
      )}

      <div className="rounded-xl bg-card shadow-card">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <input
                  type="checkbox"
                  className="size-4 align-middle accent-primary"
                  aria-label={t("confirmPortfolio.selectAll")}
                  checked={allSelected}
                  onChange={toggleAll}
                />
              </TableHead>
              <SortableTableHead
                colKey="file"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
              >
                {t("confirmPortfolio.fileColumn")}
              </SortableTableHead>
              {multiPortfolio && <TableHead>{t("confirmPortfolio.importInto")}</TableHead>}
              <SortableTableHead
                colKey="count"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggleSort}
                align="right"
              >
                {t("confirmPortfolio.countColumn")}
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sortedGroups.map((g) => {
              const count = countByImport(g.importId);
              const issues = issueCountByImport(g.importId);
              const isChecked = selected.has(g.importId);
              return (
                <TableRow key={g.importId} data-state={isChecked ? "selected" : undefined}>
                  <TableCell className="w-10">
                    <input
                      type="checkbox"
                      className="size-4 align-middle accent-primary"
                      aria-label={t("confirmPortfolio.selectFile", { file: g.filename })}
                      checked={isChecked}
                      onChange={() => toggle(g.importId)}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-col gap-1">
                      <span className="truncate font-medium">{g.filename}</span>
                      <div className="flex flex-wrap items-center gap-1.5">
                        {matchedImports.has(g.importId) && (
                          <Badge variant="outline" className="text-xs">
                            {t("confirmPortfolio.autoDetected")}
                          </Badge>
                        )}
                        {issues > 0 && (
                          <span className="text-xs text-warning">
                            {t("review.issues.attention", { count: issues })}
                          </span>
                        )}
                      </div>
                    </div>
                  </TableCell>
                  {multiPortfolio && (
                    <TableCell>
                      <PortfolioPicker
                        ariaLabel={t("confirmPortfolio.importInto")}
                        portfolios={portfolios}
                        value={portfolioByImport.get(g.importId) ?? portfolios[0]?.id ?? ""}
                        onChange={(pid) => onPortfolioChange(g.importId, pid)}
                        triggerClassName="h-8 w-full text-xs"
                      />
                    </TableCell>
                  )}
                  <TableCell className="text-right tabular-nums text-muted-foreground">
                    {count}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
