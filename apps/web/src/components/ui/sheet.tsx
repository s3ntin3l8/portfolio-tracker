"use client";

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

const Sheet = DialogPrimitive.Root;
const SheetTrigger = DialogPrimitive.Trigger;
const SheetClose = DialogPrimitive.Close;

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      className={cn(
        "fixed inset-0 z-50 bg-[rgba(17,33,26,.45)] backdrop-blur-[2px]",
        className,
      )}
      {...props}
    />
  );
}

/**
 * `side="bottom"` (default) — the reference's bottom sheet (`Pocket Prototype.dc.html`
 * ADD/IMPORT + detail modals): centered, max-width 520px, page-bg surface, 28px top
 * radius, drag handle, 34px card-bg close button.
 * `side="full"` — covers the full viewport (for the review step).
 */
function SheetContent({
  className,
  children,
  side = "bottom",
  hideClose = false,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  side?: "bottom" | "full";
  /** Suppress the built-in top-right close button — for sheets that render their own
   *  close inside a custom header (e.g. the transaction detail sheet's icon cluster). */
  hideClose?: boolean;
}) {
  return (
    <DialogPrimitive.Portal>
      <SheetOverlay />
      <DialogPrimitive.Content
        className={cn(
          "fixed z-50 flex flex-col",
          side === "bottom" &&
            "bottom-0 left-1/2 max-h-[90dvh] w-full max-w-[520px] -translate-x-1/2 overflow-y-auto rounded-t-[28px] bg-background shadow-[0_-12px_44px_rgba(0,0,0,.22)]",
          side === "full" && "inset-0 overflow-y-auto bg-card shadow-xl",
          className,
        )}
        {...props}
      >
        {side === "bottom" && (
          <div className="mx-auto mt-3.5 h-1 w-10 shrink-0 rounded-full bg-border" aria-hidden />
        )}
        {children}
        {!hideClose && (
          <DialogPrimitive.Close
            className={cn(
              "absolute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
              side === "bottom"
                ? "right-5 top-7 flex size-[34px] items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)]"
                : "right-4 top-4 rounded-md opacity-70 transition-opacity hover:opacity-100",
            )}
          >
            <X className="size-[18px]" strokeWidth={2.2} />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

function SheetHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      className={cn("flex flex-col gap-1.5 p-6 pb-0", className)}
      {...props}
    />
  );
}

function SheetTitle({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      className={cn("text-[19px] font-extrabold leading-none", className)}
      {...props}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle };
