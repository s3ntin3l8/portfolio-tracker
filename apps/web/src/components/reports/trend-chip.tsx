import { cn } from "@/lib/utils";

export type TrendTone = "up" | "down" | "neutral";

/**
 * Small colored pill used in the top-right of a {@link ReportCard} — e.g. "+18% vs 2025"
 * or "Due 31 Jul 2027". Purely presentational; callers pick the tone and label text.
 */
export function TrendChip({
  label,
  tone = "neutral",
  arrow = false,
}: {
  label: string;
  tone?: TrendTone;
  /** Show a leading up/down arrow glyph matching `tone` (only meaningful for up/down). */
  arrow?: boolean;
}) {
  const arrowGlyph = tone === "down" ? "▼" : "▲";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-[5px] whitespace-nowrap rounded-full px-[11px] py-[5px] text-xs font-bold",
        tone === "up" && "bg-success/15 text-success",
        tone === "down" && "bg-destructive/15 text-destructive",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {arrow && tone !== "neutral" && <span className="text-[9px]">{arrowGlyph}</span>}
      {label}
    </span>
  );
}
