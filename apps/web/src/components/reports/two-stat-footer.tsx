import { ChevronRight } from "lucide-react";

/**
 * Footer row shared by every {@link ReportCard}: up to two small label/value stats on the
 * left, an "Open ›" affordance on the right (tinted to match the card's icon color).
 */
export function TwoStatFooter({
  metrics,
  openLabel,
  accentColor,
}: {
  metrics: Array<{ label: string; value: string; color?: string }>;
  openLabel: string;
  accentColor: string;
}) {
  return (
    <div className="mt-auto flex items-end justify-between gap-3.5 border-t border-line pt-4">
      <div className="flex gap-4">
        {metrics.map((m, i) => (
          <div key={i}>
            <p className="text-[10px] font-semibold uppercase tracking-[.03em] text-text-3">{m.label}</p>
            <p className="tabular mt-[3px] text-[15px] font-bold" style={m.color ? { color: m.color } : undefined}>
              {m.value}
            </p>
          </div>
        ))}
      </div>
      <span
        className="flex shrink-0 items-center gap-0.5 text-[13px] font-bold"
        style={{ color: accentColor }}
      >
        {openLabel}
        <ChevronRight className="size-3.5" />
      </span>
    </div>
  );
}
