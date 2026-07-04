/**
 * Two-segment horizontal bar — e.g. dividends vs. coupons, or win vs. loss amount.
 * Segments are pre-computed percentages (should sum to ~100, but each is clamped and
 * rendered independently so a slightly-off sum never overflows the track).
 */
export function MiniSplitBar({
  segments,
}: {
  segments: Array<{ pct: number; color: string }>;
}) {
  return (
    <div className="flex h-1.5 w-full overflow-hidden rounded-full bg-muted">
      {segments.map((s, i) => (
        <div
          key={i}
          style={{ width: `${Math.max(0, Math.min(100, s.pct))}%`, background: s.color }}
        />
      ))}
    </div>
  );
}
