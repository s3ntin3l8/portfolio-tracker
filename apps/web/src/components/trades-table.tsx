"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { ChevronRight, Info } from "lucide-react";
import type { Trade } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Badge } from "@/components/ui/badge";
import { Link } from "@/i18n/navigation";
import { TradeDetailSheet } from "@/components/trade-detail-sheet";
import { formatMoney, formatPercent, formatSignedMoney, cn } from "@/lib/utils";
import { useTableSort, type ColDef } from "@/lib/table-sort";

type Filter = "all" | "open" | "closed";

const COLS: ColDef<Trade>[] = [
  { key: "instrument", get: (t) => t.instrument?.symbol ?? "", type: "text" },
  { key: "entryDate", get: (t) => t.entryDate, type: "date" },
  { key: "exitDate", get: (t) => t.exitDate ?? "", type: "date" },
  { key: "held", get: (t) => t.holdingDays, type: "numeric" },
  { key: "quantity", get: (t) => Number(t.quantity), type: "numeric" },
  { key: "invested", get: (t) => Number(t.invested), type: "numeric" },
  { key: "realized", get: (t) => Number(t.realizedPnL), type: "numeric" },
  { key: "dividends", get: (t) => Number(t.dividends), type: "numeric" },
  { key: "totalReturn", get: (t) => Number(t.totalReturn), type: "numeric" },
  { key: "annualized", get: (t) => t.annualizedPct ?? 0, type: "numeric" },
];

const tradeKey = (t: Trade) => `${t.instrumentId}:${t.entryDate}`;

function toneClass(n: number): string {
  return n > 0 ? "text-success" : n < 0 ? "text-destructive" : "text-muted-foreground";
}

export interface TradesTableProps {
  trades: Trade[];
  currency: string;
}

