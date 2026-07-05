"use client";

import {
  BarChart,
  Bar,
  Cell,
  XAxis,
  Tooltip,
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
    <div className="space-y-2">
      {/* Legend — reference shows Received / Projected (striped) / Forecast (dashed). */}
      <div className="flex items-center justify-end gap-4 text-xs font-semibold text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm bg-primary" />
          {t("tooltipReceived")}
        </span>
        <span className="flex items-center gap-1.5">
          <span
            className="size-2.5 rounded-sm bg-primary/25"
            style={{
              backgroundImage:
                "repeating-linear-gradient(45deg, var(--color-primary) 0 1.5px, transparent 1.5px 4px)",
            }}
          />
          {t("tooltipProjected")}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-2.5 rounded-sm border border-dashed border-primary bg-primary/10" />
          {t("tooltipForecast")}
        </span>
      </div>

      <div className="h-[200px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
            <defs>
              {/* Diagonal-stripe hatch for the "projected" (rest-of-year) segment. */}
              <pattern
                id="income-projected-stripe"
                width={6}
                height={6}
                patternTransform="rotate(45)"
                patternUnits="userSpaceOnUse"
              >
                <rect width={6} height={6} fill="var(--color-primary)" fillOpacity={0.14} />
                <line x1={0} y1={0} x2={0} y2={6} stroke="var(--color-primary)" strokeOpacity={0.55} strokeWidth={2} />
              </pattern>
            </defs>
            <XAxis
              dataKey="label"
              tick={{ fontSize: 11, fill: "var(--color-muted-foreground)" }}
              tickLine={false}
              axisLine={false}
              minTickGap={8}
            />
            <Tooltip
              cursor={{ fill: "var(--color-muted)", opacity: 0.3 }}
              content={<ChartTooltip money={money} t={t} />}
            />
            <Bar dataKey="value" stackId="stack" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => (
                <Cell
                  key={i}
                  fill={d.forecast ? "var(--color-primary)" : "var(--color-primary)"}
                  fillOpacity={d.forecast ? 0.12 : 1}
                  stroke={d.forecast ? "var(--color-primary)" : undefined}
                  strokeWidth={d.forecast ? 2 : undefined}
                  strokeDasharray={d.forecast ? "4 3" : undefined}
                />
              ))}
            </Bar>
            <Bar dataKey="projected" stackId="stack" radius={[4, 4, 0, 0]}>
              {data.map((d, i) => (
                <Cell key={i} fill="url(#income-projected-stripe)" />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
