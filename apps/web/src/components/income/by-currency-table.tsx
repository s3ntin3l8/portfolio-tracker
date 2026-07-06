"use client";

import { useTranslations, useLocale } from "next-intl";
import type { CurrencyIncome } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
  TABLE_LABEL,
  TABLE_VALUE,
  TABLE_VALUE_STRONG,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { formatMoney, cn } from "@/lib/utils";
import { useTableSort } from "@/lib/table-sort";
import type { ColDef } from "@/lib/table-sort";

const COLS: ColDef<CurrencyIncome>[] = [
  { key: "currency", get: (c) => c.currency, type: "text" },
  { key: "native", get: (c) => c.totalNative, type: "numeric" },
  { key: "normalized", get: (c) => c.totalNormalized, type: "numeric" },
];

export interface ByCurrencyTableProps {
  rows: CurrencyIncome[];
  displayCurrency: string;
}

export function ByCurrencyTable({ rows, displayCurrency }: ByCurrencyTableProps) {
  const t = useTranslations("Income");
  const locale = useLocale();
  const { sortKey, sortDir, toggle, sort } = useTableSort<CurrencyIncome>(COLS);

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="currency" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("type")}</SortableTableHead>
          <SortableTableHead colKey="native" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("native")}</SortableTableHead>
          <SortableTableHead colKey="normalized" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("normalized")}</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sort(rows).map((c) => (
          <TableRow key={c.currency}>
            <TableCell className={TABLE_LABEL}>{c.currency}</TableCell>
            <TableCell className={TABLE_VALUE_STRONG}>
              {formatMoney(Number(c.totalNative), c.currency, locale)}
            </TableCell>
            <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>
              {formatMoney(Number(c.totalNormalized), displayCurrency, locale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
