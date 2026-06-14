import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { ValueAreaChart } from "@/components/charts/value-area-chart";
import { formatMoney, formatPercent, cn } from "@/lib/utils";
import {
  summary,
  getAllocation,
  valueOverTime,
  topMovers,
  holdings,
  marketValue,
} from "@/lib/mock-data";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Dashboard");

  const m = (n: number) => formatMoney(n, summary.currency, locale);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label={t("netWorth")}
          value={m(summary.netWorth)}
          delta={`${m(summary.dayChange)} (${formatPercent(summary.dayChangePct, locale)}) ${t("today")}`}
          deltaTone={summary.dayChange >= 0 ? "up" : "down"}
        />
        <StatCard
          label={t("totalPnL")}
          value={m(summary.totalPnL)}
          delta={formatPercent(summary.totalPnLPct, locale)}
          deltaTone={summary.totalPnL >= 0 ? "up" : "down"}
        />
        <StatCard label={t("positions")} value={String(holdings.length)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("valueOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ValueAreaChart data={valueOverTime} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("allocation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <AllocationDonut data={getAllocation()} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("topHoldings")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {[...holdings]
              .sort((a, b) => marketValue(b) - marketValue(a))
              .slice(0, 4)
              .map((h) => (
                <div key={h.id} className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{h.symbol}</p>
                    <p className="text-xs text-muted-foreground">{h.name}</p>
                  </div>
                  <p className="tabular text-sm">{m(marketValue(h))}</p>
                </div>
              ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("topMovers")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topMovers.map((mv) => {
              const up = mv.changePct >= 0;
              return (
                <div key={mv.symbol} className="flex items-center justify-between">
                  <div>
                    <p className="font-medium">{mv.symbol}</p>
                    <p className="text-xs text-muted-foreground">{mv.name}</p>
                  </div>
                  <span
                    className={cn(
                      "tabular flex items-center gap-1 text-sm",
                      up ? "text-success" : "text-destructive",
                    )}
                  >
                    {up ? (
                      <ArrowUpRight className="size-4" />
                    ) : (
                      <ArrowDownRight className="size-4" />
                    )}
                    {formatPercent(mv.changePct, locale)}
                  </span>
                </div>
              );
            })}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
