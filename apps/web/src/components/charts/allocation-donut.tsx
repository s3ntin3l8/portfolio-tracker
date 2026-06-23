"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useLocale } from "next-intl";
import { formatMoney } from "@/lib/utils";

/** A single donut slice — any keyed category (asset class, currency, …). */
export interface DonutSlice {
  key: string;
  label: string;
  value: number;
}

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export function AllocationDonut({
  data,
  currency = "IDR",
  total,
  label = "Total",
  onSliceClick,
}: {
  data: DonutSlice[];
  currency?: string;
  total?: number;
  label?: string;
  onSliceClick?: (key: string) => void;
}) {
  const locale = useLocale();
  const sum = data.reduce((s, d) => s + d.value, 0);
  const displayTotal = total ?? sum;
  const formattedTotal =
    displayTotal > 0
      ? new Intl.NumberFormat(locale, {
          style: "currency",
          currency,
          notation: "compact",
          compactDisplay: "short",
          maximumFractionDigits: currency === "IDR" ? 0 : 1,
        }).format(displayTotal)
      : null;

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="relative h-[180px] w-full max-w-[200px]">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={58}
              outerRadius={84}
              paddingAngle={2}
              strokeWidth={0}
              onClick={(entry) => onSliceClick?.(entry.payload.key)}
              style={{ cursor: onSliceClick ? "pointer" : undefined }}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => formatMoney(Number(value), currency, locale)}
              wrapperStyle={{ zIndex: 50 }}
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-popover-foreground)",
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        {formattedTotal && (
          <div className="absolute inset-0 flex flex-col items-center justify-center pointer-events-none">
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground max-w-[100px] text-center leading-tight">
              {label}
            </span>
            <span className="text-lg font-bold tabular-nums">{formattedTotal}</span>
          </div>
        )}
      </div>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => onSliceClick?.(d.key)}
              className={`flex items-center gap-2 ${onSliceClick ? "cursor-pointer hover:underline" : "cursor-default"}`}
            >
              <span
                className="size-2.5 rounded-full"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              {d.label}
            </button>
            <span className="tabular text-muted-foreground">
              {((d.value / sum) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
