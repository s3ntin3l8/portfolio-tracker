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
import { useLocale, useTranslations } from "next-intl";
import type { ForecastPoint } from "@portfolio/core";
import { formatMoney } from "@/lib/utils";

/**
 * Stacked projection: your money (present value + contributions) at the base,
 * compound growth on top. The whole series is a projection, so it's drawn with
 * a dashed stroke to read as "what-if", not actual history.
 */
export function ForecastChart({
  series,
  presentValue,
  currency,
}: {
  series: ForecastPoint[];
  presentValue: string;
  currency: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Savings");
  const pv = Number(presentValue);

  const data = series.map((p) => {
    const principal = pv + Number(p.contributed);
    const growth = Math.max(0, Number(p.value) - principal);
    return { month: p.monthIndex, principal, growth };
  });

  const money = (v: number) => formatMoney(v, currency, locale);
  const year = (m: number) => `${Math.round(m / 12)}`;

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="forecast-principal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.3} />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.05} />
            </linearGradient>
            <linearGradient id="forecast-growth" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-success)" stopOpacity={0.4} />
              <stop offset="100%" stopColor="var(--color-success)" stopOpacity={0.08} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="month"
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            tickFormatter={year}
            minTickGap={32}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={money}
          />
          <Tooltip
            formatter={(v: number, key) => [
              money(v),
              key === "growth" ? t("projectedGrowth") : t("projectedContributed"),
            ]}
            labelFormatter={(m: number) => `${t("years", { count: Math.round(m / 12) })}`}
            contentStyle={{
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="principal"
            stackId="v"
            stroke="var(--color-primary)"
            strokeWidth={2}
            strokeDasharray="5 4"
            fill="url(#forecast-principal)"
          />
          <Area
            type="monotone"
            dataKey="growth"
            stackId="v"
            stroke="var(--color-success)"
            strokeWidth={2}
            strokeDasharray="5 4"
            fill="url(#forecast-growth)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
