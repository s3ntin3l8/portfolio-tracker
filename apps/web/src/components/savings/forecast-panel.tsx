"use client";

import { useMemo, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { forecastSeries } from "@portfolio/core";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { ForecastChart } from "@/components/charts/forecast-chart";
import { formatMoney, formatMoneyCompact, formatPercent } from "@/lib/utils";

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
 *
 * Styled as the reference's green-gradient "hero" (same recipe as Holdings'
 * `HeroGlanceCard`: `linear-gradient(160deg,#0E9F6E,#0B7D58)`, `rounded-[26px]`,
 * `shadow-[0_12px_30px_rgba(14,159,110,.30)]`) — white-on-green controls, chart and
 * a contributed/growth split footer.
 */
export function ForecastPanel({
  currentValue,
  netContributed = "0",
  monthlyAverage,
  seedAnnualReturn,
  currency,
  birthYear = null,
  portfolioType = "standard",
  retirementAge = null,
}: {
  currentValue: string;
  netContributed?: string;
  monthlyAverage: string;
  seedAnnualReturn: string;
  currency: string;
  birthYear?: number | null;
  portfolioType?: "standard" | "child";
  retirementAge?: number | null;
}) {
  const t = useTranslations("Savings");
  const locale = useLocale();
  const now = new Date().getFullYear();

  // Years from now until the target age (18 for children, retirementAge for adults),
  // clamped to the slider range. Null when there's no target age.
  const yearsToTarget =
    birthYear != null
      ? portfolioType === "child"
        ? Math.min(50, Math.max(1, 18 - (now - birthYear)))
        : retirementAge != null
          ? Math.min(50, Math.max(1, retirementAge - (now - birthYear)))
          : null
      : null;

  const [monthly, setMonthly] = useState(Math.round(Number(monthlyAverage)));
  const [returnPct, setReturnPct] = useState(Math.round(Number(seedAnnualReturn) * 1000) / 10);
  const [years, setYears] = useState(yearsToTarget ?? 10);

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
    const rates = [
      ...new Set([
        Math.max(0, Math.round((returnPct - 3) * 2) / 2),
        returnPct,
        Math.min(15, Math.round((returnPct + 3) * 2) / 2),
      ]),
    ];
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
  const growthPct = value > 0 ? (totalGrowth / value) * 100 : 0;
  const m = (n: number) => formatMoney(n, currency, locale);
  // Scenario chips are only ~1/3 of the card wide — abbreviate 7-figure values.
  const mc = (n: number) => formatMoneyCompact(n, currency, locale);

  const returnLabel = `${formatPercent(returnPct / 100, locale)} p.a.`;

  return (
    <div
      className="rounded-[20px] p-[22px] text-white shadow-[0_12px_30px_rgba(14,159,110,.28)]"
      style={{ background: "linear-gradient(160deg,#0E9F6E,#0B7D58)" }}
    >
      <p className="text-base font-bold">{t("forecastTitle")}</p>
      <p className="mt-px text-xs font-medium text-white/80">{t("forecastSubtitle")}</p>

      {/* Levers — stacked translucent pills (reference), not a grid. */}
      <div className="mt-4 space-y-2.5">
        {/* Monthly top-up: label left, white-filled numeric input right. */}
        <div className="flex items-center justify-between gap-2.5 rounded-[13px] bg-white/12 px-[13px] py-[11px]">
          <Label htmlFor="forecast-monthly" className="text-[11px] font-semibold text-white/82">
            {t("monthlyAmount")}
          </Label>
          <input
            id="forecast-monthly"
            type="number"
            min={0}
            inputMode="numeric"
            value={monthly}
            onChange={(e) => setMonthly(num(e.target.value, 0, 1_000_000))}
            className="tabular h-[30px] w-[134px] rounded-lg border-none bg-white/[.92] px-2.5 text-right text-[13px] font-extrabold text-[#0B3A2A] focus:outline-none"
          />
        </div>

        {/* Expected return: label + bold value on one row, slider below. */}
        <div className="rounded-[13px] bg-white/12 px-[13px] py-[11px]">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <Label htmlFor="forecast-return" className="text-[11px] font-semibold text-white/82">
              {t("annualReturn")}
            </Label>
            <span className="tabular text-[13px] font-extrabold">{returnLabel}</span>
          </div>
          <input
            id="forecast-return"
            type="range"
            min={0}
            max={15}
            step={0.5}
            value={returnPct}
            onChange={(e) => setReturnPct(num(e.target.value, 0, 15))}
            className="h-[22px] w-full accent-white"
          />
        </div>

        {/* Horizon: label (+ optional age-18 preset) + bold value, slider below. */}
        <div className="rounded-[13px] bg-white/12 px-[13px] py-[11px]">
          <div className="mb-1.5 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Label htmlFor="forecast-years" className="text-[11px] font-semibold text-white/82">
                {t("horizonYears")}
              </Label>
              {yearsToTarget !== null && (
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  className="h-5 px-1.5 text-[10px] text-white hover:bg-white/15 hover:text-white"
                  onClick={() => setYears(yearsToTarget)}
                >
                  {portfolioType === "child" ? t("toAge18") : t("toRetirement")}
                </Button>
              )}
            </div>
            <span className="tabular text-[13px] font-extrabold">
              {t("years", { count: years })}
            </span>
          </div>
          <input
            id="forecast-years"
            type="range"
            min={1}
            max={50}
            step={1}
            value={years}
            onChange={(e) => setYears(num(e.target.value, 1, 50))}
            className="h-[22px] w-full accent-white"
          />
        </div>
      </div>

      {/* Hero projected figure + assumptions subtitle. */}
      <div className="mt-[18px]">
        <p className="text-xs font-semibold text-white/80">
          {t("projectedInYears", { count: years })}
        </p>
        <p
          className="tabular mt-0.5 text-[34px] font-extrabold leading-tight"
          data-testid="projected-value"
        >
          {m(value)}
        </p>
        <p className="mt-1 text-xs font-medium text-white/82">
          {t("forecastAssumptions", { amount: m(monthly), rate: returnLabel })}
        </p>
      </div>

      <div className="mt-3.5">
        <ForecastChart series={series} presentValue={currentValue} currency={currency} />
      </div>

      {/* Contributed / growth split — reference: thick track, translucent fill. */}
      <div className="mb-2 mt-3">
        <div className="flex h-[11px] overflow-hidden rounded-md bg-white/[.22]">
          <div className="h-full bg-white/60" style={{ width: `${100 - growthPct}%` }} />
        </div>
        <div className="mt-2 flex items-center justify-between text-[11px] font-semibold text-white/85">
          <span data-testid="projected-contributed">
            {t("projectedContributed")} {m(totalContributed)}
          </span>
          <span data-testid="projected-growth">
            {t("projectedGrowth")} {m(totalGrowth)}
          </span>
        </div>
      </div>

      <div
        className="mt-[18px] grid grid-cols-3 gap-2"
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
                ? "rounded-[13px] border border-white/55 bg-white/24 px-3 py-[11px]"
                : "rounded-[13px] border border-transparent bg-white/12 px-3 py-[11px]"
            }
          >
            <p className="text-[10px] font-semibold text-white/75">
              {formatPercent(s.rate / 100, locale)}
            </p>
            <p className="tabular mt-0.5 text-[15px] font-extrabold">{mc(s.value)}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
