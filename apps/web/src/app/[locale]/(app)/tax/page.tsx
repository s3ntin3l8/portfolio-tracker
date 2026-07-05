import { getTranslations, setRequestLocale } from "next-intl/server";
import { Receipt, TrendingUp, Landmark, CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ReportHeader } from "@/components/report-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreferenceChips } from "@/components/preference-chips";
import {
  EstimatedTaxHero,
  DisposalTable,
  DividendsTable,
  ByYearTable,
  AllowanceSummaryBoxes,
  DistributionCard,
  HarvestRow,
  HarvestSummaryNote,
  IdSalesTable,
  IdDividendsTable,
  IdByYearTable,
  type TaxTranslator,
} from "@/components/tax/tax-cards";
import { loadNetworthTax, loadTaxYearDetail, loadPreferences, type TaxYearDetail } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";
import type { TaxSummaryHolder } from "@portfolio/api-client";
import { indonesianFinalTax } from "@portfolio/core";

export default async function TaxPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  const { locale } = await params;
  const { year: yearParam } = await searchParams;
  const year = yearParam ? parseInt(yearParam, 10) : undefined;
  setRequestLocale(locale);
  const t = await getTranslations("Tax");

  const prefs = await loadPreferences();
  const regime = prefs?.taxRegime ?? "DE";

  // Both loaders run in BOTH regimes — `loadTaxYearDetail` needs a non-empty
  // `holders` array to compute anything at all (see loadNetworthTax's ID branch,
  // which builds a normalized holder stub instead of gating on a German FSA that an
  // Indonesian user will almost never have configured). The regime only decides
  // which components render from the result below, not which loaders run.
  const holders = await loadNetworthTax(year, regime);
  const detailByHolder = await loadTaxYearDetail(holders, year);

  const Heading = (
    <ReportHeader
      title={t("title")}
      subtitle={
        regime === "ID" ? t("id.subtitle", { year: year ?? new Date().getUTCFullYear() }) : t("subtitle")
      }
      action={
        <div className="flex flex-col items-end gap-1">
          <PreferenceChips
            prefKey="taxRegime"
            current={regime}
            options={[
              { value: "DE", label: t("regime.de") },
              { value: "ID", label: t("regime.id") },
            ]}
          />
          <span className="px-0.5 text-[11px] text-muted-foreground">{t("regime.label")}</span>
        </div>
      }
    />
  );

  if (holders.length === 0) {
    // Only reachable with zero portfolios at all (loadNetworthTax's ID branch always
    // returns a stub otherwise) — the German-specific "no FSA" copy would be wrong
    // here, so the DE-only empty state is gated to the DE regime.
    const te = await getTranslations("Empty");
    return (
      <div className="space-y-6">
        {Heading}
        <EmptyState
          icon={Receipt}
          title={regime === "ID" ? te("noPortfolioTitle") : t("empty.title")}
          description={regime === "ID" ? te("noPortfolioBody") : t("empty.description")}
        />
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {Heading}
      {holders.map((entry) => (
        <TaxHolderSection
          key={entry.holder.id}
          entry={entry}
          detail={detailByHolder.get(entry.holder.id) ?? null}
          regime={regime}
          locale={locale}
          t={t}
        />
      ))}
    </div>
  );
}

function TaxHolderSection({
  entry,
  detail,
  regime,
  locale,
  t,
}: {
  entry: TaxSummaryHolder;
  detail: TaxYearDetail | null;
  regime: "DE" | "ID";
  locale: string;
  t: TaxTranslator;
}) {
  const { holder, year } = entry;
  // ID mode formats every figure with the trade log's own display currency (`detail`
  // always carries the real one, unlike `entry.currency` which is an inert IDR/base
  // placeholder on the synthetic ID holder stub — see loadNetworthTax).
  const currency = regime === "ID" ? (detail?.currency ?? entry.currency) : entry.currency;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);

  return (
    <section className="space-y-4">
      {/* Holder header */}
      <div className="flex items-center gap-2">
        <Landmark className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">
          {holder.name || t("defaultHolderName")} — {year}
        </h2>
      </div>

      {regime === "ID" ? (
        <TaxHolderSectionId detail={detail} money={money} year={year} t={t} />
      ) : (
        <TaxHolderSectionDe entry={entry} detail={detail} money={money} locale={locale} t={t} />
      )}
    </section>
  );
}

