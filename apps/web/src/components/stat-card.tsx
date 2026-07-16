import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  caption,
  className,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  /** A short muted line under the value/delta — e.g. "Top: Gold · moderate". No trend
   *  semantics (unlike `delta`); used for tiles that describe rather than compare. */
  caption?: string;
  /** Escape hatch for grid placement (e.g. `col-span-2` on an odd trailing tile) — kept
   *  separate from the card's own visual styling. */
  className?: string;
}) {
  // Compact on mobile (smaller value + padding, scaling back up from `sm`) so the report
  // pages can pack several tiles per row on a phone instead of each stretching full-width.
  return (
    <Card className={className}>
      <CardContent className="px-3.5 py-3.5 sm:px-[18px] sm:py-4">
        <p className="text-[11px] font-semibold text-text-2 sm:text-xs">{label}</p>
        <p className="tabular mt-1 text-[15px] font-extrabold sm:text-xl lg:text-[26px]">{value}</p>
        {delta && (
          <p
            className={cn(
              "tabular mt-0.5 text-[11px] font-bold sm:text-xs",
              deltaTone === "up" && "text-success",
              deltaTone === "down" && "text-destructive",
              deltaTone === "neutral" && "text-muted-foreground",
            )}
          >
            {delta}
          </p>
        )}
        {caption && <p className="mt-1 text-[11px] text-muted-foreground sm:text-xs">{caption}</p>}
      </CardContent>
    </Card>
  );
}
