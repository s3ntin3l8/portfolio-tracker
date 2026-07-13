"use client";

import { useMemo } from "react";
import { createPortal } from "react-dom";
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
 * Accessibility: the SVG is a focusable `role="img"` with an `aria-label` summarizing
 * the price range. On hover/focus/tap, a floating tooltip (`ChartTooltipPanel`,
 * matching the rest of the app's chart tooltips) shows the same range with more
 * detail.
 */
export function HoldingSparkline({
  values,
  className,
}: {
  values: number[];
  className?: string;
}) {
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
    const range =
      min === max
        ? minStr
        : `${minStr} – ${maxStr}`;
    return {
      rows: [
        { label: "Range", value: range },
      ] as ChartTooltipRow[],
      rangeLabel: `Price range ${range}`,
    };
  }, [values]);

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
        role="img"
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
            <ChartTooltipPanel rows={tip.content.rows} />
          </div>,
          document.body,
        )}
    </>
  );
}
