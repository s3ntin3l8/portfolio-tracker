import { Card } from "@/components/ui/card";
import { cn, formatPercent } from "@/lib/utils";
import type { Mover } from "@/lib/movers";

const ASSET_CLASS_COLOR: Record<string, string> = {
  equity: "var(--color-chart-1)",
  gold: "var(--color-chart-2)",
  bond: "var(--color-chart-3)",
  mutual_fund: "var(--color-chart-4)",
  etf: "var(--color-chart-4)",
  crypto: "var(--color-chart-4)",
  cash: "var(--color-chart-5)",
  derivative: "var(--color-chart-5)",
};

function MoverRow({ mover, label, locale }: { mover: Mover; label: string; locale: string }) {
  const color = ASSET_CLASS_COLOR[mover.assetClass] ?? "var(--color-chart-5)";
  return (
    <div className="flex items-center gap-3">
      <span
        className="flex size-9 shrink-0 items-center justify-center rounded-[10px] text-xs font-bold text-white"
        style={{ background: color }}
      >
        {mover.symbol.slice(0, 2).toUpperCase()}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold">{mover.symbol}</p>
        <p className="text-xs text-muted-foreground">{label}</p>
      </div>
      <span
        className={cn(
          "tabular shrink-0 text-sm font-bold",
          mover.pct >= 0 ? "text-success" : "text-destructive",
        )}
      >
        {formatPercent(mover.pct, locale)}
      </span>
    </div>
  );
}

/** The Insights "Best & worst" card — the day's biggest winning and losing open holding. */
export function BestWorstCard({
  best,
  worst,
  title,
  bestLabel,
  worstLabel,
  locale,
}: {
  best: Mover;
  worst: Mover;
  title: string;
  bestLabel: string;
  worstLabel: string;
  locale: string;
}) {
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-base font-bold">{title}</h2>
      <MoverRow mover={best} label={bestLabel} locale={locale} />
      <MoverRow mover={worst} label={worstLabel} locale={locale} />
    </Card>
  );
}
