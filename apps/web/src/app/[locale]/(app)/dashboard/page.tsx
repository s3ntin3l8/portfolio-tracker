import { getTranslations, setRequestLocale } from "next-intl/server";
import { LineChart, Plus, TrendingUp, Wallet } from "lucide-react";
import type { AllocationSlice } from "@/lib/mock-data";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { EmptyState } from "@/components/empty-state";
import { GoldTicker } from "@/components/gold-ticker";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { loadNetWorth } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

export default async function DashboardPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Dashboard");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");

  const result = await loadNetWorth();

  const Heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
    </div>
  );

  const ctaButton = (label: string) => (
    <Button asChild>
      <Link href="/transactions/new">
        <Plus className="size-4" />
        {label}
      </Link>
    </Button>
  );

  const fullState = (
    title: string,
    description: string,
    action?: React.ReactNode,
  ) => (
    <div className="space-y-6">
      {Heading}
      <GoldTicker />
      <EmptyState
        icon={Wallet}
        title={title}
        description={description}
        action={action}
      />
    </div>
  );

  if (result.status === "unavailable") {
    return fullState(te("unavailableTitle"), te("unavailableBody"));
  }
  if (result.status === "empty") {
    return fullState(
      te("noPortfolioTitle"),
      te("noPortfolioBody"),
      ctaButton(tm("createPortfolio")),
    );
  }

  const summary = result.data; // NetWorth carries the same fields as a summary
  const performance = { xirr: result.data.xirr };
  const currency = summary.displayCurrency;
  const m = (n: number) => formatMoney(n, currency, locale);

  const openHoldings = summary.holdings.filter((h) => Number(h.quantity) !== 0);
  const holdingValue = (h: (typeof openHoldings)[number]) =>
    h.marketValue !== null ? Number(h.marketValue) : Number(h.costBasis);

  if (openHoldings.length === 0 && Number(summary.netWorth) === 0) {
    return fullState(
      te("noHoldingsTitle"),
      te("noHoldingsBody"),
      ctaButton(tm("addTransaction")),
    );
  }

  const totalPnL = Number(summary.totalUnrealizedPnL);
  const totalCost = Number(summary.totalCost);
  const cashTotal = Object.values(summary.cash).reduce(
    (s, v) => s + Number(v),
    0,
  );

  // Allocation by asset class (priced where possible, else at cost) plus cash.
  const byClass = new Map<string, number>();
  for (const h of openHoldings) {
    const cls = h.instrument?.assetClass ?? "equity";
    byClass.set(cls, (byClass.get(cls) ?? 0) + holdingValue(h));
  }
  const allocation: AllocationSlice[] = [
    ...[...byClass.entries()].map(([key, value]) => ({
      key: key as AllocationSlice["key"],
      label: tc(key),
      value,
    })),
    ...(cashTotal > 0
      ? [{ key: "cash" as AllocationSlice["key"], label: tc("cash"), value: cashTotal }]
      : []),
  ].filter((s) => s.value > 0);

  const topHoldings = [...openHoldings]
    .sort((a, b) => holdingValue(b) - holdingValue(a))
    .slice(0, 4);

  return (
    <div className="space-y-6">
      {Heading}

      <GoldTicker />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label={t("netWorth")} value={m(Number(summary.netWorth))} />
        <StatCard
          label={t("totalPnL")}
          value={m(totalPnL)}
          delta={totalCost > 0 ? formatPercent(totalPnL / totalCost, locale) : undefined}
          deltaTone={totalPnL >= 0 ? "up" : "down"}
        />
        <StatCard
          label={t("return")}
          value={
            performance.xirr !== null
              ? formatPercent(performance.xirr, locale)
              : "—"
          }
        />
        <StatCard label={t("positions")} value={String(openHoldings.length)} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("valueOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={LineChart}
              title={te("historyTitle")}
              description={te("historyBody")}
            />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("allocation")}</CardTitle>
          </CardHeader>
          <CardContent>
            <AllocationDonut data={allocation} />
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("topHoldings")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {topHoldings.map((h) => (
              <div
                key={h.instrumentId}
                className="flex items-center justify-between"
              >
                <div>
                  <p className="font-medium">{h.instrument?.symbol ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {h.instrument?.name ?? h.instrumentId}
                  </p>
                </div>
                <p className="tabular text-sm">{m(holdingValue(h))}</p>
              </div>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("topMovers")}</CardTitle>
          </CardHeader>
          <CardContent>
            <EmptyState
              icon={TrendingUp}
              title={te("historyTitle")}
              description={te("historyBody")}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
