import * as React from "react";
import { cn } from "@/lib/utils";

/** Placeholder block with a shimmer sweep (see `animate-shimmer` in globals.css) instead
 * of a flat pulse — reads as "content is on its way" rather than a static gray box. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div className={cn("relative overflow-hidden rounded-md bg-muted", className)} {...props}>
      <div
        aria-hidden
        className="absolute inset-0 animate-shimmer bg-[length:200%_100%] bg-gradient-to-r from-transparent via-foreground/10 to-transparent"
      />
    </div>
  );
}

export { Skeleton };
