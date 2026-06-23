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
  onSliceClick,
}: {
  data: DonutSlice[];
  currency?: string;
  onSliceClick?: (key: string) => void;
}) {
  const locale = useLocale();
  const total = data.reduce((s, d) => s + d.value, 0);

  const handleClick = (entry: DonutSlice) => {
    if (onSliceClick) {
      onSliceClick(entry.key);
    }
  };

  return (
    <div className="flex flex-col items-center gap-4">
      <div className="h-[180px] w-full max-w-[200px]">
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
              onClick={(_: unknown, index: number) => handleClick(data[index])}
              style={{ cursor: onSliceClick ? "pointer" : "default" }}
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value) => formatMoney(Number(value), currency, locale)}
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                color: "var(--color-popover-foreground)",
                fontSize: 12,
              }}
              wrapperStyle={{ zIndex: 50 }}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center justify-between gap-3">
            <button
              type="button"
              onClick={() => handleClick(d)}
              className={`flex items-center gap-2 ${onSliceClick ? "cursor-pointer hover:underline" : "cursor-default"}`}
            >
              <span
                className="size-2.5 rounded-full"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span className="max-w-[100px] text-center leading-tight">{d.label}</span>
            </button>
            <span className="tabular text-muted-foreground">
              {((d.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
