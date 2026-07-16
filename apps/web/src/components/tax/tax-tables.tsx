"use client";

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
import { useTableSort, type ColDef } from "@/lib/table-sort";
import { formatMoney } from "@/lib/utils";
import type { TaxCurrencyTotal, TaxDividendRow, TaxYearRow } from "@/lib/server-api";
import type { IdDividendTax, IdYearTax } from "@portfolio/core";

// ─── German regime tables ──────────────────────────────────────────────

const DIVIDEND_COLS: ColDef<TaxDividendRow>[] = [
  { key: "source", get: (r) => r.symbol, type: "text" },
  { key: "gross", get: (r) => Number(r.gross), type: "numeric" },
  { key: "tax", get: (r) => Number(r.tax), type: "numeric" },
  { key: "net", get: (r) => Number(r.net), type: "numeric" },
];

/** "Dividends · {rate}% withheld" table — per-instrument gross/tax/net for the tax year,
 *  aggregated from raw dividend/coupon/interest transactions (their `tax` field).
 *
 * Unlike every other number on this screen, these amounts are NOT FX-converted (no rate
 * lookup is available from the web tier) — each row renders in its OWN currency
 * (`r.currency`), and the total row joins one amount per currency present (the same
 * "don't sum across currencies" pattern `CashOnHandCard` uses), rather than mislabeling
 * everything with the holder's display currency.
 *
 * Client component (uses `useTableSort`) — `t` is derived via `useTranslations` since
 * function props can't cross the server→client boundary (see disposal-table.tsx's
 * identical comment). */
