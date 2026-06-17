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
  /** Projected (rest-of-year) income stacked on top of the paid amount. */
  projected?: number;
  /** Drawn muted/translucent to read as a projection, not actual income. */
  forecast?: boolean;
}

function ChartTooltip({
  active,
  payload,
  label,
  money,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; payload: IncomeBar }>;
  label?: string;
  money: (v: number) => string;
}) {
  if (!active || !payload?.length) return null;
  const bar = payload[0]?.payload;
  if (!bar) return null;
  const projected = bar.projected ?? 0;
  return (
    <div
      style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 12px",
      }}
    >
      <p style={{ marginBottom: 4, fontWeight: 500 }}>{label}</p>
      {projected > 0 ? (
        <>
          <p>{money(bar.value)}</p>
          <p style={{ opacity: 0.6 }}>{money(projected)}</p>
          <p style={{ fontWeight: 500, marginTop: 2 }}>{money(bar.value + projected)}</p>
        </>
      ) : (
        <p>{money(bar.value + projected)}</p>
      )}
    </div>
  );
}

/**
 * Income per calendar year as a bar chart, with the next-year forecast appended as
 * a muted bar. Current-year bars stack projected rest-of-year income on top of
 * paid amounts as a shaded segment. Theming + axes mirror
 * {@link ForecastChart}/{@link PriceChart}.
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
            content={<ChartTooltip money={money} />}
          />
          <Bar dataKey="value" stackId="stack" radius={[4, 4, 0, 0]}>
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
          <Bar dataKey="projected" stackId="stack">
            {data.map((d, i) => (
              <Cell
                key={i}
                fill="var(--color-primary)"
                fillOpacity={0.25}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}
