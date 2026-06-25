import { getTranslations, setRequestLocale } from "next-intl/server";
import { Plus, TrendingUp, Wallet, AlertCircle, AlertTriangle } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { AllocationTabs, ConcentrationBadge } from "@/components/charts/allocation-tabs";
import { NetWorthHistoryChart } from "@/components/charts/net-worth-history-chart";
import { EmptyState } from "@/components/empty-state";
import { GoldTicker } from "@/components/gold-ticker";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { Button } from "@/components/ui/button";
import { Link } from "@/i18n/navigation";
import { loadNetWorth, loadNetWorthHistory, getSelectedPortfolioId, loadPreferences, loadAnomalies, loadUnmappedEventTypes } from "@/lib/server-api";
import { UnmappedTypesAlert } from "@/components/unmapped-types-alert";
import { cn, formatMoney, formatPercent, formatSignedMoney } from "@/lib/utils";
import { CostBasisToggle } from "@/components/cost-basis-toggle";
import { PeriodSelector } from "@/components/period-selector";
import { KpiPickerSheet } from "@/components/kpi-picker-sheet";

type CostBasisMode = "purchase_price" | "total_paid";

export default async function DashboardPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ costBasis?: string; period?: string }>;
}) {
  const { locale } = await params;
  const { costBasis: costBasisParam, period: periodParam } = await searchParams;
  const costBasis: CostBasisMode =
    costBasisParam === "total_paid" ? "total_paid" : "purchase_price";
  const period = ["ytd", "1y", "5y", "max"].includes(periodParam ?? "") ? periodParam! : "max";
  setRequestLocale(locale);
  const t = await getTranslations("Dashboard");
  const ta = await getTranslations("Anomalies");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");
  const th = await getTranslations("Holdings");

  const [result, history, selectedId, preferences, anomalies, unmappedTypes] = await Promise.all([
    loadNetWorth(costBasis, period),
    loadNetWorthHistory(),
    getSelectedPortfolioId(),
    loadPreferences(),
    loadAnomalies(),
    loadUnmappedEventTypes(),
  ]);

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
    displayCurrency = "IDR",
  ) => (
    <div className="space-y-6">
      {Heading}
      <GoldTicker currency={displayCurrency} />
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
  const activePeriod = result.data.period ?? "max";
  const currency = summary.displayCurrency;
  const m = (n: number) => formatMoney(n, currency, locale);

  const openHoldings = summary.holdings.filter((h) => Number(h.quantity) !== 0);
  // Display-currency magnitude, so ranking/allocation are comparable across currencies.
  const holdingValue = (h: (typeof openHoldings)[number]) =>
    h.marketValueDisplay !== null
      ? Number(h.marketValueDisplay)
      : Number(h.costBasisDisplay);

  if (openHoldings.length === 0 && Number(summary.netWorth) === 0) {
    return fullState(
      te("noHoldingsTitle"),
      te("noHoldingsBody"),
      <AddTransactionMenu />,
      currency,
    );
  }

  const totalPnL = Number(summary.totalUnrealizedPnL);
  const totalCost = Number(summary.totalCost);
  const cashTotal = Object.values(summary.cash).reduce(
    (s, v) => s + Number(v),
    0,
  );

  // Today's change: total day change vs. the prior-close value of the holdings.
  const dayChange = Number(summary.totalDayChange);
  const priorValue = Number(summary.totalMarketValue) - dayChange;
  const dayChangePct = priorValue !== 0 ? dayChange / priorValue : undefined;

  // Movers: holdings with a known day move, ranked by the size of the swing.
  const movers = openHoldings
    .filter((h) => h.dayChangePct !== null)
    .sort(
      (a, b) =>
        Math.abs(Number(b.dayChangePct)) - Math.abs(Number(a.dayChangePct)),
    )
    .slice(0, 5);

  const topHoldings = [...openHoldings]
    .sort((a, b) => holdingValue(b) - holdingValue(a))
    .slice(0, 4);

  // Use server-computed allocation breakdown when available; fall back to an
  // empty state (allocation is optional on PortfolioSummary for back-compat).
  const allocation = summary.allocation;

  // Anomaly badge — only in single-portfolio scope (loadAnomalies returns null in aggregate).
  const anomalyErrors = (anomalies ?? []).filter((a) => a.severity === "error");
  const anomalyWarnings = (anomalies ?? []).filter((a) => a.severity === "warning");
  const anomalyBadge =
    anomalies && (anomalyErrors.length > 0 || anomalyWarnings.length > 0) ? (
      <Link
        href="/transactions"
        className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition-colors hover:opacity-80 ${
          anomalyErrors.length > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
        }`}
      >
        {anomalyErrors.length > 0 ? (
          <AlertCircle className="size-3.5" />
        ) : (
          <AlertTriangle className="size-3.5" />
        )}
        {anomalyErrors.length > 0 && anomalyWarnings.length > 0
          ? ta("bannerBoth", { errors: anomalyErrors.length, warnings: anomalyWarnings.length })
          : anomalyErrors.length > 0
            ? ta("bannerError", { count: anomalyErrors.length })
            : ta("bannerWarning", { count: anomalyWarnings.length })}
      </Link>
    ) : null;

  return (
    <div className="space-y-6">
      {Heading}
      {anomalyBadge}
      <UnmappedTypesAlert types={unmappedTypes} />

      <GoldTicker currency={currency} />

      <div className="flex flex-wrap items-center justify-between gap-2">
        {/* PeriodSelector only renders in aggregate scope (no single portfolio selected) */}
        {selectedId === null && <PeriodSelector current={activePeriod} />}
        <div className="flex items-center gap-2 ml-auto">
          <KpiPickerSheet currentKpis={preferences?.dashboardKpis ?? null} />
          <CostBasisToggle
            current={costBasis}
            labelPurchase={th("costBasisPurchasePrice")}
            labelTotal={th("costBasisTotalPaid")}
          />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label={t("netWorth")} value={m(Number(summary.netWorth))} />
        <StatCard
          label={t("dayChange")}
          value={m(dayChange)}
          delta={
            dayChangePct !== undefined
              ? formatPercent(dayChangePct, locale)
              : undefined
          }
          deltaTone={dayChange > 0 ? "up" : dayChange < 0 ? "down" : "neutral"}
        />
        <StatCard
          label={t("totalPnL")}
          value={m(totalPnL)}
          delta={totalCost > 0 ? formatPercent(totalPnL / totalCost, locale) : undefined}
          deltaTone={totalPnL >= 0 ? "up" : "down"}
        />
        <StatCard
          label={
            activePeriod !== "max"
              ? t("returnPeriod", { period: activePeriod.toUpperCase() })
              : t("return")
          }
          value={
            (activePeriod !== "max" ? (summary.periodXirr ?? null) : performance.xirr) !== null
              ? formatPercent(
                  (activePeriod !== "max" ? summary.periodXirr! : performance.xirr)!,
                  locale,
                )
              : "—"
          }
        />
        <StatCard label={t("positions")} value={String(openHoldings.length)} />
        <StatCard
          label={t("cash")}
          value={summary.cashTracked ? m(cashTotal) : t("cashNotTracked")}
        />
        <StatCard label={t("income")} value={m(Number(summary.totalIncome))} />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("valueOverTime")}</CardTitle>
          </CardHeader>
          <CardContent>
            <NetWorthHistoryChart initial={history} currency={currency} selectedId={selectedId} />
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle>{t("allocation")}</CardTitle>
              {allocation && (
                <ConcentrationBadge label={allocation.concentration.label} />
              )}
            </div>
          </CardHeader>
          <CardContent>
            {allocation ? (
              <AllocationTabs
                allocation={allocation}
                currency={currency}
                drift={summary.drift}
                holdings={openHoldings}
              />
            ) : (
              <p className="text-center text-sm text-muted-foreground py-8">—</p>
            )}
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
            {movers.length > 0 ? (
              <div className="space-y-3">
                {movers.map((h) => {
                  const pct = Number(h.dayChangePct) / 100;
                  const holdingDayChange = h.dayChange !== null ? Number(h.dayChange) : null;
                  return (
                    <div
                      key={h.instrumentId}
                      className="flex items-center justify-between"
                    >
                      <div>
                        <p className="font-medium">
                          {h.instrument?.symbol ?? "—"}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {h.instrument?.name ?? h.instrumentId}
                        </p>
                      </div>
                      <div
                        className={cn(
                          "tabular text-right text-sm",
                          pct >= 0 ? "text-success" : "text-destructive",
                        )}
                      >
                        <p>{formatPercent(pct, locale)}</p>
                        {holdingDayChange !== null && (
                          <p className="text-xs">
                            {formatSignedMoney(holdingDayChange, currency, locale)}
                          </p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <EmptyState
                icon={TrendingUp}
                title={te("noMoversTitle")}
                description={te("noMoversBody")}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
