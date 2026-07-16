import { getTranslations, setRequestLocale } from "next-intl/server";
import { PiggyBank } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { ContributionsChart } from "@/components/charts/contributions-chart";
import { ForecastPanel } from "@/components/savings/forecast-panel";
import { SparplanSection } from "@/components/savings/sparplan-section";
import { ReportHeader } from "@/components/report-header";
import { CashOnHandCard } from "@/components/savings/cash-on-hand-card";
import { EmptyState } from "@/components/empty-state";
import { loadContributions, loadSparplan, loadHoldings, loadPreferences } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function SavingsPage({ params }: { params: Promise<{ locale: string }> }) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Savings");
  const te = await getTranslations("Empty");

  // Holder scope is now global (cookie-based via the portfolio switcher).
  // All three loaders are independent — fire them in parallel.
  const [result, sparplanResult, holdingsResult, preferences] = await Promise.all([
    loadContributions(),
    loadSparplan(),
    loadHoldings(),
    loadPreferences(),
  ]);

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] SavingsPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

  const heading = <ReportHeader title={t("title")} subtitle={t("subtitle")} />;

  if (result.status !== "ok" || Number(result.data.totalContributed) === 0) {
    const unavailable = result.status === "unavailable";
    return (
      <div className="space-y-5">
        {heading}
        <EmptyState
          icon={PiggyBank}
          title={unavailable ? te("unavailableTitle") : t("emptyTitle")}
          description={unavailable ? te("unavailableBody") : t("emptyBody")}
        />
      </div>
    );
  }

  const c = result.data;
  const currency = c.displayCurrency;
  const m = (n: number) => formatMoney(n, currency, locale);
  const gainTone = c.simpleGainPct === null ? "neutral" : c.simpleGainPct >= 0 ? "up" : "down";

  return (
    <div className="space-y-5">
      {heading}

      <div className="grid grid-cols-2 gap-2.5 sm:gap-4 lg:grid-cols-4">
        <StatCard label={t("totalContributed")} value={m(Number(c.netContributed))} />
        <StatCard
          label={t("monthlyAverage")}
          value={m(Number(c.monthlyAverage))}
          delta={t("monthsElapsed", { count: c.monthsElapsed })}
          deltaTone="neutral"
        />
        <StatCard
          label={t("currentValue")}
          value={m(Number(c.currentValue))}
          delta={
            c.simpleGainPct !== null
              ? `${formatPercent(c.simpleGainPct, locale)} ${t("simpleGain")}`
              : undefined
          }
          deltaTone={gainTone}
        />
        {c.totalReturnPct !== null && (
          <StatCard
            label={t("totalReturn")}
            value={formatPercent(c.totalReturnPct, locale)}
            delta={t("totalReturnHint")}
            deltaTone={c.totalReturnPct >= 0 ? "up" : "down"}
          />
        )}
        <StatCard
          label={t("xirr")}
          value={c.xirr !== null ? formatPercent(c.xirr, locale) : "—"}
          // Under a year of data, XIRR extrapolates one-time/early gains (e.g. a starting
          // bonus) into an apparent annual rate — flag it so it isn't read as a run-rate.
          delta={c.xirr !== null && c.monthsElapsed < 12 ? t("xirrYoungHint") : undefined}
          deltaTone="neutral"
          // With totalReturn also shown, this grid holds 5 cards — an odd count leaves this
          // trailing tile alone in a half-width mobile cell. Span both mobile columns so it
          // reads as a deliberate row instead of a lopsided leftover; desktop has room to
          // spare so it stays single-width there.
          className={c.totalReturnPct !== null ? "col-span-2 lg:col-span-1" : undefined}
        />
      </div>

      <Card>
        <CardHeader>
          {/* Reference: title/subtitle on the left, the chart legend on the right of the same row. */}
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <CardTitle className="text-base">{t("contributionsOverTime")}</CardTitle>
              {c.dailySeries.length > 0 && (
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t("contributionsSubtitle", {
                    date: new Intl.DateTimeFormat(locale, {
                      month: "short",
                      year: "numeric",
                    }).format(new Date(c.dailySeries[0].date)),
                  })}
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-3.5 text-[11px] font-semibold text-text-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px] bg-success" />
                {t("chartValue")}
              </span>
              <span className="flex items-center gap-1.5">
                <span className="h-0 w-3.5 border-t-2 border-dashed border-text-3" />
                {t("chartContributions")}
              </span>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <ContributionsChart
            series={c.series}
            dailySeries={c.dailySeries}
            valueHistory={result.valueHistory}
            currency={currency}
          />
        </CardContent>
      </Card>

      {/* Plans + forecast side by side on desktop (reference: 2-col grid). */}
      <div className="grid gap-6 lg:grid-cols-2">
        {sparplanResult.status === "ok" && sparplanResult.data.plans.length > 0 && (
          <SparplanSection
            data={sparplanResult.data}
            currency={currency}
            locale={locale}
            portfolioId={sparplanResult.portfolioId ?? undefined}
            drift={sparplanResult.data.drift}
            contributionSplit={sparplanResult.data.contributionSplit}
          />
        )}

        <ForecastPanel
          currentValue={c.currentValue}
          netContributed={c.netContributed}
          monthlyAverage={c.monthlyAverage}
          seedAnnualReturn={c.seedAnnualReturn}
          currency={currency}
          birthYear={c.birthYear}
          portfolioType={c.portfolioType}
          retirementAge={c.retirementAge ?? preferences?.retirementAge ?? null}
        />
      </div>

      {holdingsResult.status === "ok" && holdingsResult.cashTracked && (
        <CashOnHandCard cash={holdingsResult.cash} locale={locale} />
      )}
    </div>
  );
}
