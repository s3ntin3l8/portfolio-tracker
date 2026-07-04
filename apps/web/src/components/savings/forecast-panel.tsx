"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { forecastSeries } from "@portfolio/core";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ForecastChart } from "@/components/charts/forecast-chart";
import { formatMoney, formatPercent } from "@/lib/utils";

/** Parse a numeric input, treating blank/invalid as 0 and clamping to a range. */
function num(v: string, min: number, max: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/**
 * Interactive savings forecast. Recomputes a projected balance entirely in the
 * browser (pure core math) as the monthly amount, expected return and horizon
 * change — no network round-trip.
 */
export function ForecastPanel({
  currentValue,
  netContributed = "0",
  monthlyAverage,
  seedAnnualReturn,
  currency,
  birthYear = null,
  portfolioType = "standard",
}: {
  currentValue: string;
  netContributed?: string;
  monthlyAverage: string;
  seedAnnualReturn: string;
  currency: string;
  birthYear?: number | null;
  portfolioType?: "standard" | "child";
}) {
  const t = useTranslations("Savings");
  const locale = useLocale();

  // Years from now until the beneficiary turns 18 (clamped to the slider range).
  // Only child portfolios carry an age-18 target.
  const yearsToEighteen =
    portfolioType === "child" && birthYear
      ? Math.min(50, Math.max(1, 18 - (new Date().getFullYear() - birthYear)))
      : null;

  const [monthly, setMonthly] = useState(Math.round(Number(monthlyAverage)));
  const [returnPct, setReturnPct] = useState(
    Math.round(Number(seedAnnualReturn) * 1000) / 10,
  );
  const [years, setYears] = useState(yearsToEighteen ?? 10);

  const series = useMemo(
    () =>
      forecastSeries({
        presentValue: currentValue,
        monthlyContribution: String(monthly),
        annualReturnRate: String(returnPct / 100),
        horizonMonths: years * 12,
      }),
    [currentValue, monthly, returnPct, years],
  );

  // Three scenario chips at rate−3pp / current rate / rate+3pp (clamped to the
  // slider's 0–15 range, deduped at the extremes so e.g. rate=0 yields 2 chips,
  // not 3 with a duplicate). Each re-runs the same client-side projection at that
  // rate for the current monthly top-up + horizon.
  const scenarios = useMemo(() => {
    const rates = [...new Set([
      Math.max(0, Math.round((returnPct - 3) * 2) / 2),
      returnPct,
      Math.min(15, Math.round((returnPct + 3) * 2) / 2),
    ])];
    return rates.map((rate) => {
      const scenarioSeries = forecastSeries({
        presentValue: currentValue,
        monthlyContribution: String(monthly),
        annualReturnRate: String(rate / 100),
        horizonMonths: years * 12,
      });
      return {
        rate,
        value: Number(scenarioSeries[scenarioSeries.length - 1].value),
        active: rate === returnPct,
      };
    });
  }, [currentValue, monthly, returnPct, years]);

  const last = series[series.length - 1];
  const contributed = Number(last.contributed);
  const value = Number(last.value);
  const totalContributed = Number(netContributed) + contributed;
  const totalGrowth = Math.max(0, value - totalContributed);
  const historicalGrowth = Math.max(0, Number(currentValue) - Number(netContributed));
  const m = (n: number) => formatMoney(n, currency, locale);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">{t("forecastTitle")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("forecastSubtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="grid gap-5 sm:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="forecast-monthly">{t("monthlyAmount")}</Label>
            <Input
              id="forecast-monthly"
              type="number"
              min={0}
              inputMode="numeric"
              value={monthly}
              onChange={(e) => setMonthly(num(e.target.value, 0, 1_000_000))}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="forecast-return">
              {t("annualReturn")}: {formatPercent(returnPct / 100, locale)}
            </Label>
            <input
              id="forecast-return"
              type="range"
              min={0}
              max={15}
              step={0.5}
              value={returnPct}
              onChange={(e) => setReturnPct(num(e.target.value, 0, 15))}
              className="h-9 w-full accent-[var(--color-primary)]"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="forecast-years">
                {t("horizonYears")}: {t("years", { count: years })}
              </Label>
              {yearsToEighteen !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-xs"
                  onClick={() => setYears(yearsToEighteen)}
                >
                  {t("toAge18")}
                </Button>
              )}
            </div>
            <input
              id="forecast-years"
              type="range"
              min={1}
              max={50}
              step={1}
              value={years}
              onChange={(e) => setYears(num(e.target.value, 1, 50))}
              className="h-9 w-full accent-[var(--color-primary)]"
            />
          </div>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <div>
            <p className="text-sm text-muted-foreground">{t("projectedValue")}</p>
            <p className="tabular mt-1 text-2xl font-semibold" data-testid="projected-value">
              {m(value)}
            </p>
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("projectedContributed")}</p>
            <p className="tabular mt-1 text-2xl font-semibold" data-testid="projected-contributed">
              {m(totalContributed)}
            </p>
            {Number(netContributed) > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("contributedSoFar", { amount: m(Number(netContributed)) })}
              </p>
            )}
          </div>
          <div>
            <p className="text-sm text-muted-foreground">{t("projectedGrowth")}</p>
            <p className="tabular mt-1 text-2xl font-semibold text-success" data-testid="projected-growth">
              {m(totalGrowth)}
            </p>
            {historicalGrowth > 0 && (
              <p className="text-xs text-muted-foreground mt-0.5">
                {t("growthSoFar", { amount: m(historicalGrowth) })}
              </p>
            )}
          </div>
        </div>

        <ForecastChart series={series} presentValue={currentValue} currency={currency} />

        <div
          className="grid gap-2 sm:grid-cols-3"
          role="group"
          aria-label={t("scenariosLabel")}
        >
          {scenarios.map((s) => (
            <div
              key={s.rate}
              data-testid="scenario-chip"
              data-active={s.active}
              className={
                s.active
                  ? "rounded-xl border border-primary/50 bg-primary/10 p-3"
                  : "rounded-xl border border-border bg-muted/40 p-3"
              }
            >
              <p className="text-[10px] font-semibold text-muted-foreground">
                {formatPercent(s.rate / 100, locale)}
              </p>
              <p className="tabular mt-0.5 text-sm font-extrabold">{m(s.value)}</p>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
