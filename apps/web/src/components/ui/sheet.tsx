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
  handleOnly,
  open,
  onOpenChange,
  closeThreshold = 0.4,
  ...props
}: React.ComponentProps<typeof Drawer.Root> & {
  dismissible?: boolean;
  /** Restrict drag-to-close to the handle even while `dismissible` (#472 — a dismissible
   *  sheet whose content also scrolls otherwise treats any mid-content downward drag as a
   *  close gesture, since vaul gates on the content scroller's scrollTop staying at 0).
   *  Defaults to `!dismissible` (the original coupling) when not given explicitly. */
  handleOnly?: boolean;
}) {
  // Android hardware/gesture back closes the sheet instead of navigating the route.
  useBackToClose(open, onOpenChange);

  // Synchronize visual viewport height to prevent keyboard occlusion (#472 Item 4):
  // `--visual-viewport-height` already shrinks to exclude the OS keyboard's area, and
  // SheetContent's max-height is derived from it — so the sheet is already fully
  // contained above the keyboard. (A previous version of this fix ALSO reserved a
  // `scroll-padding-bottom` equal to the keyboard height on top of that — double-
  // counting the same space. With the container already this short, that padding
  // could consume nearly all of it, leaving `scrollIntoView`'s "center" math almost no
  // room to work with: it scrolled the focused field up underneath the sticky header
  // instead of centering it, making the sheet look completely blank. Removed —
  // `useFocusScroll`, below, is sufficient on its own now that the container is
  // correctly sized.)
  React.useEffect(() => {
    if (!open || typeof window === "undefined" || !window.visualViewport) return;

    const vv = window.visualViewport;
    const dh = document.documentElement;
    const updateViewport = () => {
      dh.style.setProperty("--visual-viewport-height", `${vv.height}px`);
    };

    updateViewport();
    vv.addEventListener("resize", updateViewport);
    vv.addEventListener("scroll", updateViewport);

    return () => {
      vv.removeEventListener("resize", updateViewport);
      vv.removeEventListener("scroll", updateViewport);
      dh.style.removeProperty("--visual-viewport-height");
    };
  }, [open]);

  return (
    <SheetDismissibleContext.Provider value={dismissible}>
      <Drawer.Root
        open={open}
        onOpenChange={onOpenChange}
        handleOnly={handleOnly ?? !dismissible}
        closeThreshold={closeThreshold}
        {...props}
        // vaul's own keyboard-avoidance (on by default): its `onVisualViewportChange`
        // writes a raw inline `style.height`/`style.bottom` directly onto Drawer.Content
        // whenever an input is focused, completely uncoordinated with our own
        // `--visual-viewport-height` + `useFocusScroll` mechanism above. Live-verified:
        // vaul never resets that inline height back to auto after the keyboard closes
        // or the active tab changes, leaving a stale fixed height that (a) blanks the
        // whole sheet the next time the keyboard opens, and (b) persists across tab
        // switches, showing scrollable empty space below shorter tabs' content. Disabled
        // — our own mechanism is the sole source of truth for keyboard avoidance.
        repositionInputs={false}
      />
    </SheetDismissibleContext.Provider>
  );
}

const SheetTrigger = Drawer.Trigger;
const SheetClose = Drawer.Close;

/** DOM node for a persistent, non-scrolling footer region rendered by `SheetContent`
 *  (side="bottom") — see `useSheetFooter`. `null` outside a Sheet (or for `side="full"`,
 *  which doesn't render one). */
const SheetFooterContext = React.createContext<HTMLDivElement | null>(null);

/** A form rendered inside a Sheet can portal its submit button into the sheet's
 *  persistent footer region instead of rendering `position: sticky` deep inside the
 *  scrollable content — see the comment on `SheetContent`'s footer div for why `sticky`
 *  doesn't reliably work there. Returns `null` outside a Sheet (e.g. the full
 *  `/transactions/new` page), so callers should fall back to their normal inline
 *  rendering in that case. */
export function useSheetFooter() {
  return React.useContext(SheetFooterContext);
}

