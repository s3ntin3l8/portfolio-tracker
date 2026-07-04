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
    <div className="mt-3 flex items-end justify-between gap-3 border-t border-border pt-3">
      <div className="flex gap-4">
        {metrics.map((m, i) => (
          <div key={i}>
            <p className="text-[11px] text-muted-foreground">{m.label}</p>
            <p className="tabular text-sm font-semibold" style={m.color ? { color: m.color } : undefined}>
              {m.value}
            </p>
          </div>
        ))}
      </div>
      <span
        className="flex shrink-0 items-center gap-0.5 text-xs font-semibold"
        style={{ color: accentColor }}
      >
        {openLabel}
        <ChevronRight className="size-3.5" />
      </span>
    </div>
  );
}
