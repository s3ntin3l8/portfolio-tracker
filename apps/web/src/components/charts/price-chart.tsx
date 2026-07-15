"use client";

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { useLocale } from "next-intl";
import type { Candle } from "@portfolio/api-client";
import { formatMoney } from "@/lib/utils";

export function PriceChart({
  data,
  currency,
  unit = "currency",
  theme = "default",
  minimal = false,
  showYAxis = true,
  height = 280,
}: {
  data: Candle[];
  currency: string;
  unit?: "currency" | "percent";
  /** "inverse" = white line/fill/tooltip for use inside a dark/brand-colored hero card. */
  theme?: "default" | "inverse";
  /** Hide axes/grid — just the area+line, for a compact sparkline (e.g. the Holdings hero). */
  minimal?: boolean;
  /** Show Y-axis on the left. Disable on narrow viewports — the tooltip cursor already shows the price. */
  showYAxis?: boolean;
  height?: number;
}) {
  const locale = useLocale();
  const points = data.map((d) => ({ date: d.date, close: Number(d.close) }));
  const gradientId = theme === "inverse" ? "price-fill-inverse" : "price-fill";
  const lineColor = theme === "inverse" ? "#ffffff" : "var(--color-primary)";

  const formatValue = (v: number) =>
    unit === "percent"
      ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`
      : formatMoney(v, currency, locale);

  const dateLabelFmt = new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  // The tooltip's label defaults to recharts' x category — which, in `minimal` mode
  // (no <XAxis>), is the row *index* (e.g. "364" on a 1Y daily series). Pull the real
  // `date` off the hovered point's payload instead. Day-grained points carry a raw
  // ISO date (YYYY-MM-DD) → format it; intraday points already carry a display label
  // (e.g. "14:30", "3 Jul") → pass it through untouched.
  const formatLabel = (
    _label: unknown,
    payload: ReadonlyArray<{ payload?: { date?: string } }> | undefined,
  ) => {
    const d = payload?.[0]?.payload?.date;
    if (!d) return "";
    return /^\d{4}-\d{2}-\d{2}/.test(d) ? dateLabelFmt.format(new Date(d)) : d;
  };

  return (
    <div style={{ height }} className="w-full">
      <ResponsiveContainer
        width="100%"
        height="100%"
        initialDimension={{ width: 1, height }}
      >
        <AreaChart
          data={points}
          margin={
            minimal ? { top: 4, right: 0, left: 0, bottom: 0 } : { top: 8, right: 8, left: 0, bottom: 0 }
          }
        >
          <defs>
            <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={lineColor} stopOpacity={theme === "inverse" ? 0.42 : 0.35} />
              <stop offset="100%" stopColor={lineColor} stopOpacity={0} />
            </linearGradient>
          </defs>
          {!minimal && (
            <>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                tickLine={false}
                minTickGap={32}
              />
              {showYAxis && (
                <YAxis
                  tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
                  tickLine={false}
                  axisLine={false}
                  width={72}
                  tickFormatter={formatValue}
                />
              )}
            </>
          )}
          <Tooltip
            formatter={(v) => formatValue(Number(v))}
            labelFormatter={formatLabel}
            cursor={
              theme === "inverse"
                ? { stroke: "rgba(255,255,255,.55)", strokeDasharray: "4 4" }
                : { stroke: "var(--color-border)", strokeDasharray: "4 4" }
            }
            contentStyle={
              theme === "inverse"
                ? {
                    background: "#0f1b14",
                    border: "none",
                    borderRadius: 10,
                    color: "#fff",
                    fontSize: 12,
                  }
                : {
                    background: "var(--color-card)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                    fontSize: 12,
                  }
            }
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke={lineColor}
            strokeWidth={2.4}
            fill={`url(#${gradientId})`}
            activeDot={
              theme === "inverse"
                ? { r: 5, fill: "#fff", stroke: "#0B7D58", strokeWidth: 2.5 }
                : { r: 4 }
            }
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
