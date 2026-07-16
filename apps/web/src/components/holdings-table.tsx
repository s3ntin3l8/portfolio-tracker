"use client";

import { useTranslations, useLocale } from "next-intl";
import type { HoldingValuation } from "@portfolio/api-client";
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
import { MonogramBadge } from "@/components/monogram-badge";
import { HoldingSparkline } from "@/components/holding-sparkline";
import { Link, useRouter } from "@/i18n/navigation";
import { formatMoney, formatPercent, formatSignedMoney, formatQuantity, cn } from "@/lib/utils";
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

function computeRowValues(h: HoldingValuation, currency: string, locale: string) {
  const pnl = h.unrealizedPnLDisplay !== null ? Number(h.unrealizedPnLDisplay) : null;
  const costBasis = Number(h.costBasisDisplay);
  const pct = pnl !== null && costBasis !== 0 ? (pnl / costBasis) * 100 : null;
  const native = (n: number) => formatMoney(n, h.currency ?? currency, locale);
  const display = (n: number) => formatMoney(n, currency, locale);
  return { pnl, pct, native, display };
}

export interface HoldingsTableProps {
  rows: HoldingValuation[];
  currency: string;
  /** Per-currency cash balances for cash-inclusive portfolios. When provided, a pinned
   *  Cash row is rendered after the security rows (one row per currency). Cash is
   *  included in the footer total, assuming cash currency == display currency (true for
   *  virtually all cash-counted portfolios; no FX conversion is applied). */
  cash?: Record<string, string>;
}

