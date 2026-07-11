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
import { StatCard } from "@/components/stat-card";
import { MonogramBadge } from "@/components/monogram-badge";
import { Link } from "@/i18n/navigation";
import type { HarvestSuggestion, TaxDistribution } from "@portfolio/api-client";
import type { TaxCurrencyTotal, TaxDividendRow, TaxYearRow } from "@/lib/server-api";
import type { IdDividendTax, IdYearTax, HarvestSummary } from "@portfolio/core";
import { formatMoney } from "@/lib/utils";

/** Loosely-typed next-intl translator scoped to the `Tax` namespace — the same shape as
 *  `getTranslations("Tax")` (server) or `useTranslations("Tax")` (client), threaded down
 *  as a prop rather than re-derived in each subcomponent. */
export type TaxTranslator = (key: string, values?: Record<string, string | number>) => string;

/** The "Estimated tax" hero stat — gradient card, distinct from the plain `StatCard`
 *  tiles beside it (the design's one visually-emphasized headline figure). `tone`
 *  matches the regime: violet for German (Abgeltungsteuer), green for Indonesian
 *  (final tax) — exactly `TaxScreen.dc.html`'s two hero gradients. */
export function EstimatedTaxHero({
  label,
  value,
  description,
  tone = "violet",
}: {
  label: string;
  value: string;
  description: string;
  tone?: "violet" | "green";
}) {
  return (
    <div
      className="rounded-[18px] p-5 text-white"
      style={{
        background:
          tone === "green"
            ? "linear-gradient(135deg,#0E9F6E,#0B7D58)"
            : "linear-gradient(135deg,#7C5CFC,#5B3FD6)",
      }}
    >
      <p className="text-xs font-semibold text-white/80">{label}</p>
      <p className="tabular mt-1 text-[28px] font-extrabold">{value}</p>
      <p className="mt-1 text-xs font-medium text-white/80">{description}</p>
    </div>
  );
}

/** "Dividends · {rate}% withheld" table — per-instrument gross/tax/net for the tax year,
 *  aggregated from raw dividend/coupon/interest transactions (their `tax` field).
 *
 * Unlike every other number on this screen, these amounts are NOT FX-converted (no rate
 * lookup is available from the web tier) — each row renders in its OWN currency
 * (`r.currency`), and the total row joins one amount per currency present (the same
 * "don't sum across currencies" pattern `CashOnHandCard` uses), rather than mislabeling
 * everything with the holder's display currency. */
