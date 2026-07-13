"use client";

import { useTranslations, useLocale } from "next-intl";
import type { LotView } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { formatMoney } from "@/lib/utils";

const LOT_COLS: ColDef<LotView>[] = [
  { key: "acqDate", get: (l) => l.acqDate, type: "date" },
  { key: "qty", get: (l) => Number(l.qty), type: "numeric" },
  { key: "price", get: (l) => Number(l.unitCost), type: "numeric" },
  { key: "cost", get: (l) => Number(l.cost), type: "numeric" },
];

/** Standing open FIFO lots for one instrument (oldest acquisition first). */
export function InstrumentLotsTable({
  lots,
  currency,
}: {
  lots: LotView[];
  currency: string;
}) {
  const t = useTranslations("Instrument");
  const locale = useLocale();
  const qtyFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 8 });
  const dateFmt = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });
  const { sortKey, sortDir, toggle, sort } = useTableSort<LotView>(LOT_COLS);

  if (lots.length === 0) return null;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <SortableTableHead colKey="acqDate" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("lotAcquired")}</SortableTableHead>
          <SortableTableHead colKey="qty" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("lotQty")}</SortableTableHead>
          <SortableTableHead colKey="price" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("lotPrice")}</SortableTableHead>
          <SortableTableHead colKey="cost" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("lotCost")}</SortableTableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {sort(lots).map((lot, i) => (
          <TableRow key={`${lot.acqDate}-${i}`}>
            <TableCell>{dateFmt.format(new Date(lot.acqDate))}</TableCell>
            <TableCell className="text-right">
              {qtyFmt.format(Number(lot.qty))}
            </TableCell>
            <TableCell className="text-right">
              {formatMoney(Number(lot.unitCost), currency, locale)}
            </TableCell>
            <TableCell className="text-right">
              {formatMoney(Number(lot.cost), currency, locale)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