/** Indonesian final-tax branch: recomputes over the same disposals/dividendRows
 *  `loadTaxYearDetail` already assembles for the German path, via
 *  `indonesianFinalTax` — no new API endpoint, no German-only sections rendered. */
function TaxHolderSectionId({
  detail,
  money,
  year,
  t,
}: {
  detail: TaxYearDetail | null;
  money: (n: string | number) => string;
  year: number;
  t: TaxTranslator;
}) {
  const idTax = indonesianFinalTax({
    disposals: (detail?.disposals ?? []).map((d) => ({
      symbol: d.symbol,
      when: d.when,
      proceeds: d.proceeds,
    })),
    dividends: (detail?.dividendRows ?? []).map((d) => ({
      symbol: d.symbol,
      currency: d.currency,
      gross: d.gross,
    })),
    byYear: detail?.idByYear ?? [],
  });

  return (
    <>
      {/* Hero row: estimated tax (withheld at source) + sales tax + dividend tax */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
        <EstimatedTaxHero
          tone="green"
          label={t("id.hero.estimatedTax", { year })}
          value={money(idTax.estimatedTax)}
          description={t("id.hero.estimatedTaxDesc")}
        />
        <StatCard
          label={t("id.hero.salesTax")}
          value={money(idTax.totalSalesTax)}
          delta={t("id.hero.salesTaxDesc", { amount: money(idTax.totalProceeds) })}
        />
        <StatCard
          label={t("id.hero.dividendTax")}
          value={money(idTax.totalDividendTax)}
          delta={t("id.hero.dividendTaxDesc", { amount: money(idTax.totalDividendGross) })}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <IdSalesTable
          rows={idTax.disposals}
          totalProceeds={idTax.totalProceeds}
          totalSalesTax={idTax.totalSalesTax}
          money={money}
          t={t}
          year={year}
        />
        <IdDividendsTable
          rows={idTax.dividends}
          totalDividendGross={idTax.totalDividendGross}
          totalDividendTax={idTax.totalDividendTax}
          totalDividendNet={idTax.totalDividendNet}
          money={money}
          t={t}
        />
      </div>

      <IdByYearTable rows={idTax.byYear} money={money} t={t} />

      <p className="text-xs text-muted-foreground leading-relaxed">{t("id.footnote")}</p>
    </>
  );
}

/** German Abgeltungsteuer branch — unchanged from before the regime toggle existed. */
function TaxHolderSectionDe({
  entry,
  detail,
  money,
  locale,
  t,
}: {
  entry: TaxSummaryHolder;
  detail: TaxYearDetail | null;
  money: (n: string | number) => string;
  locale: string;
  t: TaxTranslator;
}) {
  const { allowanceUsage: u, harvestSuggestions, distribution } = entry;
  const pct = parseFloat(u.remaining) / parseFloat(u.allowanceAnnual);
  const usedPct = Math.round((1 - Math.max(0, Math.min(1, pct))) * 100);
  const hasForecast = Number(u.forecastIncomeRestOfYear) > 0;

  // Taxable gains after allowance, and the estimated tax owed on them at the holder's
  // real capital-gains rate (`u.taxRate` — already `holder.capitalGainsTaxRate ?? 0.25`
  // from the backend, never hardcoded here). Shared by the hero card and the
  // "Taxable gains YTD" allowance box so both agree.
  const taxRate = Number(u.taxRate);
  const taxable = Math.max(
    0,
    Number(u.realizedGainsAdjusted) + Number(u.incomeYtd) - Number(u.usedYtd),
  );
  const estimatedTax = taxable * taxRate;
  const ratePct = (taxRate * 100).toLocaleString(locale, { maximumFractionDigits: 3 });

  return (
    <>
      {/* Hero row: estimated tax + realized gains YTD + dividends YTD */}
      <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
        <EstimatedTaxHero
          label={t("hero.estimatedTax", { year: entry.year })}
          value={money(estimatedTax)}
          description={t("hero.estimatedTaxDesc", { rate: ratePct, taxable: money(taxable) })}
        />
        <StatCard
          label={t("hero.realizedGains")}
          value={money(u.realizedGainsAdjusted)}
          delta={t("hero.realizedGainsDesc", { count: detail?.disposals.length ?? 0 })}
        />
        <StatCard
          label={t("hero.dividendsYtd")}
          value={money(u.incomeYtd)}
          delta={t("hero.dividendsYtdDesc", { allowance: money(u.allowanceAnnual) })}
        />
      </div>

      {/* FSA distribution roll-up (only when we have distribution context) */}
      {distribution && (
        <DistributionCard distribution={distribution} money={money} t={t} />
      )}

      {/* Realized gains disposal table + dividends withheld table */}
      {detail && (
        <div className="grid gap-4 lg:grid-cols-2">
          <DisposalTable
            rows={detail.disposals}
            totalProceeds={detail.totalProceeds}
            totalGain={detail.totalGain}
            money={money}
            t={t}
            year={entry.year}
          />
          <DividendsTable
            rows={detail.dividendRows}
            totalsByCurrency={detail.dividendTotalsByCurrency}
            locale={locale}
            t={t}
          />
        </div>
      )}

      {/* Rest-of-year forecast block (only when there's a non-zero projection) */}
      {hasForecast && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2">
              <CalendarClock className="size-4" />
              {t("forecast.label")}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-xs text-muted-foreground">{t("forecast.disclaimer")}</p>
            <div className="grid grid-cols-3 gap-2.5 sm:gap-4">
              <StatCard
                label={t("forecast.label")}
                value={money(u.forecastIncomeRestOfYear)}
                delta={t("forecast.labelDesc")}
              />
              <StatCard
                label={t("forecast.projectedUsed")}
                value={money(u.projectedUsedFullYear)}
                delta={t("forecast.projectedUsedDesc")}
              />
              <StatCard
                label={t("forecast.projectedRemaining")}
                value={money(u.projectedRemaining)}
                delta={`${t("forecast.projectedTaxSaving")}: ${money(u.projectedTaxSavingAvailable)}`}
              />
            </div>
          </CardContent>
        </Card>
      )}

      {/* Tax-loss harvesting: always shows the allowance summary; the position list and
          summary note only when there's something harvestable. */}
      <Card className="overflow-hidden rounded-[20px]">
        {/* Header: title + subtitle on the left, a currency pill on the right (reference). */}
        <div className="flex items-start justify-between gap-3 px-[22px] pb-1 pt-[18px]">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[15px] font-bold">
              <TrendingUp className="size-4" />
              {t("harvest.title")}
            </h2>
            <p className="mt-0.5 text-xs font-medium text-text-2">
              {hasForecast ? t("harvest.subtitle") : t("harvest.subtitleNoForecast")}
            </p>
          </div>
          <span
            className="shrink-0 rounded-lg px-2.5 py-1 text-[10px] font-bold tracking-wide text-[#7C5CFC]"
            style={{ backgroundColor: "rgba(124,92,252,.16)" }}
          >
            {entry.currency}
          </span>
        </div>

        <div className="px-[22px] pb-1.5 pt-3.5">
          <AllowanceSummaryBoxes
            usedPct={usedPct}
            allowanceAnnual={u.allowanceAnnual}
            usedYtd={u.usedYtd}
            remaining={u.remaining}
            taxSavingAvailable={u.taxSavingAvailable}
            taxable={taxable.toString()}
            estimatedTax={estimatedTax.toString()}
            money={money}
            t={t}
          />
        </div>

        {harvestSuggestions.length > 0 ? (
          <>
            <p className="px-[22px] pb-1 pt-2 text-[10px] font-bold uppercase tracking-wide text-text-3">
              {t("harvest.positionsEyebrow")}
            </p>
            <div>
              {harvestSuggestions.map((s) => (
                <HarvestRow key={s.instrumentId} s={s} money={money} t={t} />
              ))}
            </div>
            <HarvestSummaryNote suggestions={harvestSuggestions} money={money} t={t} />
          </>
        ) : (
          <p className="px-[22px] pb-5 pt-1 text-sm text-muted-foreground">{t("harvest.none")}</p>
        )}
      </Card>

      {/* By year */}
      {detail && <ByYearTable rows={detail.byYear} money={money} t={t} />}

      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("footnote", { rate: ratePct, allowance: money(u.allowanceAnnual) })}
      </p>
    </>
  );
}
