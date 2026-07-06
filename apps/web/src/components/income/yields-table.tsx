"use client";

import { useTranslations, useLocale } from "next-intl";
import type { InstrumentYield } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TABLE_LABEL,
  TABLE_SUBLABEL,
  TABLE_VALUE,
  TABLE_VALUE_STRONG,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { formatMoney, formatPercent, cn } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const COLS: ColDef<InstrumentYield>[] = [
  { key: "instrument", get: (y) => y.symbol ?? "", type: "text" },
  { key: "trailing", get: (y) => y.trailingIncome, type: "numeric" },
  { key: "value", get: (y) => y.marketValue, type: "numeric" },
  { key: "currentYield", get: (y) => y.yield ?? "0", type: "numeric" },
  { key: "yieldOnCost", get: (y) => y.yieldOnCost ?? "0", type: "numeric" },
];

export function YieldsTable({ rows }: { rows: InstrumentYield[] }) {
  const t = useTranslations("Income");
  const locale = useLocale();
  const { sortKey, sortDir, toggle, sort } = useTableSort<InstrumentYield>(COLS);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("instrument")}</SortableTableHead>
          <SortableTableHead colKey="trailing" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("trailing")}</SortableTableHead>
          <SortableTableHead colKey="value" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("value")}</SortableTableHead>
          <SortableTableHead colKey="currentYield" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("currentYield")}</SortableTableHead>
          <SortableTableHead colKey="yieldOnCost" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("yieldOnCost")}</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sort(rows).map((y) => (
          <TableRow key={y.instrumentId}>
            <TableCell>
              <div className={TABLE_LABEL}>{y.symbol}</div>
              {y.name && <div className={TABLE_SUBLABEL}>{y.name}</div>}
            </TableCell>
            <TableCell className={TABLE_VALUE_STRONG}>
              {formatMoney(Number(y.trailingIncome), y.currency, locale)}
            </TableCell>
            <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>
              {formatMoney(Number(y.marketValue), y.currency, locale)}
            </TableCell>
            <TableCell className={TABLE_VALUE_STRONG}>
              {y.yield !== null ? formatPercent(Number(y.yield), locale) : "—"}
            </TableCell>
            <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>
              {y.yieldOnCost !== null
                ? formatPercent(Number(y.yieldOnCost), locale)
                : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