export function DividendsTable({
  rows,
  totalsByCurrency,
  locale,
  year,
}: {
  rows: TaxDividendRow[];
  totalsByCurrency: TaxCurrencyTotal[];
  locale: string;
  year: number;
}) {
  const t = useTranslations("Tax");
  const fmt = (n: string | number, currency: string) => formatMoney(Number(n), currency, locale);
  const joinTotals = (field: "gross" | "tax" | "net") =>
    totalsByCurrency.map((tc) => fmt(tc[field], tc.currency)).join(" · ");
  const { sortKey, sortDir, toggle, sort } = useTableSort<TaxDividendRow>(DIVIDEND_COLS);
  const sorted = sort(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dividendsTable.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {t("dividendsTable.empty", { year })}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  colKey="source"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                >
                  {t("dividendsTable.source")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="gross"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("dividendsTable.gross")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="tax"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("dividendsTable.tax")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="net"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("dividendsTable.net")}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r, i) => (
                // Identity-based key (a single instrument's dividends can be in mixed
                // currencies, so symbol alone isn't unique) rather than the post-sort
                // index. The dividend tables have no per-row expand/select state today,
                // so this is purely a future-proofing alignment with the row-key fix
                // applied to disposal-table.tsx.
                <TableRow key={`${r.symbol}:${r.currency}:${i}`}>
                  <TableCell className="font-medium">{r.symbol}</TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {fmt(r.gross, r.currency)}
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold">
                    {fmt(r.tax, r.currency)}
                  </TableCell>
                  <TableCell className="tabular text-right text-emerald-600 dark:text-emerald-400">
                    {fmt(r.net, r.currency)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("dividendsTable.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {joinTotals("gross")}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {joinTotals("tax")}
                </TableCell>
                <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                  {joinTotals("net")}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const BY_YEAR_COLS: ColDef<TaxYearRow>[] = [
  { key: "year", get: (r) => r.year, type: "numeric" },
  { key: "realized", get: (r) => Number(r.realized), type: "numeric" },
  { key: "dividends", get: (r) => Number(r.dividends), type: "numeric" },
  { key: "fsaUsed", get: (r) => Number(r.fsaUsed), type: "numeric" },
  { key: "tax", get: (r) => Number(r.tax), type: "numeric" },
];

/** "By year" table — union of years with realized gains or dividend/interest income,
 *  newest first, plus a per-year estimated tax figure. See `loadTaxYearDetail`'s doc
 *  comment for the estimate's known limits (not TF-adjusted, current allowance applied
 *  uniformly to history). */
export function ByYearTable({
  rows,
  currency,
  locale,
}: {
  rows: TaxYearRow[];
  currency: string;
  locale: string;
}) {
  const t = useTranslations("Tax");
  const fmt = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { sortKey, sortDir, toggle, sort } = useTableSort<TaxYearRow>(BY_YEAR_COLS);
  if (rows.length === 0) return null;
  const sorted = sort(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("byYear.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                colKey="year"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("byYear.year")}
              </SortableTableHead>
              <SortableTableHead
                colKey="realized"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("byYear.realized")}
              </SortableTableHead>
              <SortableTableHead
                colKey="dividends"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("byYear.dividends")}
              </SortableTableHead>
              <SortableTableHead
                colKey="fsaUsed"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("byYear.fsaUsed")}
              </SortableTableHead>
              <SortableTableHead
                colKey="tax"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("byYear.tax")}
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((y) => (
              <TableRow key={y.year}>
                <TableCell className="font-semibold">{y.year}</TableCell>
                <TableCell className="tabular text-right font-medium text-emerald-600 dark:text-emerald-400">
                  {fmt(y.realized)}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {fmt(y.dividends)}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {fmt(y.fsaUsed)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">{fmt(y.tax)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

// ─── Indonesian regime tables ─────────────────────────────────────────

const ID_DIVIDEND_COLS: ColDef<IdDividendTax>[] = [
  { key: "source", get: (r) => r.symbol, type: "text" },
  { key: "gross", get: (r) => Number(r.gross), type: "numeric" },
  { key: "tax", get: (r) => Number(r.tax), type: "numeric" },
  { key: "net", get: (r) => Number(r.net), type: "numeric" },
];

/** "Dividends & coupons · 10% final" table — tax/net computed as a flat 10% of gross
 *  (not the broker-recorded withholding — see `indonesianFinalTax`'s doc comment). */
export function IdDividendsTable({
  rows,
  totalDividendGross,
  totalDividendTax,
  totalDividendNet,
  currency,
  locale,
  year,
}: {
  rows: IdDividendTax[];
  totalDividendGross: string;
  totalDividendTax: string;
  totalDividendNet: string;
  currency: string;
  locale: string;
  year: number;
}) {
  const t = useTranslations("Tax");
  const fmt = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { sortKey, sortDir, toggle, sort } = useTableSort<IdDividendTax>(ID_DIVIDEND_COLS);
  const sorted = sort(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("id.dividendsTable.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">
            {t("id.dividendsTable.empty", { year })}
          </p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <SortableTableHead
                  colKey="source"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                >
                  {t("id.dividendsTable.source")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="gross"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("id.dividendsTable.gross")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="tax"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("id.dividendsTable.tax")}
                </SortableTableHead>
                <SortableTableHead
                  colKey="net"
                  sortKey={sortKey}
                  sortDir={sortDir}
                  onToggle={toggle}
                  align="right"
                >
                  {t("id.dividendsTable.net")}
                </SortableTableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sorted.map((r, i) => (
                // See DividendsTable's identical comment — identity-based key for
                // future-proofing.
                <TableRow key={`${r.symbol}:${r.currency}:${i}`}>
                  <TableCell className="font-medium">{r.symbol}</TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {fmt(r.gross)}
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold">{fmt(r.tax)}</TableCell>
                  <TableCell className="tabular text-right text-emerald-600 dark:text-emerald-400">
                    {fmt(r.net)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("id.dividendsTable.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold text-muted-foreground">
                  {fmt(totalDividendGross)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {fmt(totalDividendTax)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                  {fmt(totalDividendNet)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

const ID_BY_YEAR_COLS: ColDef<IdYearTax>[] = [
  { key: "year", get: (r) => r.year, type: "numeric" },
  { key: "realized", get: (r) => Number(r.realized), type: "numeric" },
  { key: "dividends", get: (r) => Number(r.dividends), type: "numeric" },
  { key: "tax", get: (r) => Number(r.tax), type: "numeric" },
];

/** "By year" table for the Indonesian view — Est. tax is real for every year (proceeds
 *  × 0.1% + dividend gross × 10%), unlike the German table which only has a precise
 *  figure for the selected year (see `loadTaxYearDetail`'s idByYear rollup). */
export function IdByYearTable({
  rows,
  currency,
  locale,
}: {
  rows: IdYearTax[];
  currency: string;
  locale: string;
}) {
  const t = useTranslations("Tax");
  const fmt = (n: string | number) => formatMoney(Number(n), currency, locale);
  const { sortKey, sortDir, toggle, sort } = useTableSort<IdYearTax>(ID_BY_YEAR_COLS);
  if (rows.length === 0) return null;
  const sorted = sort(rows);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("id.byYear.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <SortableTableHead
                colKey="year"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
              >
                {t("id.byYear.year")}
              </SortableTableHead>
              <SortableTableHead
                colKey="realized"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("id.byYear.realized")}
              </SortableTableHead>
              <SortableTableHead
                colKey="dividends"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("id.byYear.dividends")}
              </SortableTableHead>
              <SortableTableHead
                colKey="tax"
                sortKey={sortKey}
                sortDir={sortDir}
                onToggle={toggle}
                align="right"
              >
                {t("id.byYear.tax")}
              </SortableTableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {sorted.map((y) => (
              <TableRow key={y.year}>
                <TableCell className="font-semibold">{y.year}</TableCell>
                <TableCell className="tabular text-right font-medium text-emerald-600 dark:text-emerald-400">
                  {fmt(y.realized)}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {fmt(y.dividends)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">{fmt(y.tax)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
