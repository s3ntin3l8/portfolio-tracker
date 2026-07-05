/**
 * Shared "color dot + label + mini progress bar + right-aligned value" row used by all three
 * Activity filter banners (All's "Cash flow mix", Income's "By source", Buys/Sells' per-symbol
 * breakdown) — see `activity-banners.tsx`.
 */
export function FlowBreakdownRow({
  label,
  value,
  pct,
  color,
}: {
  label: string;
  value: string;
  /** Bar width, 0-100 — callers pre-compute this against their own max. */
  pct: number;
  color: string;
}) {
  // The value sits before the bar and the bar is the last element, so both the values and
  // the fixed-width bars form clean right-aligned columns (a trailing variable-width value
  // would otherwise push each bar to a different x and misalign them vertically).
  return (
    <div className="flex items-center gap-2.5">
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
      <span className="tabular shrink-0 text-xs font-bold">{value}</span>
      <div className="h-[7px] w-16 shrink-0 overflow-hidden rounded-[5px] bg-line">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
        />
      </div>
    </div>
  );
}
