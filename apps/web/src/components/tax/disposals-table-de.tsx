"use client";

import { Fragment } from "react";
import { useTranslations } from "next-intl";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import type { TaxDisposalRow } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { useExpandedRows } from "./use-expanded-rows";
import { DisposalCell, LotRow } from "./disposal-cells";
import type { TaxTranslator } from "./tax-cards";

const DISPOSAL_COLS: ColDef<TaxDisposalRow>[] = [
  { key: "disposal", get: (r) => `${r.symbol} ${r.when}`, type: "text" },
  { key: "proceeds", get: (r) => Number(r.proceeds), type: "numeric" },
  { key: "gain", get: (r) => Number(r.gain), type: "numeric" },
];

/** "Realized gains · Abgeltungsteuer" disposal table — one row per aggregate disposal
 *  (an ETF bought in several tranches, sold in one order collapses to a single row
 *  with an avg buy → sell summary); expand to see the individual FIFO lots. Reuses the
 *  trade log's per-leg proceeds/gain (no recomputation); `rows` is already scoped to
 *  the selected tax year. */
export function DisposalTable({
  rows,
  totalProceeds,
  totalGain,
  currency,
  locale,
  year,
}: {
  rows: TaxDisposalRow[];
  totalProceeds: string;
  totalGain: string;
  currency: string;
  locale: string;
  year: number;
}) {
  const t = useTranslations("Tax") as unknown as TaxTranslator;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { expanded, toggle } = useExpandedRows();
  const {
    sortKey,
    sortDir,
    toggle: toggleSort,
    sort,
  } = useTableSort<TaxDisposalRow>(DISPOSAL_COLS);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("disposals.title")}</CardTitle>
        <p className="text-xs text-muted-foreground">{t("disposals.subtitle")}</p>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("disposals.empty", { year })}</p>
        ) : (
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  colKey="disposal"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                  className="w-[46%]"
                >
                  {t("disposals.disposal")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="proceeds"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                  align="right"
                  className="w-[27%]"
                >
                  {t("disposals.proceeds")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="gain"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                  align="right"
                  className="w-[27%]"
                >
                  {t("disposals.gain")}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort(rows).map((r) => {
                const key = `${r.instrumentId ?? r.symbol}:${r.when}`;
                const hasLots = r.lots.length > 1;
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <TableRow
                      className={hasLots ? "cursor-pointer" : undefined}
                      onClick={hasLots ? () => toggle(key) : undefined}
                    >
                      <DisposalCell row={r} money={money} t={t} isOpen={isOpen} />
                      <TableCell className="tabular text-right text-muted-foreground">
                        {money(r.proceeds)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        <span className="font-semibold text-emerald-600 dark:text-emerald-400">
                          {money(r.gain)}
                        </span>
                        {Number(r.tfRate) > 0 && (
                          <div className="text-xs font-normal text-muted-foreground">
                            {t("disposals.tfAdjusted", {
                              adjusted: money(r.gainAdjusted),
                              pct: Math.round(Number(r.tfRate) * 100),
                            })}
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                    {isOpen &&
                      r.lots.map((lot, li) => (
                        <LotRow
                          key={`${key}:lot:${li}`}
                          lot={lot}
                          money={money}
                          secondaryValue={money(lot.gain)}
                          secondaryClassName="font-medium text-emerald-600 dark:text-emerald-400"
                        />
                      ))}
                  </Fragment>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("disposals.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {money(totalProceeds)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                  {money(totalGain)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
