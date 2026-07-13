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
import { MonogramBadge } from "@/components/monogram-badge";
import { Link } from "@/i18n/navigation";
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
  const sorted = sort(rows);

  return (
    <>
      {/* Desktop: 5-column table. CSS hides it below `md`. */}
      <div className="hidden md:block">
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
            {sorted.map((y) => (
              <TableRow key={y.instrumentId}>
                <TableCell>
                  <div className="flex items-center gap-3 min-w-0">
                    <MonogramBadge label={y.symbol ?? "—"} assetClass={y.assetClass} />
                    <div className="min-w-0">
                      <Link
                        href={`/instruments/${y.instrumentId}`}
                        className={cn(TABLE_LABEL, "hover:underline")}
                      >
                        {y.symbol}
                      </Link>
                      {y.displayName ?? y.name ? (
                        <div className={TABLE_SUBLABEL}>{y.displayName ?? y.name}</div>
                      ) : null}
                    </div>
                  </div>
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
      </div>

      {/* Mobile: stacked card list. CSS hides it at `md` and up. The same sorted
          array feeds this view, so changing sort on desktop re-orders the mobile
          cards on next render. Each card is a single tap target that navigates to
          the instrument detail page (the original Symbol-link request). */}
      <div className="md:hidden">
        <div className="divide-y divide-line">
          {sorted.map((y) => (
            <Link
              key={y.instrumentId}
              href={`/instruments/${y.instrumentId}`}
              data-testid="yield-card"
              aria-label={t("openInstrument", { symbol: y.symbol ?? "—" })}
              className="block px-4 py-3 transition-colors hover:bg-[var(--row-hover)]"
            >
              <div className="flex items-center gap-3 min-w-0">
                <MonogramBadge label={y.symbol ?? "—"} assetClass={y.assetClass} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <div className="min-w-0">
                      <div className={TABLE_LABEL}>{y.symbol}</div>
                      {y.displayName ?? y.name ? (
                        <div className={TABLE_SUBLABEL}>{y.displayName ?? y.name}</div>
                      ) : null}
                    </div>
                    <div className={cn(TABLE_VALUE_STRONG, "shrink-0")}>
                      {y.yield !== null ? formatPercent(Number(y.yield), locale) : "—"}
                    </div>
                  </div>
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[12px] text-text-2">
                    <span>
                      <span className="text-text-mute">{t("yieldCardTrailing")} </span>
                      {formatMoney(Number(y.trailingIncome), y.currency, locale)}
                    </span>
                    <span>
                      <span className="text-text-mute">{t("yieldCardValue")} </span>
                      {formatMoney(Number(y.marketValue), y.currency, locale)}
                    </span>
                  </div>
                  {y.yieldOnCost !== null ? (
                    <div className="mt-1 text-[11px] text-text-3">
                      {t("yieldCardYieldOnCost")}{" "}
                      <span className="font-semibold text-text-2">
                        {formatPercent(Number(y.yieldOnCost), locale)}
                      </span>
                    </div>
                  ) : null}
                </div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </>
  );
}
