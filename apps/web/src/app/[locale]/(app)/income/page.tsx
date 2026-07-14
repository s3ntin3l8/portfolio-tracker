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
  TABLE_LABEL,
  TABLE_SUBLABEL,
  TABLE_VALUE_STRONG,
} from "@/components/ui/table";
import { IncomeTimeline } from "@/components/income/income-timeline";
import { CashInterestLine } from "@/components/income/cash-interest-line";
import type { IncomeEventRow } from "@/components/income/income-events-table";
import { loadIncomeStats } from "@/lib/server-api";
import { formatMoney, formatPercent, cn } from "@/lib/utils";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function IncomePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Income");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");

  // Holder scope is now global (cookie-based via the portfolio switcher).
  // loadIncomeStats() reads it automatically.
  const result = await loadIncomeStats();

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] IncomePage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

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

  // Merge historical events + upcoming payments into one flat row array — the
  // year-grouping, next-year-forecast split, and per-year subtitle/subtotal logic now
  // live in <IncomeTimeline>, which re-runs them AFTER its own filters (year/status/
  // search) so a filtered view still groups and sorts correctly.
  const timelineRows: IncomeEventRow[] = [
    ...s.events,
    ...s.upcoming.map((u) => ({
      ...u,
      type: u.kind,
      growthApplied: u.growthApplied,
      assumesContributions: u.assumesContributions,
      perShare: u.perShare,
      quantity: u.quantity,
    })),
  ];

  // Years with data that aren't in the initial 3-year events window → collapsed
  // year headers that load on demand.
  const eventYears = new Set(s.events.map((e) => e.date.slice(0, 4)));
  const olderYears = s.byYear
    .map((y) => String(y.year))
    .filter((y) => !eventYears.has(y))
    .sort((a, b) => Number(b) - Number(a));

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

      {/* Cash interest — a standalone subtotal (per user decision), not folded into
          the dividend/coupon headline above. Hidden entirely when there's none. */}
      {Number(s.interest.lifetime) > 0 && (
        <CashInterestLine
          label={t("cashInterest")}
          ytdLabel={t("thisYear")}
          ttmLabel={t("ttm")}
          lifetimeLabel={t("lifetime")}
          ytd={m(Number(s.interest.ytd))}
          ttm={m(Number(s.interest.ttm))}
          lifetime={m(Number(s.interest.lifetime))}
        />
      )}

      {s.byYear.length > 0 && (
        <Card>
          <CardHeader className="flex flex-row flex-wrap items-center gap-x-3 gap-y-1.5 pb-2">
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
                      <span className={TABLE_LABEL}>{c.symbol ?? "—"}</span>
                      {(c.displayName ?? c.name) && (
                        <span className={cn("ml-2 truncate", TABLE_SUBLABEL)}>
                          {c.displayName ?? c.name}
                        </span>
                      )}
                    </div>
                    <span className={cn("shrink-0", TABLE_VALUE_STRONG)}>
                      {m(Number(c.total))}{" "}
                      <span className="text-text-mute">
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

      {/* Payments timeline — one card, year sub-headers newest-first, with its own
          year/status filter chips + search (reference). */}
      {timelineRows.length > 0 && (
        <IncomeTimeline rows={timelineRows} locale={locale} olderYears={olderYears} />
      )}
    </div>
  );
}
