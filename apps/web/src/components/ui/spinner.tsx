import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

const SIZES = {
  sm: "size-4",
  md: "size-5",
  lg: "size-7",
} as const;

/**
 * Shared spinner for button/data-loading busy states, matching the existing hand-written
 * `<Loader2 className="size-4 animate-spin" />` pattern used across the app. Use this for
 * new call sites — existing ones are left as-is (a mass migration of ~40 sites is out of
 * scope for this change).
 */
function Spinner({
  size = "md",
  className,
  ...props
}: React.ComponentProps<"svg"> & { size?: keyof typeof SIZES }) {
  return <Loader2 className={cn("animate-spin text-primary", SIZES[size], className)} {...props} />;
}

export { Spinner };
