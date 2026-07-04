"use client";

import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { INSTRUMENT_PRICE_RANGES, type InstrumentPriceRange } from "@/lib/instrument-price-range";

/**
 * The Instrument-detail price hero's own 1M/6M/1Y/All chip row — visually mirrors
 * `charts/range-toggle.tsx` but is typed to {@link InstrumentPriceRange}, a deliberately
 * separate (smaller) vocabulary from the portfolio net-worth `ChartRange` — see that file's
 * doc comment for why they're kept apart rather than sharing one generic component.
 */
export function InstrumentRangeToggle({
  value,
  onChange,
  disabled,
}: {
  value: InstrumentPriceRange;
  onChange: (range: InstrumentPriceRange) => void;
  disabled?: boolean;
}) {
  const t = useTranslations("Instrument.priceRange");
  return (
    <div className="flex gap-1" role="group" aria-label={t("label")}>
      {INSTRUMENT_PRICE_RANGES.map((r) => (
        <button
          key={r}
          type="button"
          disabled={disabled}
          onClick={() => onChange(r)}
          aria-pressed={value === r}
          className={cn(
            "rounded-full px-2.5 py-1 text-xs font-semibold transition-colors disabled:opacity-50",
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