export function TradesTable({ trades, currency }: TradesTableProps) {
  const t = useTranslations("Trades");
  const locale = useLocale();
  const { sortKey, sortDir, toggle, sort } = useTableSort<Trade>(COLS);
  const [filter, setFilter] = useState<Filter>("all");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Closed trades open the detail sheet (matches the design); open positions have no
  // exit date/price, so they keep the inline leg-expansion below instead.
  const [detailTrade, setDetailTrade] = useState<Trade | null>(null);

  const heldLabel = (days: number) =>
    days >= 365 ? `${(days / 365).toFixed(1)}${t("yearsAbbr")}` : `${days}${t("daysAbbr")}`;
  const money = (n: number, ccy = currency) => formatMoney(n, ccy, locale);
  const signed = (n: number) => formatSignedMoney(n, currency, locale);

  const visible = useMemo(() => {
    const filtered = trades.filter((tr) =>
      filter === "all" ? true : filter === "open" ? tr.status === "open" : tr.status === "closed",
    );
    return sort(filtered);
  }, [trades, filter, sort]);

  const toggleRow = (key: string) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const handleRowClick = (tr: Trade, key: string) => {
    if (tr.status === "closed") setDetailTrade(tr);
    else if (tr.legs.length > 0) toggleRow(key);
  };

  const FILTERS: Filter[] = ["all", "open", "closed"];

  return (
    <div className="space-y-3">
      <div className="inline-flex items-center rounded-lg border border-border bg-muted p-1 text-sm font-medium">
        {FILTERS.map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={cn(
              "rounded-md px-3 py-1 transition-colors",
              filter === f
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {t(`filter_${f}`)}
          </button>
        ))}
      </div>

      <div className="rounded-xl border border-border">
        {/* ── Desktop table (lg+) ── */}
        <div className="hidden overflow-x-auto lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("instrument")}</SortableTableHead>
                <SortableTableHead colKey="entryDate" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("entry")}</SortableTableHead>
                <SortableTableHead colKey="exitDate" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("exit")}</SortableTableHead>
                <SortableTableHead colKey="held" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("held")}</SortableTableHead>
                <SortableTableHead colKey="quantity" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("quantity")}</SortableTableHead>
                <SortableTableHead colKey="invested" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("invested")}</SortableTableHead>
                <SortableTableHead colKey="realized" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("realized")}</SortableTableHead>
                <SortableTableHead colKey="dividends" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("dividends")}</SortableTableHead>
                <SortableTableHead colKey="totalReturn" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">{t("totalReturn")}</SortableTableHead>
                <SortableTableHead colKey="annualized" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right">
                  <span className="inline-flex items-center gap-1" title={t("annualizedTooltip")}>
                    {t("annualized")}
                    <Info className="size-3 text-muted-foreground" aria-hidden />
                  </span>
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {visible.map((tr) => {
                const key = tradeKey(tr);
                const ret = Number(tr.totalReturn);
                const realized = Number(tr.realizedPnL);
                const isOpen = expanded.has(key);
                return (
                  <Fragment key={key}>
                    <TableRow
                      className="cursor-pointer"
                      onClick={() => handleRowClick(tr, key)}
                    >
                      <TableCell>
                        <div className="flex items-center gap-1.5">
                          {tr.status === "open" && (
                            <ChevronRight
                              className={cn(
                                "size-3.5 text-muted-foreground transition-transform",
                                tr.legs.length === 0 && "opacity-0",
                                isOpen && "rotate-90",
                              )}
                            />
                          )}
                          <div>
                            <Link
                              href={`/instruments/${tr.instrumentId}`}
                              className="font-medium hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {tr.instrument?.symbol ?? "—"}
                            </Link>
                            <div className="text-xs text-muted-foreground">
                              {tr.instrument?.name ?? tr.instrumentId}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={tr.status === "open" ? "default" : "outline"}>
                          {t(`status_${tr.status}`)}
                        </Badge>
                        <div className="mt-1 text-xs text-muted-foreground">{tr.entryDate}</div>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{tr.exitDate ?? "—"}</TableCell>
                      <TableCell className="tabular text-right">
                        {heldLabel(tr.holdingDays)}
                        {Math.abs(tr.holdingDays - tr.avgHoldingDays) > 7 && (
                          <div
                            className="text-xs text-muted-foreground"
                            title={t("avgHeldTooltip")}
                          >
                            ~{heldLabel(tr.avgHoldingDays)} {t("avgHeld")}
                          </div>
                        )}
                        {tr.longTerm && (
                          <div className="text-xs text-success">{t("longTerm")}</div>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {Number(tr.quantity)} {tr.instrument?.unit ?? ""}
                      </TableCell>
                      <TableCell className="tabular text-right">{money(Number(tr.invested))}</TableCell>
                      <TableCell className={cn("tabular text-right", toneClass(realized))}>
                        {realized === 0 ? "—" : signed(realized)}
                      </TableCell>
                      <TableCell className="tabular text-right">
                        {Number(tr.dividends) === 0 ? "—" : money(Number(tr.dividends))}
                      </TableCell>
                      <TableCell className={cn("tabular text-right", toneClass(ret))}>
                        {signed(ret)}
                        {tr.totalReturnPct !== null && (
                          <div className="text-xs">{formatPercent(tr.totalReturnPct, locale)}</div>
                        )}
                      </TableCell>
                      <TableCell className={cn("tabular text-right", toneClass(tr.annualizedPct ?? 0))}>
                        {tr.annualizedPct === null ? "—" : formatPercent(tr.annualizedPct, locale)}
                      </TableCell>
                    </TableRow>
                    {isOpen && (
                      <>
                        {tr.legs.map((leg, i) => (
                          <TableRow key={`${key}:leg:${i}`} className="bg-muted/40 text-xs">
                            <TableCell className="pl-9 text-muted-foreground" colSpan={2}>
                              {leg.acqDate} → {leg.sellDate}
                            </TableCell>
                            <TableCell />
                            <TableCell className="tabular text-right text-muted-foreground">
                              {leg.holdingDays >= 365 ? `${(leg.holdingDays / 365).toFixed(1)}${t("yearsAbbr")}` : `${leg.holdingDays}${t("daysAbbr")}`}
                            </TableCell>
                            <TableCell className="tabular text-right">{Number(leg.quantity)}</TableCell>
                            <TableCell className="tabular text-right">{money(Number(leg.cost))}</TableCell>
                            <TableCell className="tabular text-right">{money(Number(leg.proceeds))}</TableCell>
                            <TableCell />
                            <TableCell className={cn("tabular text-right", toneClass(Number(leg.gain)))}>
                              {signed(Number(leg.gain))}
                            </TableCell>
                            <TableCell className="text-right">
                              {leg.longTerm && <span className="text-success">{t("longTerm")}</span>}
                            </TableCell>
                          </TableRow>
                        ))}
                        {/* The legs carry no transaction ids, so link to the instrument's
                            full transaction list rather than to individual rows. */}
                        <TableRow className="bg-muted/40">
                          <TableCell colSpan={10} className="pl-9">
                            <Link
                              href={`/instruments/${tr.instrumentId}`}
                              className="text-xs font-medium text-primary hover:underline"
                              onClick={(e) => e.stopPropagation()}
                            >
                              {t("viewTransactions")} →
                            </Link>
                          </TableCell>
                        </TableRow>
                      </>
                    )}
                  </Fragment>
                );
              })}
            </TableBody>
          </Table>
        </div>

        {/* ── Mobile list (< lg) ── */}
        <div className="divide-y divide-border lg:hidden">
          {visible.map((tr) => {
            const ret = Number(tr.totalReturn);
            return (
              <div
                key={tradeKey(tr)}
                className={cn(
                  "flex items-start justify-between gap-3 p-4",
                  tr.status === "closed" && "cursor-pointer",
                )}
                onClick={() => tr.status === "closed" && setDetailTrade(tr)}
              >
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/instruments/${tr.instrumentId}`}
                      className="font-medium hover:underline truncate"
                    >
                      {tr.instrument?.symbol ?? "—"}
                    </Link>
                    <Badge variant={tr.status === "open" ? "default" : "outline"}>
                      {t(`status_${tr.status}`)}
                    </Badge>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {tr.entryDate}
                    {tr.exitDate ? ` → ${tr.exitDate}` : ""} · {heldLabel(tr.holdingDays)}
                  </div>
                </div>
                <div className="text-right tabular">
                  <div className={cn("text-sm font-medium", toneClass(ret))}>{signed(ret)}</div>
                  {tr.totalReturnPct !== null && (
                    <div className={cn("text-xs", toneClass(ret))}>
                      {formatPercent(tr.totalReturnPct, locale)}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <TradeDetailSheet
        trade={detailTrade}
        currency={currency}
        open={detailTrade !== null}
        onOpenChange={(o) => !o && setDetailTrade(null)}
      />
    </div>
  );
}
