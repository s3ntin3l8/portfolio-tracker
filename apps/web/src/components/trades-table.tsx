"use client";

import { Fragment, useMemo, useState } from "react";
import { useTranslations, useLocale } from "next-intl";
import { ChevronRight, Info, Search, X } from "lucide-react";
import type { Trade } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHeader,
  TableRow,
  TABLE_LABEL,
  TABLE_SUBLABEL,
  TABLE_VALUE,
  TABLE_VALUE_STRONG,
  TABLE_SUBVALUE,
} from "@/components/ui/table";
import { SortableTableHead } from "@/components/ui/sortable-table-head";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { MonogramBadge } from "@/components/monogram-badge";
import { Link } from "@/i18n/navigation";
import { TradeDetailSheet } from "@/components/trade-detail-sheet";
import { formatMoney, formatPercent, formatSignedMoney, cn } from "@/lib/utils";
import { useTableSort, type ColDef } from "@/lib/table-sort";

type StatusFilter = "all" | "open" | "closed";

const COLS: ColDef<Trade>[] = [
  { key: "instrument", get: (t) => t.instrument?.symbol ?? "", type: "text" },
  { key: "entryDate", get: (t) => t.entryDate, type: "date" },
  { key: "exitDate", get: (t) => t.exitDate, type: "date" },
  { key: "held", get: (t) => t.holdingDays, type: "numeric" },
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
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  // Closed trades open the detail sheet (matches the design); open positions have no
  // exit date/price, so they keep the inline leg-expansion below instead.
  const [detailTrade, setDetailTrade] = useState<Trade | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [query, setQuery] = useState("");

  const heldLabel = (days: number) =>
    days >= 365 ? `${(days / 365).toFixed(1)}${t("yearsAbbr")}` : `${days}${t("daysAbbr")}`;
  const money = (n: number, ccy = currency) => formatMoney(n, ccy, locale);
  const signed = (n: number) => formatSignedMoney(n, currency, locale);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return trades.filter((tr) => {
      if (statusFilter !== "all" && tr.status !== statusFilter) return false;
      if (!q) return true;
      const symbol = tr.instrument?.symbol?.toLowerCase() ?? "";
      const name = (tr.instrument?.displayName ?? tr.instrument?.name ?? "").toLowerCase();
      return symbol.includes(q) || name.includes(q);
    });
  }, [trades, statusFilter, query]);
  const visible = useMemo(() => sort(filtered), [filtered, sort]);

  // Totals footer — closed trades only (an open position's realized P&L isn't final).
  const closedTotal = useMemo(
    () =>
      trades
        .filter((tr) => tr.status === "closed")
        .reduce((s, tr) => s + Number(tr.realizedPnL), 0),
    [trades],
  );

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

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center">
        {/* Chips scroll horizontally on mobile (no awkward multi-line wrap); wrap on
            desktop. Same reference pattern as the Activity/transactions filter row. */}
        <div className="flex items-center gap-2 overflow-x-auto pb-0.5 [scrollbar-width:none] sm:flex-wrap sm:overflow-visible sm:pb-0 [&::-webkit-scrollbar]:hidden">
          {(
            [
              ["all", t("filter_all")],
              ["open", t("filter_open")],
              ["closed", t("filter_closed")],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              aria-pressed={statusFilter === key}
              className={cn(
                "whitespace-nowrap rounded-full px-3.5 py-[7px] text-xs",
                statusFilter === key
                  ? "bg-pill font-bold text-white"
                  : "border border-border bg-card font-semibold text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="relative flex items-center sm:ml-auto">
          <Search className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground" />
          <Input
            type="text"
            placeholder={t("searchPlaceholder")}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="h-8 w-full pl-7 pr-7 text-xs sm:w-44"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              aria-label={t("searchClear")}
              className="absolute right-2 text-muted-foreground hover:text-foreground"
            >
              <X className="size-3.5" />
            </button>
          )}
        </div>
      </div>

      {visible.length === 0 ? (
        <div className="rounded-xl bg-card p-8 text-center text-sm text-muted-foreground shadow-card">
          {t("noMatches")}
        </div>
      ) : (
      <div className="rounded-xl bg-card shadow-card">
        {/* ── Desktop table (lg+) ── */}
        <div className="hidden overflow-x-auto lg:block">
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead colKey="instrument" sortKey={sortKey} sortDir={sortDir} onToggle={toggle}>{t("instrument")}</SortableTableHead>
                <SortableTableHead colKey="entryDate" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} className="whitespace-nowrap">{t("period")}</SortableTableHead>
                <SortableTableHead colKey="held" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">{t("held")}</SortableTableHead>
                <SortableTableHead colKey="invested" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">{t("invested")}</SortableTableHead>
                <SortableTableHead colKey="realized" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">{t("realized")}</SortableTableHead>
                <SortableTableHead colKey="dividends" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">{t("dividends")}</SortableTableHead>
                <SortableTableHead colKey="totalReturn" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">{t("totalReturn")}</SortableTableHead>
                <SortableTableHead colKey="annualized" sortKey={sortKey} sortDir={sortDir} onToggle={toggle} align="right" className="whitespace-nowrap">
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
                        <div className="relative flex items-center gap-2">
                          <ChevronRight
                            className={cn(
                              "absolute -left-4 size-3.5 text-muted-foreground transition-transform",
                              (tr.status !== "open" || tr.legs.length === 0) && "opacity-0",
                              isOpen && "rotate-90",
                            )}
                          />
                          <MonogramBadge
                            label={tr.instrument?.symbol ?? tr.instrumentId}
                            assetClass={tr.instrument?.assetClass}
                            className="shrink-0"
                          />
                          <div className="min-w-0 max-w-[130px]">
                            <div className="flex min-w-0 items-center gap-1.5">
                              <Link
                                href={`/instruments/${tr.instrumentId}`}
                                className={cn(TABLE_LABEL, "min-w-0 truncate hover:underline")}
                                onClick={(e) => e.stopPropagation()}
                              >
                                {tr.instrument?.symbol ?? "—"}
                              </Link>
                              <Badge
                                variant={tr.status === "open" ? "default" : "outline"}
                                className="shrink-0"
                              >
                                {t(`status_${tr.status}`)}
                              </Badge>
                            </div>
                            <div className={cn(TABLE_SUBLABEL, "truncate")}>
                              {tr.instrument?.displayName ?? tr.instrument?.name ?? tr.instrumentId}
                            </div>
                          </div>
                        </div>
                      </TableCell>
                      <TableCell className={cn(TABLE_SUBLABEL, "whitespace-nowrap")}>
                        {tr.entryDate}
                        {tr.exitDate ? ` → ${tr.exitDate}` : ""}
                      </TableCell>
                      <TableCell className={cn(TABLE_VALUE, "whitespace-nowrap")}>
                        {heldLabel(tr.holdingDays)}
                        {Math.abs(tr.holdingDays - tr.avgHoldingDays) > 7 && (
                          <div
                            className={cn(TABLE_SUBVALUE, "text-muted-foreground")}
                            title={t("avgHeldTooltip")}
                          >
                            ~{heldLabel(tr.avgHoldingDays)} {t("avgHeld")}
                          </div>
                        )}
                        {tr.longTerm && (
                          <div className={cn(TABLE_SUBVALUE, "text-success")}>{t("longTerm")}</div>
                        )}
                      </TableCell>
                      <TableCell className={cn(TABLE_VALUE, "whitespace-nowrap")}>{money(Number(tr.invested))}</TableCell>
                      <TableCell className={cn(TABLE_VALUE_STRONG, "whitespace-nowrap", toneClass(realized))}>
                        {realized === 0 ? "—" : signed(realized)}
                      </TableCell>
                      <TableCell className={cn(TABLE_VALUE, "whitespace-nowrap")}>
                        {Number(tr.dividends) === 0 ? "—" : money(Number(tr.dividends))}
                      </TableCell>
                      <TableCell className={cn(TABLE_VALUE_STRONG, "whitespace-nowrap", toneClass(ret))}>
                        {signed(ret)}
                        {tr.totalReturnPct !== null && (
                          <div className={TABLE_SUBVALUE}>{formatPercent(tr.totalReturnPct, locale)}</div>
                        )}
                      </TableCell>
                      <TableCell className={cn(TABLE_VALUE_STRONG, "whitespace-nowrap", toneClass(tr.annualizedPct ?? 0))}>
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
                            <TableCell className="tabular text-right text-muted-foreground">
                              {leg.holdingDays >= 365 ? `${(leg.holdingDays / 365).toFixed(1)}${t("yearsAbbr")}` : `${leg.holdingDays}${t("daysAbbr")}`}
                            </TableCell>
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
                          <TableCell colSpan={8} className="pl-9">
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
            <TableFooter>
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4}>{t("totalRealized")}</TableCell>
                <TableCell
                  className={cn(
                    "tabular text-right text-[13px]",
                    closedTotal > 0
                      ? "text-success"
                      : closedTotal < 0
                        ? "text-destructive"
                        : "",
                  )}
                >
                  {signed(closedTotal)}
                </TableCell>
                <TableCell colSpan={3} />
              </TableRow>
            </TableFooter>
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
                <div className="flex min-w-0 items-start gap-2.5">
                  <MonogramBadge
                    label={tr.instrument?.symbol ?? tr.instrumentId}
                    assetClass={tr.instrument?.assetClass}
                    className="mt-0.5 size-[42px] rounded-[13px]"
                  />
                  <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/instruments/${tr.instrumentId}`}
                      className={cn(TABLE_LABEL, "truncate hover:underline")}
                    >
                      {tr.instrument?.symbol ?? "—"}
                    </Link>
                    <Badge variant={tr.status === "open" ? "default" : "outline"}>
                      {t(`status_${tr.status}`)}
                    </Badge>
                  </div>
                  <div className={cn(TABLE_SUBLABEL, "truncate")}>
                    {tr.instrument?.displayName ?? tr.instrument?.name ?? tr.instrumentId}
                  </div>
                  <div className={TABLE_SUBLABEL}>
                    {tr.entryDate}
                    {tr.exitDate ? ` → ${tr.exitDate}` : ""} · {heldLabel(tr.holdingDays)}
                  </div>
                  </div>
                </div>
                <div className="text-right tabular">
                  <div className={cn("text-sm font-bold", toneClass(ret))}>{signed(ret)}</div>
                  {tr.totalReturnPct !== null && (
                    <div className={cn(TABLE_SUBVALUE, toneClass(ret))}>
                      {formatPercent(tr.totalReturnPct, locale)}
                    </div>
                  )}
                  {tr.annualizedPct !== null && (
                    <div
                      className={cn(TABLE_SUBVALUE, toneClass(tr.annualizedPct))}
                      title={t("annualizedTooltip")}
                    >
                      {formatPercent(tr.annualizedPct, locale)}
                      {t("annualizedAbbr")}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
      )}

      <TradeDetailSheet
        trade={detailTrade}
        currency={currency}
        open={detailTrade !== null}
        onOpenChange={(o) => !o && setDetailTrade(null)}
      />
    </div>
  );
}
