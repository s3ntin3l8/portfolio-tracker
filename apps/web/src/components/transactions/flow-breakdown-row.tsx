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
  return (
    <div className="flex items-center gap-2.5">
      <span className="size-2.5 shrink-0 rounded-[3px]" style={{ background: color }} />
      <span className="min-w-0 flex-1 truncate text-xs font-semibold">{label}</span>
      <div className="h-[7px] w-[74px] shrink-0 overflow-hidden rounded-full bg-muted">
        <div
          className="h-full rounded-full"
          style={{ width: `${Math.max(0, Math.min(100, pct))}%`, background: color }}
        />
      </div>
      <span className="tabular shrink-0 text-xs font-bold">{value}</span>
    </div>
  );
}
