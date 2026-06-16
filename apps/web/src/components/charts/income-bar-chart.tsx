"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ResponsiveContainer,
} from "recharts";
import { useLocale } from "next-intl";
import { formatMoney } from "@/lib/utils";

/** One bar — a calendar year of income, or the dashed next-year forecast. */
export interface IncomeBar {
  label: string;
  value: number;
  /** Drawn muted/translucent to read as a projection, not actual income. */
  forecast?: boolean;
}

/**
 * Income per calendar year as a bar chart, with the next-year forecast appended as
 * a muted bar. Theming + axes mirror {@link ForecastChart}/{@link PriceChart}.
 */
export function IncomeBarChart({
  data,
  currency,
}: {
  data: IncomeBar[];
  currency: string;
}) {
  const locale = useLocale();
  const money = (v: number) => formatMoney(v, currency, locale);

  return (
    <div className="h-[280px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <CartesianGrid
            strokeDasharray="3 3"
            stroke="var(--color-border)"
            vertical={false}
          />
          <XAxis
            dataKey="label"
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            minTickGap={8}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
            tickLine={false}
            axisLine={false}
            width={72}
            tickFormatter={money}
          />
          <Tooltip
            cursor={{ fill: "var(--color-muted)", opacity: 0.3 }}
            formatter={(v) => money(Number(v))}
            contentStyle={{
              background: "var(--color-card)",
              border: "1px solid var(--color-border)",
              borderRadius: 8,
              fontSize: 12,
            }}
          />
          <Bar dataKey="value" radius={[4, 4, 0, 0]}>
            {data.map((d, i) => (
              <Cell
                key={i}
                fill={
                  d.forecast
                    ? "var(--color-muted-foreground)"
                    : "var(--color-primary)"
                }
                fillOpacity={d.forecast ? 0.4 : 1}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
