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
  showPercent = true,
}: {
  data: DonutSlice[];
  currency?: string;
  total?: number;
  label?: string;
  onSliceClick?: (key: string) => void;
  /** Whether the legend shows a trailing "%" column — the Holdings allocation card
   *  does, Income's "By source" card doesn't (value only). Default true. */
  showPercent?: boolean;
}) {
  const locale = useLocale();
  const sum = data.reduce((s, d) => s + d.value, 0);
  const displayTotal = total ?? sum;
  const compact = (n: number) =>
    new Intl.NumberFormat(locale, {
      style: "currency",
      currency,
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: currency === "IDR" ? 0 : 1,
    }).format(n);
  const formattedTotal = displayTotal > 0 ? compact(displayTotal) : null;

  // Transcribed from `Pocket Prototype.dc.html` (desktop Holdings allocation card):
  // 128px donut (r54/13 stroke on a 120 viewBox → inner ≈50/outer ≈64 at 128px),
  // center "Assets" 600 10px + total 800 15px; legend rows gap-10px, 10×10 3px-radius
  // square swatch, label 600 12px, value 600 11px, pct 700 12px in a 50px column.
  return (
    <div className="flex items-center gap-7">
      <div className="relative h-32 w-32 shrink-0">
        <ResponsiveContainer
          width="100%"
          height="100%"
          initialDimension={{ width: 128, height: 128 }}
        >
          <PieChart>
            <Pie
              data={data}
              dataKey="value"
              nameKey="label"
              innerRadius={50}
              outerRadius={64}
              paddingAngle={0}
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
          <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center px-2">
            <span className="text-center text-[10px] font-semibold text-text-3">{label}</span>
            <span className="tabular mt-0.5 text-center text-[15px] font-extrabold">
              {formattedTotal}
            </span>
          </div>
        )}
      </div>
      <ul className="flex min-w-0 flex-1 flex-col gap-2.5">
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSliceClick?.(d.key)}
              className={`flex min-w-0 flex-1 items-center gap-2 ${onSliceClick ? "cursor-pointer hover:underline" : "cursor-default"}`}
            >
              <span
                className="size-2.5 shrink-0 rounded-[3px]"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              <span className="truncate text-xs font-semibold">{d.label}</span>
            </button>
            <span className="tabular shrink-0 text-right text-[11px] font-semibold text-text-2">
              {compact(d.value)}
            </span>
            {showPercent && (
              <span className="tabular w-[50px] shrink-0 text-right text-xs font-bold">
                {((d.value / sum) * 100).toFixed(1)}%
              </span>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
