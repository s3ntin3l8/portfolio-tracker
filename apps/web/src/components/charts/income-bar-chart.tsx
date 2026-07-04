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
import { useLocale, useTranslations } from "next-intl";
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

/** One labeled row in the tooltip breakdown — a colored dot (omitted for the
 *  no-dot "Total" row) plus a label/value pair. */
interface TooltipRow {
  label: string;
  value: string;
  dot?: string;
  dotOpacity?: number;
}

/**
 * Per-bar hover breakdown, exported so it can be unit-tested directly (the
 * `recharts` `Tooltip` wrapper only invokes `content` at real layout time, which
 * jsdom test stubs don't simulate).
 */
export function ChartTooltip({
  active,
  payload,
  label,
  money,
  t,
}: {
  active?: boolean;
  payload?: Array<{ dataKey: string; value: number; payload: IncomeBar }>;
  label?: string;
  money: (v: number) => string;
  t: (key: string) => string;
}) {
  if (!active || !payload?.length) return null;
  const bar = payload[0]?.payload;
  if (!bar) return null;
  const projected = bar.projected ?? 0;

  const rows: TooltipRow[] = bar.forecast
    ? [{ label: t("tooltipForecast"), value: money(bar.value), dot: "var(--color-primary)" }]
    : [
        { label: t("tooltipReceived"), value: money(bar.value), dot: "var(--color-primary)" },
        ...(projected > 0
          ? [
              {
                label: t("tooltipProjected"),
                value: money(projected),
                dot: "var(--color-primary)",
                dotOpacity: 0.4,
              },
            ]
          : []),
        { label: t("tooltipTotal"), value: money(bar.value + projected) },
      ];

  return (
    <div
      style={{
        background: "var(--color-card)",
        border: "1px solid var(--color-border)",
        borderRadius: 8,
        fontSize: 12,
        padding: "8px 12px",
        minWidth: 168,
      }}
    >
      <p style={{ marginBottom: 6, fontWeight: 700 }}>{label}</p>
      {rows.map((row, i) => (
        <div
          key={row.label}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            marginTop: i === 0 ? 0 : 4,
          }}
        >
          <span style={{ display: "flex", alignItems: "center", gap: 6, opacity: 0.85 }}>
            {row.dot && (
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 2,
                  background: row.dot,
                  opacity: row.dotOpacity ?? 1,
                  display: "inline-block",
                }}
              />
            )}
            {row.label}
          </span>
          <span style={{ fontWeight: 700 }}>{row.value}</span>
        </div>
      ))}
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
  const t = useTranslations("Income");
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
            content={<ChartTooltip money={money} t={t} />}
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
