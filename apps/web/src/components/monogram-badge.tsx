import { cn } from "@/lib/utils";
import { monogram, tintFor, assetClassTone } from "@/lib/brokerages";

/**
 * Small monogram badge (2 letters) anchoring a list row to its instrument/source —
 * the reference uses these throughout (Holdings/Trades rows, Savings plan rows, Tax
 * harvest rows). When `assetClass` is known, matches the reference's soft rounded-square
 * chip tinted per asset class (`chipBg`/`chipFg` in `Pocket Prototype.dc.html`). Falls
 * back to a hash-derived solid rounded-square (any name → a stable, but class-agnostic,
 * hue) for contexts without a resolvable asset class (e.g. savings-plan rows). The app uses
 * rounded squares — never circles — for every avatar/monogram/icon tile.
 */
export function MonogramBadge({
  label,
  assetClass,
  className,
}: {
  label: string;
  assetClass?: string | null;
  className?: string;
}) {
  if (assetClass) {
    const tone = assetClassTone(assetClass);
    return (
      <span
        className={cn(
          // Reference chip: 38×38, border-radius 11px, font 800 12px.
          "inline-flex size-[38px] shrink-0 items-center justify-center rounded-[11px] text-xs font-extrabold",
          className,
        )}
        style={{ backgroundColor: tone.bg, color: tone.fg }}
        aria-hidden
      >
        {monogram(label)}
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex size-8 shrink-0 items-center justify-center rounded-[9px] text-[0.7rem] font-bold text-white",
        className,
      )}
      style={{ backgroundColor: tintFor(label) }}
      aria-hidden
    >
      {monogram(label)}
    </span>
  );
}
