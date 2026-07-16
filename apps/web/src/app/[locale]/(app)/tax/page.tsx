import { getTranslations, setRequestLocale } from "next-intl/server";
import { Suspense } from "react";
import { Receipt, TrendingUp, Landmark, CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { ReportHeader } from "@/components/report-header";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PreferenceChips } from "@/components/preference-chips";
import {
  EstimatedTaxHero,
  AllowanceSummaryBoxes,
  DistributionCard,
  HarvestRow,
  HarvestSummaryNote,
  type TaxTranslator,
} from "@/components/tax/tax-cards";
import { loadNetworthTax, loadPreferences } from "@/lib/server-api";
import { formatMoney, formatMoneyCompact } from "@/lib/utils";
import type { TaxSummaryHolder } from "@portfolio/api-client";
import { harvestSummary } from "@portfolio/core";
import { TaxDetailSection, TaxDetailSkeleton } from "./tax-detail-section";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function TaxPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ year?: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  const { year: yearParam } = await searchParams;
  const year = yearParam ? parseInt(yearParam, 10) : undefined;
  setRequestLocale(locale);
  const t = await getTranslations("Tax");

  const prefs = await loadPreferences();
  const regime = prefs?.taxRegime ?? "DE";

  const holders = await loadNetworthTax(year, regime);

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] TaxPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

  const Heading = (
    <ReportHeader
      title={t("title")}
      subtitle={
        regime === "ID"
          ? t("id.subtitle", { year: year ?? new Date().getUTCFullYear() })
          : t("subtitle")
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
    const te = await getTranslations("Empty");
    return (
      <div className="space-y-5">
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
    <div className="space-y-5">
      {Heading}
      {holders.map((entry) => (
        <section key={entry.holder.id} className="space-y-4">
          <div className="flex items-center gap-2">
            <Landmark className="size-5 text-muted-foreground" />
            <h2 className="text-lg font-semibold">
              {entry.holder.name || t("defaultHolderName")} — {entry.year}
            </h2>
          </div>
          {regime === "DE" && <TaxHolderOverviewDe entry={entry} locale={locale} t={t} />}
        </section>
      ))}
      <Suspense fallback={<TaxDetailSkeleton />}>
        <TaxDetailSection holders={holders} year={year} locale={locale} />
      </Suspense>
    </div>
  );
}

function TaxHolderOverviewDe({
  entry,
  locale,
  t,
}: {
  entry: TaxSummaryHolder;
  locale: string;
  t: TaxTranslator;
}) {
  const currency = entry.currency;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
  const moneyCompact = (n: string | number) => formatMoneyCompact(Number(n), currency, locale);
  const { allowanceUsage: u, harvestSuggestions, distribution } = entry;
  const pct = parseFloat(u.remaining) / parseFloat(u.allowanceAnnual);
  const usedPct = Math.round((1 - Math.max(0, Math.min(1, pct))) * 100);
  const hasForecast = Number(u.forecastIncomeRestOfYear) > 0;

  const taxRate = Number(u.taxRate);
  const taxable = Number(u.taxableExcess);
  const estimatedTax = taxable * taxRate;
  const ratePct = (taxRate * 100).toLocaleString(locale, { maximumFractionDigits: 3 });

  const harvestRemaining = u.projectedRemaining ?? u.remaining;
  const combinedHarvest = harvestSummary(harvestSuggestions, harvestRemaining, u.taxRate);

  return (
    <>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 sm:gap-4">
        <EstimatedTaxHero
          label={t("hero.estimatedTax", { year: entry.year })}
          value={moneyCompact(estimatedTax)}
          description={t("hero.estimatedTaxDesc", { rate: ratePct, taxable: money(taxable) })}
        />
        <StatCard
          label={t("hero.fsaUsed")}
          value={money(u.usedYtd)}
          delta={t("hero.fsaUsedDesc", { allowance: money(u.allowanceAnnual) })}
        />
        <StatCard
          label={t("hero.realizedGains")}
          value={money(u.realizedGainsAdjusted)}
          delta={t("hero.realizedGainsDesc", { count: 0 })}
        />
        <StatCard
          label={t("hero.dividendsYtd")}
          value={money(u.incomeYtd)}
          delta={t("hero.dividendsYtdDesc", { allowance: money(u.allowanceAnnual) })}
        />
      </div>

      {distribution && <DistributionCard distribution={distribution} money={money} t={t} />}

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

      <Card className="overflow-hidden rounded-[20px]">
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
            <HarvestSummaryNote
              suggestions={harvestSuggestions}
              combined={combinedHarvest}
              money={money}
              t={t}
            />
          </>
        ) : (
          <p className="px-[22px] pb-5 pt-1 text-sm text-muted-foreground">{t("harvest.none")}</p>
        )}
      </Card>

      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("footnote", { rate: ratePct, allowance: money(u.allowanceAnnual) })}
      </p>
    </>
  );
}
