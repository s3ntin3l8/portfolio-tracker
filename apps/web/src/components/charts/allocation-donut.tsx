"use client";

import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from "recharts";
import { useLocale } from "next-intl";
import { formatMoney } from "@/lib/utils";
import type { AllocationSlice } from "@/lib/mock-data";

const COLORS = [
  "var(--color-chart-1)",
  "var(--color-chart-2)",
  "var(--color-chart-3)",
  "var(--color-chart-4)",
  "var(--color-chart-5)",
];

export function AllocationDonut({ data }: { data: AllocationSlice[] }) {
  const locale = useLocale();
  const total = data.reduce((s, d) => s + d.value, 0);

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
            >
              {data.map((_, i) => (
                <Cell key={i} fill={COLORS[i % COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              formatter={(value: number) => formatMoney(value, "IDR", locale)}
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
      </div>
      <ul className="grid w-full grid-cols-2 gap-x-4 gap-y-2 text-sm">
        {data.map((d, i) => (
          <li key={d.key} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2">
              <span
                className="size-2.5 rounded-full"
                style={{ background: COLORS[i % COLORS.length] }}
              />
              {d.label}
            </span>
            <span className="tabular text-muted-foreground">
              {((d.value / total) * 100).toFixed(1)}%
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
