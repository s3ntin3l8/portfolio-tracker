import { cn } from "@/lib/utils";
import { Card, CardContent } from "@/components/ui/card";

export function StatCard({
  label,
  value,
  delta,
  deltaTone = "neutral",
}: {
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "up" | "down" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">{label}</p>
        <p className="tabular mt-2 text-2xl font-semibold">{value}</p>
        {delta && (
          <p
            className={cn(
              "tabular mt-1 text-sm",
              deltaTone === "up" && "text-success",
              deltaTone === "down" && "text-destructive",
              deltaTone === "neutral" && "text-muted-foreground",
            )}
          >
            {delta}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
