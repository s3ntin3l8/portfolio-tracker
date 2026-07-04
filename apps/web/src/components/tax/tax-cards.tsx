import { TriangleAlert, Info, CircleCheck } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { StatCard } from "@/components/stat-card";
import { Link } from "@/i18n/navigation";
import type { HarvestSuggestion, TaxDistribution } from "@portfolio/api-client";
import type { TaxDisposalRow, TaxDividendRow, TaxYearRow } from "@/lib/server-api";

/** Loosely-typed next-intl translator scoped to the `Tax` namespace — the same shape as
 *  `getTranslations("Tax")` (server) or `useTranslations("Tax")` (client), threaded down
 *  as a prop rather than re-derived in each subcomponent. */
export type TaxTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The "Estimated tax" hero stat — purple-gradient card, distinct from the plain
 *  `StatCard` tiles beside it (the design's one visually-emphasized headline figure). */
export function EstimatedTaxHero({
  label,
  value,
  description,
}: {
  label: string;
  value: string;
  description: string;
}) {
  return (
    <div className="rounded-2xl bg-gradient-to-br from-violet-500 to-violet-700 p-5 text-white shadow-sm">
      <p className="text-xs font-semibold text-white/80">{label}</p>
      <p className="tabular mt-1 text-2xl font-extrabold">{value}</p>
      <p className="mt-1 text-xs font-medium text-white/80">{description}</p>
    </div>
  );
}

/** "Realized gains · Abgeltungsteuer" disposal table — reuses the trade log's per-leg
 *  proceeds/gain (no recomputation); `rows` is already scoped to the selected tax year. */
export function DisposalTable({
  rows,
  totalProceeds,
  totalGain,
  money,
  t,
}: {
  rows: TaxDisposalRow[];
  totalProceeds: string;
  totalGain: string;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("disposals.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("disposals.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("disposals.disposal")}</TableHead>
                <TableHead className="text-right">{t("disposals.proceeds")}</TableHead>
                <TableHead className="text-right">{t("disposals.gain")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell>
                    <span className="font-medium">{r.symbol}</span>{" "}
                    <span className="text-xs text-muted-foreground">{r.when}</span>
                  </TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {money(r.proceeds)}
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                    {money(r.gain)}
                  </TableCell>
                </TableRow>
              ))}
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

/** "Dividends · {rate}% withheld" table — per-instrument gross/tax/net for the tax year,
 *  aggregated from raw dividend/coupon/interest transactions (their `tax` field). */
export function DividendsTable({
  rows,
  totalGross,
  totalTax,
  totalNet,
  money,
  t,
}: {
  rows: TaxDividendRow[];
  totalGross: string;
  totalTax: string;
  totalNet: string;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("dividendsTable.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("dividendsTable.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("dividendsTable.source")}</TableHead>
                <TableHead className="text-right">{t("dividendsTable.gross")}</TableHead>
                <TableHead className="text-right">{t("dividendsTable.tax")}</TableHead>
                <TableHead className="text-right">{t("dividendsTable.net")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r, i) => (
                <TableRow key={i}>
                  <TableCell className="font-medium">{r.symbol}</TableCell>
                  <TableCell className="tabular text-right text-muted-foreground">
                    {money(r.gross)}
                  </TableCell>
                  <TableCell className="tabular text-right font-semibold">{money(r.tax)}</TableCell>
                  <TableCell className="tabular text-right text-emerald-600 dark:text-emerald-400">
                    {money(r.net)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="font-semibold">{t("dividendsTable.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold">{money(totalGross)}</TableCell>
                <TableCell className="tabular text-right font-semibold">{money(totalTax)}</TableCell>
                <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                  {money(totalNet)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** "By year" table — union of years with realized gains or dividend/interest income,
 *  newest first, plus a per-year estimated tax figure. See `loadTaxYearDetail`'s doc
 *  comment for the estimate's known limits (not TF-adjusted, current allowance applied
 *  uniformly to history). */
export function ByYearTable({ rows, money, t }: {
  rows: TaxYearRow[];
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("byYear.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("byYear.year")}</TableHead>
              <TableHead className="text-right">{t("byYear.realized")}</TableHead>
              <TableHead className="text-right">{t("byYear.dividends")}</TableHead>
              <TableHead className="text-right">{t("byYear.tax")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((y) => (
              <TableRow key={y.year}>
                <TableCell className="font-semibold">{y.year}</TableCell>
                <TableCell className="tabular text-right font-medium text-emerald-600 dark:text-emerald-400">
                  {money(y.realized)}
                </TableCell>
                <TableCell className="tabular text-right text-muted-foreground">
                  {money(y.dividends)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">{money(y.tax)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

/** The tax-loss-harvesting card's always-visible allowance summary: "Allowance left"
 *  (with a progress bar) and "Taxable gains YTD" — a 2-box relayout of the same
 *  `allowanceUsage` figures the page used to show as a 3-up `StatCard` row + separate
 *  progress-bar card. Every figure from the old layout is preserved here. */
export function AllowanceSummaryBoxes({
  usedPct,
  allowanceAnnual,
  usedYtd,
  remaining,
  taxable,
  estimatedTax,
  money,
  t,
}: {
  usedPct: number;
  allowanceAnnual: string;
  usedYtd: string;
  remaining: string;
  taxable: string;
  estimatedTax: string;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border bg-muted/40 p-4">
        <div className="flex items-baseline justify-between">
          <span className="text-xs font-semibold text-muted-foreground">
            {t("allowanceBoxes.left")}
          </span>
          <span className="tabular text-lg font-extrabold">{money(remaining)}</span>
        </div>
        <div className="mt-2 h-1.5 rounded-full bg-muted overflow-hidden">
          <div
            className="h-full rounded-full bg-primary transition-all"
            style={{ width: `${Math.min(100, Math.max(0, usedPct))}%` }}
          />
        </div>
        <p className="mt-1.5 text-xs text-muted-foreground">
          {t("allowanceBoxes.leftDesc", { used: money(usedYtd), annual: money(allowanceAnnual) })}
        </p>
      </div>
      <div className="rounded-xl border bg-muted/40 p-4">
        <span className="text-xs font-semibold text-muted-foreground">
          {t("allowanceBoxes.taxableGains")}
        </span>
        <p className="tabular mt-1.5 text-xl font-extrabold">{money(taxable)}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          {t("allowanceBoxes.taxableGainsDesc", { tax: money(estimatedTax) })}
        </p>
      </div>
    </div>
  );
}

export function DistributionCard({
  distribution: d,
  money,
  t,
}: {
  distribution: TaxDistribution;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  const allocPct = Number(d.holderAllowanceCap) > 0
    ? Math.round((Number(d.totalAllocated) / Number(d.holderAllowanceCap)) * 100)
    : 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Info className="size-4" />
          {t("distribution.title")}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-4 sm:grid-cols-3">
          <StatCard
            label={t("distribution.cap")}
            value={money(d.holderAllowanceCap)}
            delta={t("distribution.capDesc")}
          />
          <StatCard
            label={t("distribution.allocated")}
            value={money(d.totalAllocated)}
            delta={`${allocPct}%`}
          />
          <StatCard
            label={t("distribution.remaining")}
            value={money(d.remainingToDistribute)}
            delta={t("distribution.remainingDesc")}
          />
        </div>
        {d.overAllocated && (
          <div className="flex items-start gap-2 rounded-md border border-yellow-400 bg-yellow-50 dark:bg-yellow-950 dark:border-yellow-600 px-3 py-2 text-sm text-yellow-800 dark:text-yellow-200">
            <TriangleAlert className="size-4 mt-0.5 shrink-0" />
            <span>{t("distribution.overAllocated")}</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/** Footer sentence aggregating every harvestable position currently shown. */
export function HarvestSummaryNote({
  suggestions,
  money,
  t,
}: {
  suggestions: HarvestSuggestion[];
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  const totalHarvestable = suggestions.reduce((s, h) => s + Number(h.harvestableGross), 0);
  const totalSaving = suggestions.reduce((s, h) => s + Number(h.taxSaving), 0);
  if (totalHarvestable <= 0) return null;

  return (
    <div className="mt-4 flex items-start gap-2.5 rounded-lg bg-emerald-500/10 p-3.5 text-sm">
      <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />
      <p className="text-muted-foreground">
        {t("harvest.summary", {
          count: suggestions.length,
          offset: money(totalHarvestable),
          saving: money(totalSaving),
        })}
      </p>
    </div>
  );
}

export function HarvestRow({
  s,
  money,
  t,
}: {
  s: HarvestSuggestion;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  const tfPct = Math.round(parseFloat(s.tfRate) * 100);

  return (
    <div className="py-3 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-5 sm:items-center">
      <div className="col-span-2 sm:col-span-1">
        <p className="font-medium text-sm">{s.instrument?.symbol ?? s.instrumentId.slice(0, 8)}</p>
        <p className="text-xs text-muted-foreground">{s.instrument?.name}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("harvest.unrealized")}</p>
        <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
          {money(s.unrealizedGross)}
        </p>
        {tfPct > 0 && (
          <p className="text-xs text-muted-foreground">
            {t("harvest.tfApplied", { pct: tfPct })}
          </p>
        )}
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("harvest.harvestable")}</p>
        <p className="text-sm font-medium">{money(s.harvestableGross)}</p>
      </div>
      <div>
        <p className="text-xs text-muted-foreground">{t("harvest.taxSaving")}</p>
        <p className="text-sm font-medium text-blue-600 dark:text-blue-400">
          {money(s.taxSaving)}
        </p>
      </div>
      <div className="col-span-2 sm:col-span-1 sm:text-right">
        <Button variant="outline" size="sm" asChild>
          <Link href={`/transactions/new?harvestInstrument=${s.instrumentId}`}>
            {t("harvest.button")}
          </Link>
        </Button>
      </div>
    </div>
  );
}
