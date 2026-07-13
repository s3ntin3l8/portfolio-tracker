"use client";

import { createPortal } from "react-dom";
import { useTranslations } from "next-intl";
import { useChartTooltip } from "@/components/ui/use-chart-tooltip";
import { ChartTooltipPanel, type ChartTooltipRow } from "@/components/ui/chart-tooltip-panel";

/**
 * Two-segment horizontal bar — e.g. dividends vs. coupons, win vs. loss amount, or
 * realized-to-date vs. forecasted-remainder. Segments are pre-computed percentages
 * (should sum to ~100, but each is clamped and rendered independently so a
 * slightly-off sum never overflows the track). A `striped` segment renders as a
 * diagonal-stripe hatch instead of a flat fill — same two-layer tint+hatch-line
 * technique (light base + stronger diagonal lines) as the "Projected" segment on
 * the Income page's per-year bar chart (`income-bar-chart.tsx`), so a forecasted
 * amount reads consistently across the app.
 *
 * Each segment is hoverable/focusable: a `useChartTooltip` per segment renders a
 * floating tooltip on hover/focus/tap. Optional `label`/`amount`/`amountLabel`
 * fields on the segment shape the tooltip's content (label is required for a
 * useful tooltip — the segment color alone is ambiguous when two segments share
 * a hue family). When callers don't supply `label` or `amountLabel`, the
 * component falls back to translated defaults from the `Chart` namespace
 * (Chart.share / Chart.amount) so an id-locale user sees Indonesian, not English.
 */
export interface MiniSplitBarSegment {
  pct: number;
  color: string;
  striped?: boolean;
  /** Optional semantic label shown in the tooltip (e.g. "Wins", "Forecast"). */
  label?: string;
  /** Optional pre-formatted amount shown in the tooltip (e.g. "Rp 1.2M"). */
  amount?: string;
  /** Optional label for the amount row in the tooltip (defaults to Chart.amount). */
  amountLabel?: string;
}

export function MiniSplitBar({
  segments,
}: {
  segments: MiniSplitBarSegment[];
}) {
  return (
    <div className="flex h-[7px] w-full gap-[3px]">
      {segments.map((s, i) => (
        <Segment key={i} segment={s} />
      ))}
    </div>
  );
}

function Segment({ segment }: { segment: MiniSplitBarSegment }) {
  const t = useTranslations("Chart");
  const tip = useChartTooltip<{ rows: ChartTooltipRow[]; label: string }>();
  const { pct, color, striped, label, amount, amountLabel } = segment;
  const flex = Math.max(0.5, Math.min(100, pct));
  const hasContent = label !== undefined || amount !== undefined;
  const a11yLabel = label ? `${label}: ${pct.toFixed(1)}%` : `${pct.toFixed(1)}%`;
  // Translated defaults so the fallback rows aren't English-only. The caller
  // can still override via `label` / `amountLabel`. This closes the #478
  // review's #3 gap: the bar was previously always-English for callers that
  // didn't supply labels.
  const rows: ChartTooltipRow[] = [];
  rows.push({
    label: label ?? t("share"),
    value: `${pct.toFixed(1)}%`,
    dot: color,
  });
  if (amount) {
    rows.push({ label: amountLabel ?? t("amount"), value: amount });
  }
  return (
    <>
      {/* No `role` on the trigger. `role="img"` is for static, non-interactive
          accessible-name carriers; a focusable hoverable element is
          interactive, so a bare `aria-label` is the right pattern. The
          floating tooltip is associated implicitly via the trigger/tooltip
          DOM relationship. Adding `aria-describedby` + `role="tooltip"` is
          the next step if a screen-reader user ever needs the tooltip
          content announced on focus. */}
      <div
        {...tip.bind({ rows, label: a11yLabel })}
        tabIndex={hasContent ? 0 : undefined}
        aria-label={hasContent ? a11yLabel : undefined}
        className="relative h-full overflow-hidden rounded-full"
        style={{ flex }}
      >
        {striped ? (
          <>
            <div className="absolute inset-0" style={{ background: color, opacity: 0.16 }} />
            <div
              className="absolute inset-0"
              style={{
                backgroundImage: `repeating-linear-gradient(45deg, ${color} 0 2px, transparent 2px 6px)`,
                opacity: 0.6,
              }}
            />
          </>
        ) : (
          <div className="absolute inset-0" style={{ background: color }} />
        )}
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
            <ChartTooltipPanel rows={tip.content.rows} onSize={tip.setSize} />
          </div>,
          document.body,
        )}
    </>
  );
}
