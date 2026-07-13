"use client";

import { useState } from "react";
import { createPortal } from "react-dom";
import { useLocale, useTranslations } from "next-intl";
import { cn, formatMoney } from "@/lib/utils";
import { useChartTooltip } from "@/components/ui/use-chart-tooltip";
import { ChartTooltipPanel, type ChartTooltipRow } from "@/components/ui/chart-tooltip-panel";

/**
 * Monthly seasonality grid: one row per year, twelve month columns, each cell's
 * fill scaled by its share of the busiest month. A plain CSS grid (no recharts) so
 * it stays compact and legible on a phone.
 *
 * Two read affordances, both layered:
 * - Subtitle (above the grid): the keyboard/server-rendered fallback that updates
 *   when a cell is clicked. Always present, no JS interaction needed.
 * - Floating tooltip (portal'd, hover/focus/tap): the explicit hover affordance
 *   matching the rest of the app's chart tooltips (same visual shell as
 *   `ChartTooltipPanel`).
 *
 * Both display the same content ({month, amount}) so a screen-reader/keyboard
 * user gets the same data as a mouse user.
 */
export function IncomeHeatmap({
  monthly,
  currency,
}: {
  monthly: { month: string; total: string }[];
  currency: string;
}) {
  const locale = useLocale();
  const t = useTranslations("Income");
  const [active, setActive] = useState<{ year: string; monthIdx: number } | null>(null);
  const tip = useChartTooltip<{ title: string; rows: ChartTooltipRow[] }>();

  // Fold the flat month list into a year → 12-month-totals matrix.
  const byYear = new Map<string, number[]>();
  let max = 0;
  for (const m of monthly) {
    const [year, mm] = m.month.split("-");
    const idx = Number(mm) - 1;
    const row = byYear.get(year) ?? Array.from({ length: 12 }, () => 0);
    row[idx] += Number(m.total);
    byYear.set(year, row);
    if (row[idx] > max) max = row[idx];
  }
  const years = [...byYear.keys()].sort();

  const monthFmt = new Intl.DateTimeFormat(locale, { month: "narrow" });
  const monthLabels = Array.from({ length: 12 }, (_, i) =>
    monthFmt.format(new Date(Date.UTC(2020, i, 1))),
  );
  const monthFullFmt = new Intl.DateTimeFormat(locale, { month: "short" });
  const monthFullLabels = Array.from({ length: 12 }, (_, i) =>
    monthFullFmt.format(new Date(Date.UTC(2020, i, 1))),
  );

  const activeValue = active ? (byYear.get(active.year)?.[active.monthIdx] ?? 0) : 0;
  const subtitle = active
    ? t("heatmapCellSubtitle", {
        month: `${monthFullLabels[active.monthIdx]} ${active.year}`,
        amount: activeValue > 0 ? formatMoney(activeValue, currency, locale) : "—",
      })
    : t("heatmapDefaultSubtitle");

  return (
    <div className="space-y-2 text-xs">
      <p className="min-h-4 font-medium text-muted-foreground">{subtitle}</p>
      <div className="grid grid-cols-[2.5rem_repeat(12,minmax(0,1fr))] gap-1 text-center text-muted-foreground">
        <span />
        {monthLabels.map((label, i) => (
          <span key={i}>{label}</span>
        ))}
      </div>
      {years.map((year) => {
        const row = byYear.get(year) ?? [];
        return (
          <div
            key={year}
            className="grid grid-cols-[2.5rem_repeat(12,minmax(0,1fr))] items-center gap-1"
          >
            <span className="tabular text-muted-foreground">{year}</span>
            {row.map((value, i) => {
              const cellTitle =
                value > 0
                  ? `${monthFullLabels[i]} ${year}: ${formatMoney(value, currency, locale)}`
                  : `${monthFullLabels[i]} ${year}`;
              const isActive = active?.year === year && active.monthIdx === i;
              return (
                <button
                  key={i}
                  {...tip.bind({
                    title: `${monthFullLabels[i]} ${year}`,
                    rows: [
                      {
                        label: t("heatmapCellAmount"),
                        value: value > 0 ? formatMoney(value, currency, locale) : "—",
                        dot: "var(--color-primary)",
                      },
                    ],
                  })}
                  type="button"
                  title={cellTitle}
                  aria-label={cellTitle}
                  aria-pressed={isActive}
                  onClick={() => setActive({ year, monthIdx: i })}
                  className={cn(
                    "aspect-square rounded-[4px] p-0",
                    value > 0 ? "bg-primary" : "bg-muted",
                    isActive && "ring-2 ring-foreground ring-offset-1 ring-offset-background",
                  )}
                  style={value > 0 ? { opacity: 0.14 + 0.86 * (value / max) } : undefined}
                />
              );
            })}
          </div>
        );
      })}
      <div className="flex items-center justify-end gap-1.5 pt-1 text-muted-foreground">
        <span>{t("heatmapLess")}</span>
        {[0.14, 0.4, 0.66, 1].map((opacity) => (
          <span
            key={opacity}
            className="size-2.5 rounded-[3px] bg-primary"
            style={{ opacity }}
          />
        ))}
        <span>{t("heatmapMore")}</span>
      </div>
      {tip.open &&
        tip.content &&
        typeof document !== "undefined" &&
        createPortal(
          <div
            style={{
              position: "fixed",
              top: tip.y,
              left: tip.x,
              zIndex: 60,
              pointerEvents: "none",
            }}
          >
            <ChartTooltipPanel title={tip.content.title} rows={tip.content.rows} />
          </div>,
          document.body,
        )}
    </div>
  );
}
