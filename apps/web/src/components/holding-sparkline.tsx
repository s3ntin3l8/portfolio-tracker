"use client";

import { useMemo } from "react";
import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";
import { useChartTooltip } from "@/components/ui/use-chart-tooltip";
import { ChartTooltipPanel, type ChartTooltipRow } from "@/components/ui/chart-tooltip-panel";

/**
 * A tiny static price-course sparkline for a mobile holdings row (reference "Pocket
 * Prototype" design). Renders the reference's exact 52×24 polyline. Colored by the
 * series' OWN trend (first vs last close) — deliberately not the row's unrealized-P&L
 * color, since a position can be up overall while its recent course is down.
 *
 * `values` are recent daily closes, oldest→newest. Renders nothing for <2 points (the
 * caller also gates on this); a flat series draws a midline instead of dividing by zero.
 *
 * Accessibility: the SVG is keyboard-focusable (`tabIndex={0}`) with an `aria-label`
 * summarizing the price range, and a hover/focus/tap surfaces a floating tooltip with
 * the same range. The trigger intentionally omits a `role` — `role="img"` is for
 * static, non-interactive accessible-name carriers, but a focusable hoverable element
 * is interactive; a bare `aria-label` reads as the trigger's accessible name and the
 * tooltip is associated implicitly via the standard trigger/tooltip DOM relationship.
 * The tooltip's own role="tooltip" + `aria-describedby` linkage is a small follow-up
 * if a screen-reader user ever needs the tooltip content announced on focus.
 */
export function HoldingSparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
  const t = useTranslations("Holdings");
  const tip = useChartTooltip<{ rows: ChartTooltipRow[]; label: string }>();
  const { rows, rangeLabel } = useMemo(() => {
    if (values.length < 2) return { rows: [] as ChartTooltipRow[], rangeLabel: "" };
    const min = Math.min(...values);
    const max = Math.max(...values);
    // Numeric-only; the component is currency-agnostic by design. Callers that
    // want currency formatting can wrap this in their own component.
    const fmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 4 });
    const minStr = fmt.format(min);
    const maxStr = fmt.format(max);
    const range = min === max ? minStr : `${minStr} – ${maxStr}`;
    return {
      // The "Range" row label and the aria-label string are translated so an
      // id-locale user gets Indonesian text instead of the English fallback
      // that #478 shipped with. The aria-label became screen-reader-visible
      // in #478 when the SVG's previous `aria-hidden` was dropped (#6 in the
      // review follow-up), so getting this localized closes that gap.
      rows: [{ label: t("sparklineRange"), value: range }] as ChartTooltipRow[],
      rangeLabel: t("sparklineRangeAria", { range }),
    };
  }, [values, t]);

  if (values.length < 2) return null;

  const W = 60;
  const H = 26;
  const PAD = 3; // keep the 2px round-capped stroke inside the box

  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * W;
      const y = range === 0 ? H / 2 : PAD + (H - 2 * PAD) * (1 - (v - min) / range);
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");

  const up = values[values.length - 1] >= values[0];

  return (
    <>
      <svg
        {...tip.bind({ rows, label: rangeLabel })}
        viewBox="0 0 60 26"
        width={52}
        height={24}
        tabIndex={0}
        aria-label={rangeLabel}
        className={cn("shrink-0", up ? "text-success" : "text-destructive", className)}
      >
        <polyline
          points={points}
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
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
            <ChartTooltipPanel rows={tip.content.rows} onSize={tip.setSize} />
          </div>,
          document.body,
        )}
    </>
  );
}
