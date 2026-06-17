"use client";

import { useTranslations, useLocale } from "next-intl";
import type { HoldingValuation } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
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
        </Table>
      </div>

      {/* ── Mobile list (< md) ── */}
      <div className="md:hidden divide-y divide-border">
        {sorted.map((h) => {
          const { pnl, pct, native, display } = computeRowValues(h, currency, locale);
          const pnlColor =
            pnl === null
              ? "text-muted-foreground"
              : pnl >= 0
                ? "text-success"
                : "text-destructive";
          return (
            <div
              key={h.instrumentId}
              className="grid grid-cols-[1fr_auto_auto] items-center gap-x-4 gap-y-0.5 px-4 py-3"
            >
              {/* Col 1: symbol / name */}
              <div className="min-w-0">
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
              <div className="text-right tabular">
                <div className="text-sm">{native(Number(h.avgCost))}</div>
                <div className="text-xs text-muted-foreground">
                  {Number(h.quantity)} {h.instrument?.unit ?? ""}
                </div>
              </div>

              {/* Col 3: value / P&L */}
              <div className="text-right tabular">
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
            </div>
          );
        })}
      </div>
    </>
  );
}
