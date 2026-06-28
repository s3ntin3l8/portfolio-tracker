"use client";

import { useTranslations, useLocale } from "next-intl";
import { PiggyBank, Info } from "lucide-react";
import {
  ComposedChart,
  Area,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
  useActiveTooltipDataPoints,
  useActiveTooltipLabel,
  useIsTooltipActive,
} from "recharts";
import type { PerformancePoint } from "@portfolio/api-client";
import { PriceChart } from "@/components/charts/price-chart";
import { EmptyState } from "@/components/empty-state";
import { mergeContributionValue } from "@/lib/chart-series";
import { formatMoney } from "@/lib/utils";

/**
 * Contributions vs. portfolio value overlay chart.
 *
 * When `valueHistory` has ≥ 2 points the chart renders both series on a daily
 * x-axis: a shaded gain/loss band between contributions and value, with crisp
 * boundary lines on top.  When history is absent it degrades to the legacy
 * single-series cumulative-contributions area chart.
 */
export function ContributionsChart({
  series,
  dailySeries,
  valueHistory,
  currency,
}: {
  series: { month: string; contributed: string }[];
  dailySeries: { date: string; contributed: string }[];
  valueHistory: PerformancePoint[];
  currency: string;
}) {
  const t = useTranslations("Savings");
  const te = useTranslations("Empty");
  const locale = useLocale();

  // Attempt the full overlay merge. Uses the day-resolution series so the contributed
  // step lands on the actual transaction day, aligned with the daily value line.
  const merged = mergeContributionValue(dailySeries, valueHistory);

  // ── OVERLAY PATH ─────────────────────────────────────────────────────────
  if (merged.length >= 2) {
    // Derive per-point band fields.
    // At every x exactly one of gain/loss is non-zero, so stacking
    // floor + gain + loss places the filled area correctly.
    const data = merged.map((p) => {
      const floor = Math.min(p.value, p.contributed);
      return {
        date: p.date,
        contributed: p.contributed,
        value: p.value,
        floor,
        gain: Math.max(0, p.value - p.contributed),
        loss: Math.max(0, p.contributed - p.value),
      };
    });

    const money = (v: number) => formatMoney(v, currency, locale);

    return (
      <div className="h-[280px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={data}
            margin={{ top: 8, right: 8, left: 0, bottom: 0 }}
          >
            <defs>
              {/* Transparent base so the band starts at the lower of the two lines */}
              <linearGradient id="cv-floor" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="transparent" stopOpacity={0} />
              </linearGradient>
              {/* Green fill: value > contributions */}
              <linearGradient id="cv-gain" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--color-success)"
                  stopOpacity={0.35}
                />
                <stop
                  offset="100%"
                  stopColor="var(--color-success)"
                  stopOpacity={0.05}
                />
              </linearGradient>
              {/* Red fill: value < contributions */}
              <linearGradient id="cv-loss" x1="0" y1="0" x2="0" y2="1">
                <stop
                  offset="0%"
                  stopColor="var(--color-destructive)"
                  stopOpacity={0.3}
                />
                <stop
                  offset="100%"
                  stopColor="var(--color-destructive)"
                  stopOpacity={0.05}
                />
              </linearGradient>
            </defs>
            <CartesianGrid
              strokeDasharray="3 3"
              stroke="var(--color-border)"
              vertical={false}
            />
            <XAxis
              dataKey="date"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              minTickGap={48}
            />
            <YAxis
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              width={72}
              tickFormatter={(v: number) => money(v)}
            />
            <Tooltip content={<OverlayTooltip money={money} t={t} />} />

            {/* Transparent base Area — establishes the lower boundary of the band */}
            <Area
              type="monotone"
              dataKey="floor"
              stackId="band"
              stroke="none"
              fill="url(#cv-floor)"
              legendType="none"
              tooltipType="none"
            />
            {/* Green gain band */}
            <Area
              type="monotone"
              dataKey="gain"
              stackId="band"
              stroke="none"
              fill="url(#cv-gain)"
              legendType="none"
              tooltipType="none"
            />
            {/* Red loss band */}
            <Area
              type="monotone"
              dataKey="loss"
              stackId="band"
              stroke="none"
              fill="url(#cv-loss)"
              legendType="none"
              tooltipType="none"
            />

            {/* Crisp boundary: contributions step line */}
            <Line
              type="stepAfter"
              dataKey="contributed"
              stroke="var(--color-muted-foreground)"
              strokeWidth={1.5}
              dot={false}
              strokeDasharray="4 3"
            />
            {/* Crisp boundary: daily value line */}
            <Line
              type="monotone"
              dataKey="value"
              stroke="var(--color-primary)"
              strokeWidth={2}
              dot={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    );
  }

  // ── DEGRADED PATH ─────────────────────────────────────────────────────────
  // No value history — fall back to the legacy single-series chart plus an
  // info note so the user knows why the overlay is missing.

  // Running total as a prefix sum (same logic as before).
  const points = series.map((s, i) => ({
    date: s.month,
    close: series
      .slice(0, i + 1)
      .reduce((sum, x) => sum + Number(x.contributed), 0)
      .toString(),
  }));

  if (points.length < 2) {
    return (
      <EmptyState
        icon={PiggyBank}
        title={te("historyTitle")}
        description={te("historyBody")}
      />
    );
  }

  return (
    <div className="space-y-2">
      <PriceChart data={points} currency={currency} />
      <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <Info className="h-3.5 w-3.5 shrink-0" />
        {t("chartValueUnavailable")}
      </p>
    </div>
  );
}

/**
 * Custom tooltip rendered inside the recharts context.
 * Uses recharts v3 hooks to read the hovered point, showing Contributions and
 * Value while hiding the internal band keys (floor/gain/loss).
 */
function OverlayTooltip({
  money,
  t,
}: {
  money: (v: number) => string;
  t: ReturnType<typeof useTranslations<"Savings">>;
}) {
  const active = useIsTooltipActive();
  const label = useActiveTooltipLabel();
  // Each entry is one raw data row from the chart's `data` array.
  const points = useActiveTooltipDataPoints<{
    date: string;
    contributed: number;
    value: number;
    floor: number;
    gain: number;
    loss: number;
  }>();

  if (!active || !points?.length) return null;

  const p = points[0];

  return (
    <div
      style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 12,
        padding: "6px 10px",
      }}
    >
      <p style={{ color: "var(--color-muted-foreground)", marginBottom: 4 }}>
        {label}
      </p>
      <p style={{ color: "var(--color-muted-foreground)" }}>
        {t("chartContributions")}: {money(p.contributed)}
      </p>
      <p style={{ color: "var(--color-primary)" }}>
        {t("chartValue")}: {money(p.value)}
      </p>
    </div>
  );
}
