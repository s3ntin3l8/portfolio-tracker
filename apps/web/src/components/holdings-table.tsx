"use client";

import { Fragment } from "react";
import { useTranslations, useLocale } from "next-intl";
import type { HoldingValuation } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Link } from "@/i18n/navigation";
import { formatMoney, cn } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const HOLDINGS_COLS: ColDef<HoldingValuation>[] = [
  { key: "instrument", get: (h) => h.instrument?.symbol ?? "", type: "text" },
  { key: "quantity", get: (h) => h.quantity, type: "numeric" },
  { key: "avgCost", get: (h) => h.avgCost, type: "numeric" },
  { key: "price", get: (h) => h.price ?? "0", type: "numeric" },
  { key: "value", get: (h) => h.marketValueDisplay ?? "0", type: "numeric" },
  { key: "pnl", get: (h) => h.unrealizedPnLDisplay ?? "0", type: "numeric" },
];

function formatPct(pct: number): string {
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%`;
}

function computeRowValues(h: HoldingValuation, currency: string, locale: string) {
  const pnl =
    h.unrealizedPnLDisplay !== null ? Number(h.unrealizedPnLDisplay) : null;
  const costBasis = Number(h.costBasisDisplay);
  const pct =
    pnl !== null && costBasis !== 0 ? (pnl / costBasis) * 100 : null;
  const native = (n: number) =>
    formatMoney(n, h.currency ?? currency, locale);
  const display = (n: number) => formatMoney(n, currency, locale);
  return { pnl, pct, native, display };
}

export interface HoldingsTableProps {
  rows: HoldingValuation[];
  currency: string;
}

export function HoldingsTable({ rows, currency }: HoldingsTableProps) {
  const t = useTranslations("Holdings");
  const locale = useLocale();
  const { sortKey, sortDir, toggle, sort } = useTableSort<HoldingValuation>(HOLDINGS_COLS);

  const sorted = sort(rows);

  // Column totals across the (already class-filtered) visible rows. Market value and
  // P&L sum only the priced holdings — unpriced ones (marketValueDisplay === null) are
  // skipped, matching how net worth ignores instruments without a live quote. The total
  // P&L % is taken against summed cost basis so it stays consistent with the rows.
  const totals = rows.reduce(
    (acc, h) => {
      if (h.marketValueDisplay !== null) acc.value += Number(h.marketValueDisplay);
      if (h.unrealizedPnLDisplay !== null) acc.pnl += Number(h.unrealizedPnLDisplay);
      acc.cost += Number(h.costBasisDisplay);
      return acc;
    },
    { value: 0, pnl: 0, cost: 0 },
  );
  const totalPct = totals.cost !== 0 ? (totals.pnl / totals.cost) * 100 : null;
  const totalPnlColor =
    totals.pnl > 0 ? "text-success" : totals.pnl < 0 ? "text-destructive" : "";
  const money = (n: number) => formatMoney(n, currency, locale);

  return (
    <>
      {/* ── Desktop table (md+) ── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("instrument")}</SortableTableHead>
              <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("quantity")}</SortableTableHead>
              <SortableTableHead colKey="avgCost" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("avgCost")}</SortableTableHead>
              <SortableTableHead colKey="price" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("price")}</SortableTableHead>
              <SortableTableHead colKey="value" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("value")}</SortableTableHead>
              <SortableTableHead colKey="pnl" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("pnl")}</SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((h) => {
              const { pnl, pct, native, display } = computeRowValues(h, currency, locale);
              const pnlColor =
                pnl === null
                  ? "text-muted-foreground"
                  : pnl >= 0
                    ? "text-success"
                    : "text-destructive";
              return (
                <TableRow key={h.instrumentId}>
                  <TableCell>
                    <Link
                      href={`/instruments/${h.instrumentId}`}
                      className="font-medium hover:underline"
                    >
                      {h.instrument?.symbol ?? "—"}
                    </Link>
                    <div className="text-xs text-muted-foreground">
                      {h.instrument?.name ?? h.instrumentId}
                    </div>
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {Number(h.quantity)} {h.instrument?.unit ?? ""}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {native(Number(h.avgCost))}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {h.price !== null ? native(Number(h.price)) : "—"}
                  </TableCell>
                  <TableCell className="tabular text-right">
                    {h.marketValueDisplay !== null
                      ? display(Number(h.marketValueDisplay))
                      : "—"}
                  </TableCell>
                  <TableCell className={cn("tabular text-right", pnlColor)}>
                    {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${display(pnl)}`}
                    {pct !== null && (
                      <div className="text-xs">
                        {formatPct(pct)}
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4}>{t("total")}</TableCell>
              <TableCell className="tabular text-right">{money(totals.value)}</TableCell>
              <TableCell className={cn("tabular text-right", totalPnlColor)}>
                {`${totals.pnl >= 0 ? "+" : ""}${money(totals.pnl)}`}
                {totalPct !== null && (
                  <div className="text-xs">{formatPct(totalPct)}</div>
                )}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* ── Mobile list (< md) ── */}
      {/* Single shared grid so all rows have identical column widths,
          which ensures col-1 (1fr) is consistently constrained and names truncate. */}
      <div className="md:hidden grid grid-cols-[minmax(0,1fr)_auto_auto] gap-x-3">
        {sorted.map((h, i) => {
          const { pnl, pct, native, display } = computeRowValues(h, currency, locale);
          const pnlColor =
            pnl === null
              ? "text-muted-foreground"
              : pnl >= 0
                ? "text-success"
                : "text-destructive";
          return (
            <Fragment key={h.instrumentId}>
              {i > 0 && <div className="col-span-3 border-t border-border" />}

              {/* Col 1: symbol / name */}
              <div className="min-w-0 overflow-hidden py-3 pl-4">
                <Link
                  href={`/instruments/${h.instrumentId}`}
                  className="font-medium hover:underline block truncate"
                >
                  {h.instrument?.symbol ?? "—"}
                </Link>
                <div className="text-xs text-muted-foreground truncate">
                  {h.instrument?.name ?? h.instrumentId}
                </div>
              </div>

              {/* Col 2: avg cost / quantity */}
              <div className="text-right tabular py-3">
                <div className="text-sm">{native(Number(h.avgCost))}</div>
                <div className="text-xs text-muted-foreground">
                  {Number(h.quantity)} {h.instrument?.unit ?? ""}
                </div>
              </div>

              {/* Col 3: value / P&L */}
              <div className="text-right tabular py-3 pr-4">
                <div className="text-sm">
                  {h.marketValueDisplay !== null
                    ? display(Number(h.marketValueDisplay))
                    : "—"}
                </div>
                <div className={cn("text-xs", pnlColor)}>
                  {pnl === null
                    ? "—"
                    : `${pnl >= 0 ? "+" : ""}${display(pnl)}${pct !== null ? ` ${formatPct(pct)}` : ""}`}
                </div>
              </div>
            </Fragment>
          );
        })}

        {/* Totals row */}
        <div className="col-span-3 border-t-2 border-border" />
        <div className="py-3 pl-4 font-medium">{t("total")}</div>
        <div aria-hidden />
        <div className="text-right tabular py-3 pr-4">
          <div className="text-sm font-medium">{money(totals.value)}</div>
          <div className={cn("text-xs", totalPnlColor)}>
            {`${totals.pnl >= 0 ? "+" : ""}${money(totals.pnl)}${totalPct !== null ? ` ${formatPct(totalPct)}` : ""}`}
          </div>
        </div>
      </div>
    </>
  );
}
