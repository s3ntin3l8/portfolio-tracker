import { getTranslations, setRequestLocale } from "next-intl/server";
import { Receipt, TrendingUp, Landmark, CalendarClock } from "lucide-react";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  EstimatedTaxHero,
  DisposalTable,
  DividendsTable,
  ByYearTable,
  AllowanceSummaryBoxes,
  DistributionCard,
  HarvestRow,
  HarvestSummaryNote,
  type TaxTranslator,
} from "@/components/tax/tax-cards";
import { loadNetworthTax, loadTaxYearDetail, type TaxYearDetail } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";
import type { TaxSummaryHolder } from "@portfolio/api-client";

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

  const holders = await loadNetworthTax(year);
  const detailByHolder = await loadTaxYearDetail(holders, year);

  const Heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
    </div>
  );

  if (holders.length === 0) {
    return (
      <div className="space-y-6">
        {Heading}
        <EmptyState
          icon={Receipt}
          title={t("empty.title")}
          description={t("empty.description")}
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
  locale,
  t,
}: {
  entry: TaxSummaryHolder;
  detail: TaxYearDetail | null;
  locale: string;
  t: TaxTranslator;
}) {
  const { holder, year, currency, allowanceUsage: u, harvestSuggestions, distribution } = entry;
  const money = (n: string | number) => formatMoney(Number(n), currency, locale);
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
    <section className="space-y-4">
      {/* Holder header */}
      <div className="flex items-center gap-2">
        <Landmark className="size-5 text-muted-foreground" />
        <h2 className="text-lg font-semibold">
          {holder.name} — {year}
        </h2>
      </div>

      {/* Hero row: estimated tax + realized gains YTD + dividends YTD */}
      <div className="grid gap-4 sm:grid-cols-3">
        <EstimatedTaxHero
          label={t("hero.estimatedTax", { year })}
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
          />
          <DividendsTable
            rows={detail.dividendRows}
            totalGross={detail.totalGross}
            totalTax={detail.totalTax}
            totalNet={detail.totalNet}
            money={money}
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
            <div className="grid gap-4 sm:grid-cols-3">
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
      <Card>
        <CardHeader>
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="size-4" />
            {t("harvest.title")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <AllowanceSummaryBoxes
            usedPct={usedPct}
            allowanceAnnual={u.allowanceAnnual}
            usedYtd={u.usedYtd}
            remaining={u.remaining}
            taxable={taxable.toString()}
            estimatedTax={estimatedTax.toString()}
            money={money}
            t={t}
          />
          {harvestSuggestions.length > 0 ? (
            <div>
              <p className="text-sm text-muted-foreground mb-2">
                {hasForecast ? t("harvest.subtitle") : t("harvest.subtitleNoForecast")}
              </p>
              <div className="divide-y">
                {harvestSuggestions.map((s) => (
                  <HarvestRow key={s.instrumentId} s={s} money={money} t={t} />
                ))}
              </div>
              <HarvestSummaryNote suggestions={harvestSuggestions} money={money} t={t} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("harvest.none")}</p>
          )}
        </CardContent>
      </Card>

      {/* By year */}
      {detail && <ByYearTable rows={detail.byYear} money={money} t={t} />}

      <p className="text-xs text-muted-foreground leading-relaxed">
        {t("footnote", { rate: ratePct, allowance: money(u.allowanceAnnual) })}
      </p>
    </section>
  );
}
