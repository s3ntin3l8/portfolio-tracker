"use client";

import * as React from "react";
import { Drawer } from "vaul";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useBackToClose } from "@/lib/use-back-to-close";

/**
 * Bottom sheets are built on `vaul` (a Radix Dialog wrapper) so drag-to-close coexists
 * with `overflow-y-auto` content: vaul only starts a downward drag when the scroll
 * container is at the top, otherwise the gesture scrolls.
 *
 * NON-DISMISSIBLE sheets (`dismissible={false}`) deliberately do NOT use vaul's own
 * `dismissible` prop — its `Drawer.Root` guards `onOpenChange` with
 * `if (!dismissible && !open) return` *before* the caller's handler, which would also
 * swallow the X button and Escape. Instead: `handleOnly` on the Root (kills content-drag)
 * + a decorative pill instead of `Drawer.Handle` (so nothing initiates a drag) + blocking
 * overlay-click/blur close on the Radix layer via `onInteractOutside`/`onPointerDownOutside`
 * preventDefault. X, Escape and programmatic `onOpenChange(false)` all keep working.
 */
const SheetDismissibleContext = React.createContext(true);

function Sheet({
  dismissible = true,
  open,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof Drawer.Root> & { dismissible?: boolean }) {
  // Android hardware/gesture back closes the sheet instead of navigating the route.
  useBackToClose(open, onOpenChange);
  return (
    <SheetDismissibleContext.Provider value={dismissible}>
      <Drawer.Root
        open={open}
        onOpenChange={onOpenChange}
        handleOnly={!dismissible}
        {...props}
      />
    </SheetDismissibleContext.Provider>
  );
}

const SheetTrigger = Drawer.Trigger;
const SheetClose = Drawer.Close;

function SheetOverlay({
  className,
  ...props
}: React.ComponentProps<typeof Drawer.Overlay>) {
  return (
    <Drawer.Overlay
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
 * `side="full"` — best-effort full-height cover (for the review step). Currently unused
 * by any call site; kept functional, not dismissible-by-drag under vaul's transform model.
 */
function SheetContent({
  className,
  children,
  side = "bottom",
  hideClose = false,
  onInteractOutside,
  onPointerDownOutside,
  ...props
}: React.ComponentProps<typeof Drawer.Content> & {
  side?: "bottom" | "full";
  /** Suppress the built-in top-right close button — for sheets that render their own
   *  close inside a custom header (e.g. the transaction detail sheet's icon cluster). */
  hideClose?: boolean;
}) {
  const dismissible = React.useContext(SheetDismissibleContext);

  // When the Sheet opts out of dismissal, also block overlay-click / window-blur close on
  // Radix's DismissableLayer (vaul's own `dismissible` stays true so X/Escape still fire).
  // preventDefault on onInteractOutside covers both pointer-outside and focus-outside/blur.
  const handleInteractOutside: React.ComponentProps<typeof Drawer.Content>["onInteractOutside"] = (
    e,
  ) => {
    onInteractOutside?.(e);
    if (!dismissible) e.preventDefault();
  };
  const handlePointerDownOutside: React.ComponentProps<
    typeof Drawer.Content
  >["onPointerDownOutside"] = (e) => {
    onPointerDownOutside?.(e);
    if (!dismissible) e.preventDefault();
  };

  return (
    <Drawer.Portal>
      <SheetOverlay />
      <Drawer.Content
        onInteractOutside={handleInteractOutside}
        onPointerDownOutside={handlePointerDownOutside}
        className={cn(
          "fixed z-50 flex flex-col bg-background outline-none",
          // Centering uses margins, NOT -translate-x-1/2: vaul writes an inline `transform`
          // for the drag/slide and would clobber a Tailwind translateX on the same property.
          side === "bottom" &&
            "bottom-0 left-0 right-0 mx-auto max-h-[90dvh] w-full max-w-[520px] overflow-y-auto overscroll-contain rounded-t-[28px] shadow-[0_-12px_44px_rgba(0,0,0,.22)]",
          side === "full" &&
            "bottom-0 left-0 right-0 mx-auto h-[100dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-none bg-card shadow-xl",
          className,
        )}
        {...props}
      >
        {side === "bottom" &&
          (dismissible ? (
            // Real drag affordance. vaul injects `[data-vaul-handle]` default styles into
            // <head> at mount (same specificity, later in the cascade) — `!` wins the tie
            // to reproduce the original pill look.
            <Drawer.Handle className="!mx-auto !mt-3.5 !h-1 !w-10 !rounded-full !bg-border !opacity-100 shrink-0" />
          ) : (
            <div
              className="mx-auto mt-3.5 h-1 w-10 shrink-0 rounded-full bg-border"
              aria-hidden
            />
          ))}
        {children}
        {!hideClose && (
          <Drawer.Close
            className={cn(
              "absolute focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none",
              side === "bottom"
                ? "right-5 top-7 flex size-11 items-center justify-center rounded-[11px] bg-card text-foreground shadow-[0_1px_2px_rgba(15,27,20,.08)]"
                : "right-4 top-4 rounded-md opacity-70 transition-opacity hover:opacity-100",
            )}
          >
            <X className="size-[18px]" strokeWidth={2.2} />
            <span className="sr-only">Close</span>
          </Drawer.Close>
        )}
      </Drawer.Content>
    </Drawer.Portal>
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
}: React.ComponentProps<typeof Drawer.Title>) {
  return (
    <Drawer.Title
      className={cn("text-[19px] font-extrabold leading-none", className)}
      {...props}
    />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle };
