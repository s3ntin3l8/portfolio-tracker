import type { ReactNode } from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/empty-state";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { IncomeBarChart, IncomeBarChartLegend } from "@/components/charts/income-bar-chart";
import { IncomeHeatmap } from "@/components/charts/income-heatmap";
import { ReportHeader } from "@/components/report-header";
import { YieldsTable } from "@/components/income/yields-table";
import { ByCurrencyTable } from "@/components/income/by-currency-table";
import {
  IncomeEventsTable,
  TimelineColumnHeader,
  type IncomeEventRow,
} from "@/components/income/income-events-table";
import { loadIncomeStats } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

/** Sum a year's events per currency (income can span currencies). */
function totalsByCurrency(events: IncomeEventRow[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const e of events) {
    totals[e.currency] = (totals[e.currency] ?? 0) + Number(e.amount);
  }
  return totals;
}

export default async function IncomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Income");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");

  // Holder scope is now global (cookie-based via the portfolio switcher).
  // loadIncomeStats() reads it automatically.
  const result = await loadIncomeStats();

  const heading = <ReportHeader title={t("title")} subtitle={t("subtitle")} />;

  if (result.status !== "ok") {
    return (
      <div className="space-y-5">
        {heading}
        <EmptyState
          icon={Coins}
          title={
            result.status === "unavailable"
              ? te("unavailableTitle")
              : te("noPortfolioTitle")
          }
          description={
            result.status === "unavailable"
              ? te("unavailableBody")
              : te("noPortfolioBody")
          }
        />
      </div>
    );
  }

  const s = result.data;
  const currency = s.displayCurrency;
  const m = (n: number) => formatMoney(n, currency, locale);
  const hasIncome =
    s.events.length > 0 || s.yields.length > 0 || s.upcoming.length > 0;

  if (!hasIncome) {
    return (
      <div className="space-y-5">
        {heading}
        <EmptyState
          icon={Coins}
          title={t("emptyTitle")}
          description={t("emptyBody")}
        />
      </div>
    );
  }

  const lastYearLabel = String(new Date().getUTCFullYear() - 1);
  const thisFullYear = Number(s.forecastFullYear);
  const lastYearTotal = Number(s.lastYear);
  const deltaAbs = thisFullYear - lastYearTotal;
  const deltaPct = lastYearTotal > 0 ? deltaAbs / lastYearTotal : null;

  const currentYear = String(new Date().getUTCFullYear());

  // Yearly bars: current year includes projected rest-of-year as a stacked segment.
  const yearBars = [
    ...s.byYear.map((y) => ({
      label: y.year,
      value: Number(y.total),
      ...(y.year === currentYear ? { projected: Number(s.forecastRestOfYear) } : {}),
    })),
    { label: t("nextYear"), value: Number(s.forecastNextYear), forecast: true },
  ];

  const classSlices = s.byAssetClass.map((c) => ({
    key: c.assetClass,
    label: tc(c.assetClass),
    value: Number(c.total),
  }));

  // Group events + upcoming payments by year, sorted newest-first by date.
  const byYear = new Map<string, IncomeEventRow[]>();
  for (const e of s.events) {
    const year = e.date.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(e);
    byYear.set(year, bucket);
  }
  for (const u of s.upcoming) {
    const year = u.date.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push({
      ...u,
      type: u.kind,
      growthApplied: u.growthApplied,
      assumesContributions: u.assumesContributions,
      perShare: u.perShare,
      quantity: u.quantity,
    });
    byYear.set(year, bucket);
  }
  for (const bucket of byYear.values()) {
    bucket.sort((a, b) => b.date.localeCompare(a.date));
  }

  // Split off next-year projected rows into a dedicated section to avoid mixing
  // them with historical/current-year rows and to surface their assumptions clearly.
  const nextYearStr = String(new Date().getUTCFullYear() + 1);
  const nextYearRows = byYear.get(nextYearStr) ?? [];
  // Remove from the generic per-year loop so they don't render twice.
  byYear.delete(nextYearStr);

  const hasGrowth = nextYearRows.some((r) => r.status === "grown");
  const hasContributions = nextYearRows.some((r) => r.assumesContributions);

  // Per-year sub-header subtitle ("received + forecast" / "forecast" / "received")
  // and the multi-currency subtotal string shown on the right of each year header.
  const yearSubtitle = (yearRows: IncomeEventRow[]): string => {
    const anyForecast = yearRows.some((r) => r.status);
    const anyReceived = yearRows.some((r) => !r.status);
    return anyForecast
      ? anyReceived
        ? t("yearReceivedForecast")
        : t("yearForecast")
      : t("yearReceived");
  };
  const subtotalOf = (yearRows: IncomeEventRow[]): string =>
    Object.entries(totalsByCurrency(yearRows))
      .map(([cur, amount]) => formatMoney(amount, cur, locale))
      .join(" · ");

  // Ordered timeline groups: next-year forecast first, then historical years desc.
  const timelineGroups: {
    year: string;
    rows: IncomeEventRow[];
    subtitle: string;
    subtotal: string;
    assumptions?: ReactNode;
  }[] = [];
  if (nextYearRows.length > 0) {
    timelineGroups.push({
      year: nextYearStr,
      rows: nextYearRows,
      subtitle: yearSubtitle(nextYearRows),
      subtotal: subtotalOf(nextYearRows),
      assumptions: (
        <>
          {t("assumptionsBase")}
          {hasGrowth && <> {t("assumptionsGrowth")}</>}
          {hasContributions && <> {t("assumptionsContributions")}</>}
        </>
      ),
    });
  }
  for (const [year, events] of [...byYear.entries()].sort((a, b) => b[0].localeCompare(a[0]))) {
    timelineGroups.push({
      year,
      rows: events,
      subtitle: yearSubtitle(events),
      subtotal: subtotalOf(events),
    });
  }

  return (
    <div className="space-y-5">
      {heading}

      <div className="grid grid-cols-3 gap-2.5 sm:gap-4 lg:grid-cols-5">
        <StatCard
          label={t("thisYear")}
          value={m(thisFullYear)}
          delta={
            deltaPct !== null
              ? `${formatPercent(deltaPct, locale)} ${t("vsLastYear", { year: lastYearLabel })}`
              : undefined
          }
          deltaTone={deltaAbs > 0 ? "up" : deltaAbs < 0 ? "down" : "neutral"}
        />
        <StatCard label={t("ttm")} value={m(Number(s.ttm))} />
        <StatCard label={t("forecastNext12")} value={m(Number(s.forecastNextYear))} />
        <StatCard label={t("lifetime")} value={m(Number(s.lifetimeTotal))} />
        <StatCard
          label={t("payments")}
          value={String(s.paymentCount)}
          delta={t("avgPerPayment", { avg: m(Number(s.averagePerPayment)) })}
        />
      </div>

      {s.byYear.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1.5">
            <CardTitle>{t("perYearTitle")}</CardTitle>
            <IncomeBarChartLegend />
          </CardHeader>
          <CardContent>
            <IncomeBarChart data={yearBars} currency={currency} />
          </CardContent>
        </Card>
      )}

      {/* Desktop: these summary cards arrange in a two-column grid (reference). */}
      <div className="grid gap-4 lg:grid-cols-2 lg:items-start">
        {s.monthly.length > 0 && (
          <Card>
            {/* Tight header so the heatmap's dynamic subtitle sits right under the title. */}
            <CardHeader className="pb-2">
              <CardTitle>{t("seasonalityTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <IncomeHeatmap monthly={s.monthly} currency={currency} />
            </CardContent>
          </Card>
        )}
        {classSlices.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("byClassTitle")}</CardTitle>
            </CardHeader>
            <CardContent>
              <AllocationDonut data={classSlices} currency={currency} showPercent={false} />
            </CardContent>
          </Card>
        )}
        {s.byInstrument.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("topContributorsTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {s.byInstrument.slice(0, 8).map((c) => (
                <div key={c.instrumentId ?? c.symbol ?? "—"} className="space-y-1">
                  <div className="flex items-baseline justify-between gap-3">
                    <div className="min-w-0">
                      <span className="font-medium">{c.symbol ?? "—"}</span>
                      {c.name && (
                        <span className="ml-2 truncate text-xs text-muted-foreground">
                          {c.name}
                        </span>
                      )}
                    </div>
                    <span className="tabular shrink-0 text-sm">
                      {m(Number(c.total))}{" "}
                      <span className="text-muted-foreground">
                        ({formatPercent(c.pct, locale)})
                      </span>
                    </span>
                  </div>
                  <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${Math.max(2, c.pct * 100)}%` }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        )}
        {s.yields.length > 0 && (
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle>{t("yieldTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <YieldsTable rows={s.yields} />
            </CardContent>
          </Card>
        )}
        {s.byCurrency.length > 1 && (
          <Card className="overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle>{t("currencyTitle")}</CardTitle>
            </CardHeader>
            <CardContent className="px-0 pb-0">
              <ByCurrencyTable rows={s.byCurrency} displayCurrency={currency} />
            </CardContent>
          </Card>
        )}
      </div>

      {/* Payments timeline — one card, year sub-headers newest-first (reference). */}
      {timelineGroups.length > 0 && (
        <div className="rounded-[20px] bg-card p-[22px] shadow-card">
          <div className="mb-1.5 flex items-center justify-between gap-3">
            <div className="min-w-0">
              <h2 className="text-base font-bold">{t("paymentsTimelineTitle")}</h2>
              <p className="mt-0.5 text-xs font-medium text-text-2">{t("paymentsTimelineSubtitle")}</p>
            </div>
            <div className="flex shrink-0 items-center gap-3.5 text-[11px] font-semibold text-text-2">
              <span className="flex items-center gap-1.5">
                <span className="size-2.5 rounded-[3px] bg-success" />
                {t("legendReceived")}
              </span>
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-[3px]"
                  style={{ backgroundColor: "rgba(16,163,114,.12)", border: "1.5px dashed #0E9F6E" }}
                />
                {t("legendForecast")}
              </span>
            </div>
          </div>

          <TimelineColumnHeader />

          {timelineGroups.map((g) => (
            <div key={g.year} className="mt-3.5">
              <div className="sticky top-0 z-[2] flex items-baseline justify-between border-b border-border bg-card/95 py-2 backdrop-blur-sm">
                <div className="flex items-baseline gap-2.5">
                  <span className="text-[15px] font-extrabold">{g.year}</span>
                  <span className="text-[11px] font-semibold text-text-3">{g.subtitle}</span>
                </div>
                <span className="tabular text-[13px] font-bold text-text-mute">{g.subtotal}</span>
              </div>
              {g.assumptions && (
                <p className="pt-2 text-xs text-text-2">{g.assumptions}</p>
              )}
              <IncomeEventsTable rows={g.rows} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
