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
}: {
  data: Candle[];
  currency: string;
}) {
  const locale = useLocale();
  const points = data.map((d) => ({ date: d.date, close: Number(d.close) }));

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="price-fill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.35} />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" vertical={false} />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={(v: number) => formatMoney(v, currency, locale)}
          />
          <Tooltip
            formatter={(v: number) => formatMoney(v, currency, locale)}
            contentStyle={{
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Area
            type="monotone"
            dataKey="close"
            stroke="var(--color-primary)"
            strokeWidth={2}
            fill="url(#price-fill)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
