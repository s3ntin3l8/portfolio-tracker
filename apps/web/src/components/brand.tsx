import { Wallet, Layers } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * The Pocket logo mark: a brand-green rounded square holding a white glyph. The design uses
 * two glyphs — `layers` for app chrome (sidebar/header) and `wallet` for auth/marketing
 * surfaces (login, error frames). Sizes 26/34/40 map to radius 8/11/13 in the design.
 */
export function PocketLogo({
  variant = "layers",
  className,
}: {
  variant?: "layers" | "wallet";
  className?: string;
}) {
  const Glyph = variant === "wallet" ? Wallet : Layers;
  return (
    <span
      className={cn(
        "flex size-8 items-center justify-center rounded-[11px] bg-primary text-primary-foreground",
        className,
      )}
    >
      <Glyph className="size-[18px]" strokeWidth={2} />
    </span>
  );
}

/** Logo mark + "Pocket" wordmark. */
export function Brand({
  variant = "layers",
  className,
}: {
  variant?: "layers" | "wallet";
  className?: string;
}) {
  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <PocketLogo variant={variant} />
      <span className="text-[17px] font-extrabold tracking-tight">Pocket</span>
    </div>
  );
}
