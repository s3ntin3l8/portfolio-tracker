"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/** Snapshot-history ranges understood by the API's `rangeStart` (+ `all` → full). */
export const RANGES = ["1m", "3m", "6m", "1y", "all"] as const;
export type ChartRange = (typeof RANGES)[number];

export function RangeToggle({
  value,
  onChange,
  disabled,
}: {
  value: ChartRange;
  onChange: (range: ChartRange) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Chart.range");
  return (
    <div className="flex gap-1" role="group" aria-label={t("label")}>
      {RANGES.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled}
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={cn(
            "rounded-md px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50",
            value === r
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-accent",
          )}
        >
          {t(r)}
        </button>
      ))}
    </div>
  );
}
