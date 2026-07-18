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
import { ID_SALES_TAX_RATE } from "@portfolio/core";
import type { IdDisposalTax } from "@portfolio/core";
import type { TaxDisposalLot } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { useExpandedRows } from "./use-expanded-rows";
import { DisposalCell, LotRow } from "./disposal-cells";
import type { TaxTranslator } from "./tax-cards";

const ID_SALES_COLS: ColDef<IdDisposalTax>[] = [
  { key: "disposal", get: (r) => `${r.symbol} ${r.when}`, type: "text" },
  { key: "proceeds", get: (r) => Number(r.proceeds), type: "numeric" },
  { key: "tax", get: (r) => Number(r.tax), type: "numeric" },
];

/** "Share sales · 0.1% final" disposal table — the Indonesian counterpart to
 *  `DisposalTable` above, same aggregate-row + collapsible-lot-detail treatment. Each
 *  lot's tax share is computed client-side (proceeds × 0.1%, the same flat rate
 *  `indonesianFinalTax` applies to the aggregate) since the core computation only
 *  prices the aggregate row, not individual lots. */
export function IdSalesTable({
  rows,
  totalProceeds,
  totalSalesTax,
  currency,
  locale,
  year,
}: {
  rows: IdDisposalTax[];
  totalProceeds: string;
  totalSalesTax: string;
  currency: string;
  locale: string;
  year: number;
}) {
  const t = useTranslations("Tax") as unknown as TaxTranslator;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { expanded, toggle } = useExpandedRows();
  const { sortKey, sortDir, toggle: toggleSort, sort } = useTableSort<IdDisposalTax>(ID_SALES_COLS);
  const salesRate = Number(ID_SALES_TAX_RATE);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("id.sales.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("id.sales.empty", { year })}</p>
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
                  {t("id.sales.disposal")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="proceeds"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                  align="right"
                  className="w-[27%]"
                >
                  {t("id.sales.proceeds")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="tax"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggleSort}
                  align="right"
                  className="w-[27%]"
                >
                  {t("id.sales.tax")}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sort(rows).map((r) => {
                const key = `${r.instrumentId ?? r.symbol}:${r.when}`;
                const lots = r.lots ?? [];
                const hasLots = lots.length > 1;
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <TableRow
                      className={hasLots ? "cursor-pointer" : undefined}
                      onClick={hasLots ? () => toggle(key) : undefined}
                    >
                      <DisposalCell
                        row={{
                          symbol: r.symbol,
                          when: r.when,
                          instrumentId: r.instrumentId ?? null,
                          proceeds: r.proceeds,
                          gain: "0",
                          tfRate: "0",
                          gainAdjusted: "0",
                          quantity: r.quantity ?? "0",
                          avgBuyPrice: r.avgBuyPrice ?? "0",
                          sellPrice: r.sellPrice ?? "0",
                          lots: lots as TaxDisposalLot[],
                        }}
                        money={money}
                        t={t}
                        isOpen={isOpen}
                      />
                      <TableCell className="tabular text-right text-muted-foreground">
                        {money(r.proceeds)}
                      </TableCell>
                      <TableCell className="tabular text-right font-semibold">
                        {money(r.tax)}
                      </TableCell>
                    </TableRow>
                    {isOpen &&
                      lots.map((lot, li) => (
                        <LotRow
                          key={`${key}:lot:${li}`}
                          lot={lot as TaxDisposalLot}
                          money={money}
                          secondaryValue={money((Number(lot.proceeds) * salesRate).toFixed(2))}
                          secondaryClassName="font-medium"
                        />
                      ))}
                  </Fragment>
                );
              })}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("id.sales.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold text-muted-foreground">
                  {money(totalProceeds)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {money(totalSalesTax)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
