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

  const sorted = sort(lots);

  return (
    <>
      <div className="hidden md:block">
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
            {sorted.map((lot, i) => (
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
      </div>
      <div className="space-y-3 md:hidden">
        {sorted.map((lot, i) => (
          <div key={`${lot.acqDate}-${i}`} className="rounded-[20px] bg-card shadow-card px-4 py-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-medium">{dateFmt.format(new Date(lot.acqDate))}</div>
                <div className="mt-0.5 text-xs text-muted-foreground">
                  {t("lotQty")}: {qtyFmt.format(Number(lot.qty))}
                </div>
              </div>
              <div className="text-right">
                <div className="font-medium tabular-nums">
                  {formatMoney(Number(lot.cost), currency, locale)}
                </div>
                <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                  {formatMoney(Number(lot.unitCost), currency, locale)}
                </div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
