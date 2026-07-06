/**
 * Two-segment horizontal bar — e.g. dividends vs. coupons, win vs. loss amount, or
 * realized-to-date vs. forecasted-remainder. Segments are pre-computed percentages
 * (should sum to ~100, but each is clamped and rendered independently so a
 * slightly-off sum never overflows the track). A `striped` segment renders as a
 * diagonal-stripe hatch instead of a flat fill — same two-layer tint+hatch-line
 * technique (light base + stronger diagonal lines) as the "Projected" segment on
 * the Income page's per-year bar chart (`income-bar-chart.tsx`), so a forecasted
 * amount reads consistently across the app.
 */
export function MiniSplitBar({
  segments,
}: {
  segments: Array<{ pct: number; color: string; striped?: boolean }>;
}) {
  return (
    <div className="flex h-[7px] w-full gap-[3px]">
      {segments.map((s, i) => (
        <div
          key={i}
          className="relative h-full overflow-hidden rounded-full"
          style={{ flex: Math.max(0.5, Math.min(100, s.pct)) }}
        >
          {s.striped ? (
            <>
              <div className="absolute inset-0" style={{ background: s.color, opacity: 0.16 }} />
              <div
                className="absolute inset-0"
                style={{
                  backgroundImage: `repeating-linear-gradient(45deg, ${s.color} 0 2px, transparent 2px 6px)`,
                  opacity: 0.6,
                }}
              />
            </>
          ) : (
            <div className="absolute inset-0" style={{ background: s.color }} />
          )}
        </div>
      ))}
    </div>
  );
}