export function DividendsTable({
  rows,
  totalsByCurrency,
  locale,
  t,
}: {
  rows: TaxDividendRow[];
  totalsByCurrency: TaxCurrencyTotal[];
  locale: string;
  t: TaxTranslator;
}) {
  const fmt = (n: string | number, currency: string) => formatMoney(Number(n), currency, locale);
  const joinTotals = (field: "gross" | "tax" | "net") =>
    totalsByCurrency.map((tc) => fmt(tc[field], tc.currency)).join(" · ");

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
                <TableCell className="tabular text-right font-semibold">{joinTotals("gross")}</TableCell>
                <TableCell className="tabular text-right font-semibold">{joinTotals("tax")}</TableCell>
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
              <TableHead className="text-right">{t("byYear.fsaUsed")}</TableHead>
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
                <TableCell className="tabular text-right text-muted-foreground">
                  {money(y.fsaUsed)}
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
  taxSavingAvailable,
  taxable,
  estimatedTax,
  money,
  t,
}: {
  usedPct: number;
  allowanceAnnual: string;
  usedYtd: string;
  remaining: string;
  /** Tax that using up the *remaining* allowance would save (`allowanceUsage.taxSavingAvailable`)
   *  — distinct from `estimatedTax` below (tax owed on gains ALREADY past the allowance).
   *  Carried over from the old 3-up StatCard row's "Remaining" delta so this figure isn't lost. */
  taxSavingAvailable: string;
  taxable: string;
  estimatedTax: string;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-[14px] border bg-card-2 px-[15px] py-[13px]">
        <div className="flex items-baseline justify-between">
          <span className="text-[11px] font-semibold text-text-2">
            {t("allowanceBoxes.left")}
          </span>
          <span className="tabular text-[15px] font-extrabold">{money(remaining)}</span>
        </div>
        {/* Reference: 7px track, purple allowance fill (#7C5CFC is the tax screen's accent). */}
        <div className="mt-2 h-[7px] overflow-hidden rounded-[5px] bg-line">
          <div
            className="h-full rounded-[5px] transition-all"
            style={{ width: `${Math.min(100, Math.max(0, usedPct))}%`, backgroundColor: "#7C5CFC" }}
          />
        </div>
        <p className="mt-1.5 text-[10px] font-medium text-text-3">
          {t("allowanceBoxes.leftDesc", { used: money(usedYtd), annual: money(allowanceAnnual) })}
        </p>
        <p className="mt-1 text-[10px] font-medium text-text-3">
          {t("allowance.taxSaving")}: {money(taxSavingAvailable)}
        </p>
      </div>
      <div className="rounded-[14px] border bg-card-2 px-[15px] py-[13px]">
        <span className="text-[11px] font-semibold text-text-2">
          {t("allowanceBoxes.taxableGains")}
        </span>
        <p className="tabular mt-1.5 text-xl font-extrabold">{money(taxable)}</p>
        <p className="mt-1 text-[10px] font-medium text-text-3">
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
        <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
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
  combined,
  money,
  t,
}: {
  suggestions: HarvestSuggestion[];
  /** Combined "harvest all of these together" totals from core's `harvestSummary` —
   *  sequentially allocates the SHARED remaining allowance across `suggestions`, unlike
   *  each row's own `harvestableGross`/`taxSaving`, which are independently capped
   *  against the FULL remaining allowance (correct in isolation, wrong summed — see
   *  `harvestSummary`'s doc comment in packages/core/src/tax.ts). `combined.plan` names
   *  the SPECIFIC position(s) actually needed — usually far fewer than `suggestions`,
   *  since one large-enough gain can exhaust the whole remaining allowance on its own. */
  combined: HarvestSummary;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  const totalHarvestable = Number(combined.combinedHarvestableGross);
  const totalSaving = Number(combined.combinedTaxSaving);
  if (totalHarvestable <= 0) return null;

  // Name the plan's position(s) by symbol — same fallback HarvestRow uses, so a
  // suggestion referenced here reads identically to its row further down. Joined with a
  // plain comma (no locale-specific "and") — mirrors the dividendTotalsByCurrency
  // "joined, not summed" precedent elsewhere on this page.
  const nameById = new Map(
    suggestions.map((s) => [s.instrumentId, s.instrument?.symbol ?? s.instrumentId.slice(0, 8)]),
  );
  const positionNames = combined.plan
    .map((step) => nameById.get(step.instrumentId) ?? step.instrumentId.slice(0, 8))
    .join(", ");
  const remainingCount = suggestions.length - combined.plan.length;

  // Partial: some suggestions weren't needed at all — the common case, since the first
  // (best) position(s) usually exhaust the remaining allowance alone. Full: every listed
  // suggestion is part of the plan (either because together they exactly cover the
  // allowance, or because total available gains fall short of it). Two partial variants
  // (not an ICU plural) — `t` here is a directly-injected translator (see TaxTranslator's
  // doc comment), not guaranteed to run through next-intl's real ICU MessageFormat in
  // every caller (e.g. this component's unit tests use a plain-substitution stub).
  const summaryText =
    remainingCount > 0
      ? t(remainingCount === 1 ? "harvest.summary.partialOne" : "harvest.summary.partialMany", {
          positions: positionNames,
          offset: money(totalHarvestable),
          saving: money(totalSaving),
          remainingCount,
        })
      : t("harvest.summary.full", {
          count: combined.plan.length,
          positions: positionNames,
          offset: money(totalHarvestable),
          saving: money(totalSaving),
        });

  return (
    <div className="flex items-start gap-2.5 border-t border-card-2 bg-success/10 px-[22px] py-3.5">
      <CircleCheck className="mt-px size-[17px] shrink-0 text-success" />
      <p className="text-xs font-medium leading-relaxed text-text-mute">{summaryText}</p>
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
  const label = s.instrument?.symbol ?? s.instrumentId.slice(0, 8);

  // Reference single-row layout: monogram | name + one meta line | gain + sublabel | CTA.
  return (
    <div className="flex items-center gap-3 border-t border-card-2 px-[22px] py-3 first:border-t-0">
      <MonogramBadge label={label} assetClass={s.instrument?.assetClass} className="size-[38px]" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-bold">{s.instrument?.name ?? label}</p>
        <p className="truncate text-[11px] font-medium text-text-2">
          {t("harvest.metaLine", { offset: money(s.harvestableGross), saving: money(s.taxSaving) })}
          {tfPct > 0 && <> {" · "}{t("harvest.tfApplied", { pct: tfPct })}</>}
        </p>
      </div>
      <div className="shrink-0 text-right">
        {/* Our German model harvests unrealized GAINS within the allowance → shown green. */}
        <p className="tabular text-[13px] font-bold text-success">{money(s.unrealizedGross)}</p>
        <p className="text-[10px] font-semibold text-text-3">{t("harvest.unrealized")}</p>
      </div>
      <Link
        href={`/transactions/new?harvestInstrument=${s.instrumentId}`}
        className="shrink-0 rounded-[10px] px-[13px] py-2 text-xs font-bold text-[#7C5CFC] transition-transform active:scale-95"
        style={{ backgroundColor: "rgba(124,92,252,.13)" }}
      >
        {t("harvest.button")}
      </Link>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Indonesian final-tax components — mirror the German tables above, but priced on
// PROCEEDS/GROSS at flat 0.1%/10% rates (no allowance, no Teilfreistellung, no
// harvesting). Labels come from the "id.*" keys under the shared "Tax" namespace so
// both regimes' strings live side by side (see TaxScreen.dc.html's ID branch).
//
// `IdSalesTable` (the disposals table) lives in ./disposal-table.tsx alongside its
// German counterpart `DisposalTable` — both need client-side row-expansion state for
// the aggregate-disposal/per-lot-detail view, so they're split into their own
// "use client" module and this file stays a server component.
// ---------------------------------------------------------------------------

/** "Dividends & coupons · 10% final" table — tax/net computed as a flat 10% of gross
 *  (not the broker-recorded withholding — see `indonesianFinalTax`'s doc comment). */
export function IdDividendsTable({
  rows,
  totalDividendGross,
  totalDividendTax,
  totalDividendNet,
  money,
  t,
}: {
  rows: IdDividendTax[];
  totalDividendGross: string;
  totalDividendTax: string;
  totalDividendNet: string;
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("id.dividendsTable.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        {rows.length === 0 ? (
          <p className="px-6 text-sm text-muted-foreground">{t("id.dividendsTable.empty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("id.dividendsTable.source")}</TableHead>
                <TableHead className="text-right">{t("id.dividendsTable.gross")}</TableHead>
                <TableHead className="text-right">{t("id.dividendsTable.tax")}</TableHead>
                <TableHead className="text-right">{t("id.dividendsTable.net")}</TableHead>
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
                <TableCell className="font-semibold">{t("id.dividendsTable.total")}</TableCell>
                <TableCell className="tabular text-right font-semibold text-muted-foreground">
                  {money(totalDividendGross)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold">
                  {money(totalDividendTax)}
                </TableCell>
                <TableCell className="tabular text-right font-semibold text-emerald-600 dark:text-emerald-400">
                  {money(totalDividendNet)}
                </TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

/** "By year" table for the Indonesian view — Est. tax is real for every year (proceeds
 *  × 0.1% + dividend gross × 10%), unlike the German table which only has a precise
 *  figure for the selected year (see `loadTaxYearDetail`'s idByYear rollup). */
export function IdByYearTable({
  rows,
  money,
  t,
}: {
  rows: IdYearTax[];
  money: (n: string | number) => string;
  t: TaxTranslator;
}) {
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("id.byYear.title")}</CardTitle>
      </CardHeader>
      <CardContent className="px-0 pt-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("id.byYear.year")}</TableHead>
              <TableHead className="text-right">{t("id.byYear.realized")}</TableHead>
              <TableHead className="text-right">{t("id.byYear.dividends")}</TableHead>
              <TableHead className="text-right">{t("id.byYear.tax")}</TableHead>
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