export function HoldingsTable({ rows, currency, cash }: HoldingsTableProps) {
  const t = useTranslations("Holdings");
  const locale = useLocale();
  const router = useRouter();
  const { sortKey, sortDir, toggle, sort } = useTableSort<HoldingValuation>(HOLDINGS_COLS);

  const sorted = sort(rows);

  // Non-zero cash entries to render as pinned rows (one per currency).
  const cashEntries = Object.entries(cash ?? {}).filter(([, v]) => Number(v) !== 0);

  // Column totals across the (already class-filtered) visible rows. Market value and
  // P&L sum only the priced holdings — unpriced ones (marketValueDisplay === null) are
  // skipped, matching how net worth ignores instruments without a live quote. The total
  // P&L % is taken against summed cost basis so it stays consistent with the rows.
  // Cash is included in the value total (assumes cash currency == display currency,
  // true for virtually all cash-counted portfolios; no FX conversion is applied).
  const totals = rows.reduce(
    (acc, h) => {
      if (h.marketValueDisplay !== null) acc.value += Number(h.marketValueDisplay);
      if (h.unrealizedPnLDisplay !== null) acc.pnl += Number(h.unrealizedPnLDisplay);
      acc.cost += Number(h.costBasisDisplay);
      return acc;
    },
    {
      value: cashEntries.reduce((s, [, v]) => s + Number(v), 0),
      pnl: 0,
      cost: 0,
    },
  );
  const totalPct = totals.cost !== 0 ? (totals.pnl / totals.cost) * 100 : null;
  const totalPnlColor = totals.pnl > 0 ? "text-success" : totals.pnl < 0 ? "text-destructive" : "";
  const money = (n: number) => formatMoney(n, currency, locale);

  return (
    <>
      {/* ── Desktop table (md+) ── */}
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                colKey="instrument"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("instrument")}
              </SortableTableHead>
              <SortableTableHead
                colKey="quantity"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("quantity")}
              </SortableTableHead>
              <SortableTableHead
                colKey="avgCost"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("avgCost")}
              </SortableTableHead>
              <SortableTableHead
                colKey="price"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("price")}
              </SortableTableHead>
              <SortableTableHead
                colKey="value"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("value")}
              </SortableTableHead>
              <SortableTableHead
                colKey="pnl"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("pnl")}
              </SortableTableHead>
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
                <TableRow
                  key={h.instrumentId}
                  className="cursor-pointer"
                  onClick={() => router.push(`/instruments/${h.instrumentId}`)}
                >
                  <TableCell>
                    <div className="flex items-center gap-3">
                      <MonogramBadge
                        label={h.instrument?.symbol ?? h.instrumentId}
                        assetClass={h.instrument?.assetClass}
                      />
                      <div>
                        <Link
                          href={`/instruments/${h.instrumentId}`}
                          className={cn(TABLE_LABEL, "hover:underline")}
                          onClick={(e) => e.stopPropagation()}
                        >
                          {h.instrument?.symbol ?? "—"}
                        </Link>
                        <div className={TABLE_SUBLABEL}>
                          {h.instrument?.displayName ?? h.instrument?.name ?? h.instrumentId}
                        </div>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell className={TABLE_VALUE}>
                    {formatQuantity(Number(h.quantity), h.instrument?.unit, locale)}
                  </TableCell>
                  <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>
                    {native(Number(h.avgCost))}
                  </TableCell>
                  <TableCell className={TABLE_VALUE}>
                    {h.price !== null ? native(Number(h.price)) : "—"}
                  </TableCell>
                  <TableCell className={TABLE_VALUE_STRONG}>
                    {h.marketValueDisplay !== null ? display(Number(h.marketValueDisplay)) : "—"}
                  </TableCell>
                  <TableCell className={cn(TABLE_VALUE_STRONG, pnlColor)}>
                    {pnl === null ? "—" : formatSignedMoney(pnl, currency, locale)}
                    {pct !== null && (
                      <div className={TABLE_SUBVALUE}>{formatPercent(pct / 100, locale)}</div>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {cashEntries.map(([ccy, balance]) => (
              <TableRow key={`cash-${ccy}`}>
                <TableCell>
                  <div className="flex items-center gap-3">
                    <MonogramBadge label={ccy} assetClass="cash" />
                    <div>
                      <span className={TABLE_LABEL}>{t("cash")}</span>
                      <div className={TABLE_SUBLABEL}>{ccy}</div>
                    </div>
                  </div>
                </TableCell>
                <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>—</TableCell>
                <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>—</TableCell>
                <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>—</TableCell>
                <TableCell className={TABLE_VALUE_STRONG}>
                  {formatMoney(Number(balance), ccy, locale)}
                </TableCell>
                <TableCell className={cn(TABLE_VALUE, "text-text-mute")}>—</TableCell>
              </TableRow>
            ))}
          </TableBody>
          <TableFooter>
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={4}>{t("total")}</TableCell>
              <TableCell className="tabular text-right">{money(totals.value)}</TableCell>
              <TableCell className={cn("tabular text-right text-[13px]", totalPnlColor)}>
                {formatSignedMoney(totals.pnl, currency, locale)}
                {totalPct !== null && (
                  <div className="text-[11px] font-bold">
                    {formatPercent(totalPct / 100, locale)}
                  </div>
                )}
              </TableCell>
            </TableRow>
          </TableFooter>
        </Table>
      </div>

      {/* ── Mobile list (< md) ── reference row: badge, symbol over "name · quantity",
          a price-course sparkline, then value + percent. No avg-cost/price columns. ── */}
      <div className="md:hidden flex flex-col">
        {sorted.map((h, i) => {
          const { pnl, pct, display } = computeRowValues(h, currency, locale);
          const pnlColor =
            pnl === null ? "text-muted-foreground" : pnl >= 0 ? "text-success" : "text-destructive";
          const qty = formatQuantity(Number(h.quantity), h.instrument?.unit, locale);
          const name = h.instrument?.displayName ?? h.instrument?.name ?? h.instrumentId;
          const subtitle = qty ? `${name} · ${qty}` : name;
          const hasSpark = (h.sparkline?.length ?? 0) >= 2;
          return (
            <div
              key={h.instrumentId}
              className={cn(
                "flex cursor-pointer items-center gap-3 py-3 pl-4 pr-4",
                i > 0 && "border-t border-border",
              )}
              onClick={() => router.push(`/instruments/${h.instrumentId}`)}
            >
              <MonogramBadge
                label={h.instrument?.symbol ?? h.instrumentId}
                assetClass={h.instrument?.assetClass}
                className="size-[42px] rounded-[13px]"
              />
              <div className="min-w-0 flex-1">
                <Link
                  href={`/instruments/${h.instrumentId}`}
                  onClick={(e) => e.stopPropagation()}
                  className="block truncate text-[15px] font-bold hover:underline"
                >
                  {h.instrument?.symbol ?? "—"}
                </Link>
                <div className="truncate text-xs font-medium text-text-2">{subtitle}</div>
              </div>
              {hasSpark && <HoldingSparkline values={h.sparkline!} />}
              <div className="shrink-0 text-right tabular">
                <div className="text-sm font-bold">
                  {h.marketValueDisplay !== null ? display(Number(h.marketValueDisplay)) : "—"}
                </div>
                <div className={cn("text-xs font-bold", pnlColor)}>
                  {pct !== null ? formatPercent(pct / 100, locale) : "—"}
                </div>
              </div>
            </div>
          );
        })}

        {cashEntries.map(([ccy, balance], ci) => (
          <div
            key={`cash-${ccy}`}
            className={cn(
              "flex items-center gap-3 py-3 pl-4 pr-4",
              (sorted.length > 0 || ci > 0) && "border-t border-border",
            )}
          >
            <MonogramBadge label={ccy} assetClass="cash" className="size-[42px] rounded-[13px]" />
            <div className="min-w-0 flex-1">
              <span className="text-[15px] font-bold">{t("cash")}</span>
              <div className="truncate text-xs font-medium text-text-2">{ccy}</div>
            </div>
            <div className="shrink-0 text-right tabular text-sm font-bold">
              {formatMoney(Number(balance), ccy, locale)}
            </div>
          </div>
        ))}

        {/* Totals row */}
        <div className="flex items-center gap-3 border-t-2 border-border py-3 pl-4 pr-4">
          <span className="flex-1 font-bold">{t("total")}</span>
          <div className="shrink-0 text-right tabular">
            <div className="text-sm font-extrabold">{money(totals.value)}</div>
            <div className={cn("text-xs font-bold", totalPnlColor)}>
              {totalPct !== null ? formatPercent(totalPct / 100, locale) : ""}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
