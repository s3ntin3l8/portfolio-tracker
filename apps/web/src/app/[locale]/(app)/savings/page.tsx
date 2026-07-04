import { getTranslations, setRequestLocale } from "next-intl/server";
import { PiggyBank } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { ContributionsChart } from "@/components/charts/contributions-chart";
import { ForecastPanel } from "@/components/savings/forecast-panel";
import { SparplanSection } from "@/components/savings/sparplan-section";
import { CashOnHandCard } from "@/components/savings/cash-on-hand-card";
import { EmptyState } from "@/components/empty-state";
import { loadContributions, loadSparplan, loadHoldings } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

export default async function SavingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Savings");
  const te = await getTranslations("Empty");

  // Holder scope is now global (cookie-based via the portfolio switcher).
  // loadContributions() reads it automatically.
  const result = await loadContributions();
  // Sparplan detection is fetched independently so it renders even when
  // totalContributed === 0 (e.g. cash-outside portfolio with only plan buys).
  const sparplanResult = await loadSparplan();
  // Cash-on-hand card needs the same per-currency cash balances the Holdings
  // screen pins — only meaningful (cashTracked) for cash-inside-boundary
  // portfolios; absent entirely for cash-outside scope, which is correct (there's
  // nothing "idle" to nudge when cash isn't part of the portfolio's boundary).
  const holdingsResult = await loadHoldings();

  const heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
    </div>
  );

  if (result.status !== "ok" || Number(result.data.totalContributed) === 0) {
    const unavailable = result.status === "unavailable";
    return (
      <div className="space-y-6">
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
    <div className="space-y-8">
      {heading}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
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
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("contributionsOverTime")}</CardTitle>
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
      />

      {holdingsResult.status === "ok" && holdingsResult.cashTracked && (
        <CashOnHandCard cash={holdingsResult.cash} locale={locale} />
      )}
    </div>
  );
}
