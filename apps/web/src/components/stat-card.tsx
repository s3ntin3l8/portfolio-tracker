import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
  caption,
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
  /** A short muted line under the value/delta — e.g. "Top: Gold · moderate". No trend
   *  semantics (unlike `delta`); used for tiles that describe rather than compare. */
  caption?: string;
}) {
  return (
    <Card>
      <CardContent className="px-[18px] py-4">
        <p className="text-xs font-semibold text-text-2">{label}</p>
        <p className="tabular mt-1 text-[22px] font-extrabold lg:text-[26px]">{value}</p>
        {delta && (
          <p
            className={cn(
              "tabular mt-0.5 text-xs font-bold",
              deltaTone === "up" && "text-success",
              deltaTone === "down" && "text-destructive",
              deltaTone === "neutral" && "text-muted-foreground",
            )}
          >
            {delta}
          </p>
        )}
        {caption && <p className="mt-1 text-xs text-muted-foreground">{caption}</p>}
      </CardContent>
    </Card>
  );
}
