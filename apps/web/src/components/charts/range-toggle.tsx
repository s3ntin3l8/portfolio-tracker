"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/**
 * Snapshot-history ranges. `1d`/`7d` read the timestamped intraday table (see
 * net-worth-history-chart.tsx); the rest are understood by the API's `rangeStart`
 * (+ `all` → full) against the day-grained daily-snapshot table.
 */
export const RANGES = ["1d", "7d", "1m", "3m", "ytd", "1y", "all"] as const;
export type ChartRange = (typeof RANGES)[number];

export function RangeToggle({
  value,
  onChange,
  disabled,
  ranges = RANGES,
  theme = "default",
}: {
  value: ChartRange;
  onChange: (range: ChartRange) => void;
  disabled?: boolean;
  /** Subset of ranges to render as chips (e.g. the hero card only shows 1D/7D/1M/1Y/ALL). */
  ranges?: readonly ChartRange[];
  /** "inverse" = white-on-green pills for use inside a dark/brand-colored hero card. */
  theme?: "default" | "inverse";
}) {
  const t = useTranslations("Chart.range");
  return (
    <div className="flex gap-1" role="group" aria-label={t("label")}>
      {ranges.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled}
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
            theme === "inverse"
              ? value === r
                ? "bg-white text-[#0B7D58]"
                : "bg-transparent text-white/85 hover:bg-white/10"
              : cn(
                  "rounded-md",
                  value === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-accent",
                ),
          )}
        >
          {t(r)}
        </button>
      ))}
    </div>
  );
}
