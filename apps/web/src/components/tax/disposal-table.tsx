"use client";

import { Fragment, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronRight } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ID_SALES_TAX_RATE } from "@portfolio/core";
import type { IdDisposalTax } from "@portfolio/core";
import type { TaxDisposalLot, TaxDisposalRow } from "@/lib/server-api";
import { cn, formatMoney } from "@/lib/utils";
import type { TaxTranslator } from "./tax-cards";

/** Row-expansion state shared by both tables below — keyed by `symbol:when`, the same
 *  key `loadTaxYearDetail` groups disposals on. */
function useExpandedRows() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  return { expanded, toggle };
}

/** The "Disposal" cell for an aggregate row — symbol + sell date, plus (when the
 *  disposal spans more than one FIFO lot) a muted "avg buy → sell · N lots" sub-line
 *  and a chevron affordance. Single-lot disposals render exactly as before. */
function DisposalCell({
  row,
  money,
  t,
  isOpen,
}: {
  row: TaxDisposalRow;
  money: (n: string | number) => string;
  t: TaxTranslator;
  isOpen: boolean;
}) {
  const hasLots = row.lots.length > 1;
  return (
    <TableCell>
      <div className={cn("relative", hasLots && "pl-4")}>
        {hasLots && (
          <ChevronRight
            className={cn(
              "absolute -left-0.5 top-0.5 size-3.5 text-muted-foreground transition-transform",
              isOpen && "rotate-90",
            )}
          />
        )}
        <span className="font-medium">{row.symbol}</span>{" "}
        <span className="text-xs text-muted-foreground">{row.when}</span>
        {hasLots && (
          <div className="text-xs text-muted-foreground">
            {t("disposals.lotsLine", {
              buy: money(row.avgBuyPrice),
              sell: money(row.sellPrice),
              count: row.lots.length,
            })}
          </div>
        )}
      </div>
    </TableCell>
  );
}

/** One consumed FIFO lot, rendered under its expanded aggregate row. `secondaryValue`
 *  is already money-formatted — the German table passes the lot's gain, the
 *  Indonesian table passes the lot's proceeds-based 0.1% tax share. */
function LotRow({
  lot,
  money,
  secondaryValue,
  secondaryClassName,
}: {
  lot: TaxDisposalLot;
  money: (n: string | number) => string;
  secondaryValue: string;
  secondaryClassName?: string;
}) {
  return (
    <TableRow className="bg-muted/40 text-xs hover:bg-muted/40">
      <TableCell className="pl-9 text-muted-foreground">
        {lot.acqDate} · {lot.quantity} @ {money(lot.buyPrice)} → {money(lot.sellPrice)}
      </TableCell>
      <TableCell className="tabular text-right text-muted-foreground">
        {money(lot.proceeds)}
      </TableCell>
      <TableCell className={cn("tabular text-right", secondaryClassName)}>
        {secondaryValue}
      </TableCell>
    </TableRow>
  );
}

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
  // A function prop (`money`/`t`) can't cross the server→client boundary — this is a
  // client component, so it derives both locally from serializable `currency`/`locale`
  // props instead of receiving closures from the (server) tax page.
  const t = useTranslations("Tax") as unknown as TaxTranslator;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { expanded, toggle } = useExpandedRows();
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
          // table-fixed: column widths are set ONCE from the header row and never
          // recomputed from later content. Without this, table-layout:auto (the
          // default) reflows all columns whenever a wide cell enters the DOM — e.g.
          // expanding a multi-lot row's long "date · qty @ buy → sell" text, or the
          // Tf-adjusted sub-line under Gain — visibly shifting Proceeds/Gain sideways.
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[46%]">{t("disposals.disposal")}</TableHead>
                <TableHead className="w-[27%] text-right">{t("disposals.proceeds")}</TableHead>
                <TableHead className="w-[27%] text-right">{t("disposals.gain")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const key = `${r.symbol}:${r.when}:${i}`;
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
  // See DisposalTable's comment — function props can't cross the server→client
  // boundary, so `t`/`money` are derived locally rather than passed in.
  const t = useTranslations("Tax") as unknown as TaxTranslator;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { expanded, toggle } = useExpandedRows();
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
          // table-fixed — see DisposalTable's identical comment above.
          <Table className="table-fixed">
            <TableHeader>
              <TableRow>
                <TableHead className="w-[46%]">{t("id.sales.disposal")}</TableHead>
                <TableHead className="w-[27%] text-right">{t("id.sales.proceeds")}</TableHead>
                <TableHead className="w-[27%] text-right">{t("id.sales.tax")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => {
                const key = `${r.symbol}:${r.when}:${i}`;
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
                          proceeds: r.proceeds,
                          gain: "0",
                          // Indonesian final tax has no Teilfreistellung concept — this
                          // row shape only exists to satisfy DisposalCell's prop type.
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