function SheetOverlay({ className, ...props }: React.ComponentProps<typeof Drawer.Overlay>) {
  return (
    <Drawer.Overlay
      className={cn("fixed inset-0 z-50 bg-[rgba(17,33,26,.45)] backdrop-blur-[2px]", className)}
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
  // DOM node for the persistent footer region (side="bottom" only) — see
  // `useSheetFooter`. `useState`, not `useRef`: a ref's `.current` mutation doesn't
  // itself trigger a re-render, so context consumers (forms portaling their submit
  // button in) wouldn't learn the node exists until some unrelated re-render happened.
  const [footerEl, setFooterEl] = React.useState<HTMLDivElement | null>(null);

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
        style={{
          maxHeight:
            side === "bottom"
              ? "min(90dvh, calc(var(--visual-viewport-height, 100vh) * 0.9))"
              : undefined,
          ...props.style,
        }}
        className={cn(
          "fixed z-50 flex flex-col bg-background outline-none",
          // Centering uses margins, NOT -translate-x-1/2: vaul writes an inline `transform`
          // for the drag/slide and would clobber a Tailwind translateX on the same property.
          // NOTE: no `overflow-y-auto` here (unlike before) — see the inner scroll region
          // div below for why the handle, content, and footer are split into three flex
          // regions instead of one scrolling Drawer.Content.
          side === "bottom" &&
            "bottom-0 left-0 right-0 mx-auto max-h-[90dvh] w-full max-w-[520px] rounded-t-[28px] shadow-[0_-12px_44px_rgba(0,0,0,.22)]",
          side === "full" &&
            "bottom-0 left-0 right-0 mx-auto h-[100dvh] w-full max-w-none overflow-y-auto overscroll-contain rounded-none bg-card shadow-xl",
          className,
        )}
        {...props}
      >
        {side === "bottom" &&
          (dismissible ? (
            <Drawer.Handle className="!mx-auto !my-0 !h-auto !w-full !rounded-none !bg-transparent !border-none !outline-none !shadow-none py-4 flex items-center justify-center shrink-0 cursor-grab active:cursor-grabbing focus-visible:outline-none">
              <div className="h-1 w-10 rounded-full bg-border" />
            </Drawer.Handle>
          ) : (
            <div className="w-full py-4 flex items-center justify-center shrink-0" aria-hidden>
              <div className="h-1 w-10 rounded-full bg-border" />
            </div>
          ))}
        {side === "bottom" ? (
          <>
            {/* The sole scroll region. `min-h-0`, NOT `flex-1`: this lets the region (and
                so the whole sheet, via Drawer.Content's own shrink-to-fit flex-col layout)
                stay only as tall as its content up to the parent's max-height — `flex-1`
                would force it to always grow to fill that cap, leaving non-scrollable but
                still wasted blank space below short content. `min-h-0` overrides the
                default flex-item `min-height:auto`, which otherwise refuses to shrink below
                content size and defeats `overflow-y-auto` (the classic flexbox gotcha). */}
            <div
              className="min-h-0 overflow-y-auto overscroll-contain"
              style={{
                // Inline, not a `touch-pan-y` class: vaul injects its own `<style>` with
                // `[data-vaul-drawer] { touch-action: none }` at mount, targeting THIS
                // element's old role as Drawer.Content itself. Now that the scroll region
                // is a separate inner div, vaul's selector no longer matches it at all —
                // but keeping this explicit still reliably restricts panning to vertical
                // only, and no longer depends on winning any cascade tie (#472).
                touchAction: "pan-y",
              }}
            >
              <SheetFooterContext.Provider value={footerEl}>{children}</SheetFooterContext.Provider>
            </div>
            {/* Persistent, non-scrolling footer slot: forms with `stickyFooter` portal
                their submit button in here via `useSheetFooter` instead of `position:
                sticky` deep inside the scroll region above. Live-verified that `sticky`
                doesn't reliably work there: a sticky element's "stuck" range is bounded by
                its own containing block, and a footer nested inside `<form>` (itself
                several levels inside the old single scroll container) has essentially no
                room to operate — scrolling to the bottom of a long form made it detach and
                scroll away entirely instead of staying pinned (#472). Empty divs with no
                content render at zero height, so this is invisible when nothing portals in. */}
            <div ref={setFooterEl} className="shrink-0" />
          </>
        ) : (
          children
        )}
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
  return <div className={cn("flex flex-col gap-1.5 p-6 pb-0", className)} {...props} />;
}

function SheetTitle({ className, ...props }: React.ComponentProps<typeof Drawer.Title>) {
  return (
    <Drawer.Title className={cn("text-[19px] font-extrabold leading-none", className)} {...props} />
  );
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetHeader, SheetTitle };
