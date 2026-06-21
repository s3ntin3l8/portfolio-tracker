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
import { EmptyState } from "@/components/empty-state";
import { loadContributions } from "@/lib/server-api";
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

  const result = await loadContributions();

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
          deltaTone="neutral"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("contributionsOverTime")}</CardTitle>
        </CardHeader>
        <CardContent>
          <ContributionsChart series={c.series} currency={currency} />
        </CardContent>
      </Card>

      <ForecastPanel
        currentValue={c.currentValue}
        monthlyAverage={c.monthlyAverage}
        seedAnnualReturn={c.seedAnnualReturn}
        currency={currency}
        birthYear={c.birthYear}
        portfolioType={c.portfolioType}
      />
    </div>
  );
}
