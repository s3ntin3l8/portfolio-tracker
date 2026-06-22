import type React from "react";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins, ChevronRight } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/empty-state";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { IncomeBarChart } from "@/components/charts/income-bar-chart";
import { IncomeHeatmap } from "@/components/charts/income-heatmap";
import { YieldsTable } from "@/components/income/yields-table";
import { ByCurrencyTable } from "@/components/income/by-currency-table";
import { IncomeEventsTable, type IncomeEventRow } from "@/components/income/income-events-table";
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

/** Collapsible year/forecast section using native <details>/<summary>. */
function CollapsibleYearSection({
  title,
  totalsNode,
  defaultOpen,
  children,
}: {
  title: React.ReactNode;
  totalsNode: React.ReactNode;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      className="group space-y-3"
      {...(defaultOpen ? { open: true } : {})}
    >
      <summary className="flex cursor-pointer list-none items-baseline justify-between [&::-webkit-details-marker]:hidden">
        <div className="flex items-center gap-1.5">
          <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
          <h2 className="text-lg font-semibold">{title}</h2>
        </div>
        <p className="tabular text-sm text-muted-foreground">{totalsNode}</p>
      </summary>
      <div className="space-y-3">{children}</div>
    </details>
  );
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

  const heading = (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
    </div>
  );

  if (result.status !== "ok") {
    return (
      <div className="space-y-6">
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
      <div className="space-y-6">
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

  return (
    <div className="space-y-8">
      {heading}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
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
        {Number(s.forecastRestOfYear) > 0 && (
          <StatCard
            label={t("restOfYear", { year: String(new Date().getUTCFullYear()) })}
            value={m(Number(s.forecastRestOfYear))}
          />
        )}
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
          <CardHeader>
            <CardTitle>{t("perYearTitle")}</CardTitle>
          </CardHeader>
          <CardContent>
            <IncomeBarChart data={yearBars} currency={currency} />
          </CardContent>
        </Card>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        {s.monthly.length > 0 && (
          <Card className="lg:col-span-2">
            <CardHeader>
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
              <AllocationDonut data={classSlices} currency={currency} />
            </CardContent>
          </Card>
        )}
      </div>

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
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("yieldTitle")}</h2>
          <div className="rounded-xl border border-border">
            <YieldsTable rows={s.yields} />
          </div>
        </section>
      )}

      {s.byCurrency.length > 1 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("currencyTitle")}</h2>
          <div className="rounded-xl border border-border">
            <ByCurrencyTable rows={s.byCurrency} displayCurrency={currency} />
          </div>
        </section>
      )}

      {nextYearRows.length > 0 && (
        <CollapsibleYearSection
          defaultOpen
          title={t("nextYearSectionTitle", { year: nextYearStr })}
          totalsNode={
            <>
              {t("yearTotal")}{" "}
              <span className="font-medium text-foreground">
                {Object.entries(totalsByCurrency(nextYearRows))
                  .map(([cur, amount]) => formatMoney(amount, cur, locale))
                  .join(" · ")}
              </span>
            </>
          }
        >
          <p className="text-sm text-muted-foreground">
            {t("assumptionsBase")}
            {hasGrowth && <> {t("assumptionsGrowth")}</>}
            {hasContributions && <> {t("assumptionsContributions")}</>}
          </p>

          <div className="rounded-xl border border-border">
            <IncomeEventsTable rows={nextYearRows} />
          </div>
        </CollapsibleYearSection>
      )}

      {[...byYear.entries()]
        .sort((a, b) => b[0].localeCompare(a[0]))
        .map(([year, events]) => {
          const totals = totalsByCurrency(events);
          return (
            <CollapsibleYearSection
              key={year}
              defaultOpen={year === currentYear}
              title={year}
              totalsNode={
                <>
                  {t("yearTotal")}{" "}
                  <span className="font-medium text-foreground">
                    {Object.entries(totals)
                      .map(([cur, amount]) => formatMoney(amount, cur, locale))
                      .join(" · ")}
                  </span>
                </>
              }
            >
              <div className="rounded-xl border border-border">
                <IncomeEventsTable rows={events} />
              </div>
            </CollapsibleYearSection>
          );
        })}
    </div>
  );
}
