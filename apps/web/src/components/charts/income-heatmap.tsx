"use client";

import { useLocale } from "next-intl";
import { formatMoney } from "@/lib/utils";

/**
 * Monthly seasonality grid: one row per year, twelve month columns, each cell's
 * fill scaled by its share of the busiest month. A plain CSS grid (no recharts) so
 * it stays compact and legible on a phone.
 */
export function IncomeHeatmap({
  monthly,
  currency,
}: {
  monthly: { month: string; total: string }[];
  currency: string;
}) {
  const locale = useLocale();

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

  return (
    <div className="space-y-1 text-xs">
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
            {row.map((value, i) => (
              <div
                key={i}
                title={
                  value > 0
                    ? `${monthLabels[i]} ${year}: ${formatMoney(value, currency, locale)}`
                    : undefined
                }
                className="aspect-square rounded-sm bg-primary"
                style={{ opacity: max > 0 ? 0.12 + 0.88 * (value / max) : 0.12 }}
              />
            ))}
          </div>
        );
      })}
    </div>
  );
}
