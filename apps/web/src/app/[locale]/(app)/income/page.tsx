import { getTranslations, setRequestLocale } from "next-intl/server";
import { Coins } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { StatCard } from "@/components/stat-card";
import { EmptyState } from "@/components/empty-state";
import { AllocationDonut } from "@/components/charts/allocation-donut";
import { IncomeBarChart } from "@/components/charts/income-bar-chart";
import { IncomeHeatmap } from "@/components/charts/income-heatmap";
import { loadIncomeStats } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";
import type { IncomeEvent, UpcomingPayment } from "@portfolio/api-client";

/** Sum a year's events per currency (income can span currencies). */
function totalsByCurrency(events: IncomeEvent[]): Record<string, number> {
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
  const tt = await getTranslations("TxType");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");
  const df = new Intl.DateTimeFormat(locale, { dateStyle: "medium" });

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
  const deltaAbs = Number(s.deltaAbs);

  // Yearly bars + the next-year forecast appended as a muted projection bar.
  const yearBars = [
    ...s.byYear.map((y) => ({ label: y.year, value: Number(y.total) })),
    { label: t("nextYear"), value: Number(s.forecastNextYear), forecast: true },
  ];

  const classSlices = s.byAssetClass.map((c) => ({
    key: c.assetClass,
    label: tc(c.assetClass),
    value: Number(c.total),
  }));

  // Group events newest-first by year (events are already sorted desc by date).
  const byYear = new Map<string, IncomeEvent[]>();
  for (const e of s.events) {
    const year = e.date.slice(0, 4);
    const bucket = byYear.get(year) ?? [];
    bucket.push(e);
    byYear.set(year, bucket);
  }

  return (
    <div className="space-y-8">
      {heading}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
        <StatCard
          label={t("thisYear")}
          value={m(Number(s.thisYear))}
          delta={
            s.deltaPct !== null
              ? `${formatPercent(s.deltaPct, locale)} ${t("vsLastYear", { year: lastYearLabel })}`
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
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("instrument")}</TableHead>
                  <TableHead className="text-right">{t("trailing")}</TableHead>
                  <TableHead className="text-right">{t("value")}</TableHead>
                  <TableHead className="text-right">{t("currentYield")}</TableHead>
                  <TableHead className="text-right">{t("yieldOnCost")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.yields.map((y) => (
                  <TableRow key={y.instrumentId}>
                    <TableCell>
                      <div className="font-medium">{y.symbol}</div>
                      {y.name && (
                        <div className="text-xs text-muted-foreground">
                          {y.name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(Number(y.trailingIncome), y.currency, locale)}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {formatMoney(Number(y.marketValue), y.currency, locale)}
                    </TableCell>
                    <TableCell className="tabular text-right font-medium">
                      {y.yield !== null
                        ? formatPercent(Number(y.yield), locale)
                        : "—"}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {y.yieldOnCost !== null
                        ? formatPercent(Number(y.yieldOnCost), locale)
                        : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {s.byCurrency.length > 1 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("currencyTitle")}</h2>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("type")}</TableHead>
                  <TableHead className="text-right">{t("native")}</TableHead>
                  <TableHead className="text-right">{t("normalized")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.byCurrency.map((c) => (
                  <TableRow key={c.currency}>
                    <TableCell className="font-medium">{c.currency}</TableCell>
                    <TableCell className="tabular text-right">
                      {formatMoney(Number(c.totalNative), c.currency, locale)}
                    </TableCell>
                    <TableCell className="tabular text-right text-muted-foreground">
                      {m(Number(c.totalNormalized))}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {s.upcoming.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-lg font-semibold">{t("upcomingTitle")}</h2>
          <div className="rounded-xl border border-border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("date")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("instrument")}</TableHead>
                  <TableHead className="text-right">{t("amount")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {s.upcoming.map((c: UpcomingPayment, i: number) => (
                  <TableRow key={`${c.instrumentId}-${c.date}-${i}`}>
                    <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                      {df.format(new Date(c.date))}
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          c.status === "scheduled"
                            ? "default"
                            : c.status === "announced"
                              ? "warning"
                              : c.status === "paid"
                                ? "success"
                                : "outline"
                        }
                      >
                        {t(c.status)}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">{c.symbol}</div>
                      {c.name && (
                        <div className="text-xs text-muted-foreground">
                          {c.name}
                        </div>
                      )}
                    </TableCell>
                    <TableCell className="tabular text-right text-success">
                      {formatMoney(Number(c.amount), c.currency, locale)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      {[...byYear.entries()].map(([year, events]) => {
        const totals = totalsByCurrency(events);
        return (
          <section key={year} className="space-y-3">
            <div className="flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">{year}</h2>
              <p className="tabular text-sm text-muted-foreground">
                {t("yearTotal")}{" "}
                <span className="font-medium text-foreground">
                  {Object.entries(totals)
                    .map(([cur, amount]) => formatMoney(amount, cur, locale))
                    .join(" · ")}
                </span>
              </p>
            </div>

            <div className="rounded-xl border border-border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("date")}</TableHead>
                    <TableHead>{t("type")}</TableHead>
                    <TableHead>{t("instrument")}</TableHead>
                    <TableHead className="text-right">{t("amount")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {events.map((e, i) => (
                    <TableRow key={`${e.instrumentId}-${e.date}-${i}`}>
                      <TableCell className="tabular whitespace-nowrap text-muted-foreground">
                        {df.format(new Date(e.date))}
                      </TableCell>
                      <TableCell>
                        <Badge variant="default">{tt(e.type)}</Badge>
                      </TableCell>
                      <TableCell>
                        <div className="font-medium">{e.symbol ?? "—"}</div>
                        {e.name && (
                          <div className="text-xs text-muted-foreground">
                            {e.name}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="tabular text-right text-success">
                        {formatMoney(Number(e.amount), e.currency, locale)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        );
      })}
    </div>
  );
}
