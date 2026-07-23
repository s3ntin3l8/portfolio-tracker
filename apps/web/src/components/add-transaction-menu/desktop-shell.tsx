"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { SheetFooterContext } from "@/components/ui/sheet";
import { NavRail } from "./nav-rail";

export type DesktopStep = "import" | "manual" | "events" | "portfolio" | "holder";

/**
 * The ≥860px replacement for the mobile bottom Sheet — a centered modal with a 196px
 * left destination rail instead of the mobile chooser screen + back button. Every step's
 * content (manual form, events, portfolio/holder create, import) is the SAME shared step
 * component mobile uses; this only supplies the desktop chrome around it — see
 * `add-transaction-menu.tsx`, which owns the actual step state and renders each step's
 * content as `children`.
 *
 * Submit buttons inside `children` keep using `useSheetFooter()` unchanged: this shell
 * provides that same `SheetFooterContext` with its own footer node (see `footerEl` below),
 * so every step's existing footer-portal logic (mobile *and* desktop-aware styling) just
 * works here too — see `SheetFooterContext`'s doc comment in `ui/sheet.tsx`.
 */
export function DesktopShell({
  open,
  onOpenChange,
  step,
  onSelectStep,
  headerTitle,
  centered,
  dismissible = true,
  showFooter = true,
  onCancel,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  step: DesktopStep;
  onSelectStep: (step: DesktopStep) => void;
  headerTitle: string;
  /** Only the manual (Add transaction) step uses the two-column form+Summary-rail grid —
   *  every other step (events/portfolio/holder/import) gets the mockup's centered,
   *  max-width-600px single-column treatment instead. */
  centered: boolean;
  /** Blocks Esc/overlay-click dismissal — mirrors the mobile sheet's guard against an
   *  accidental close mid-import (`step !== "import"` in `add-transaction-menu.tsx`). Also
   *  hides the shared Cancel button (see `showFooter`) so it can't bypass the guard. */
  dismissible?: boolean;
  /** The shared Cancel+submit-portal footer bar is only for the manual/events/portfolio/
   *  holder steps — the import step has its own step-local action buttons (upload/parsing/
   *  review, unchanged from mobile) and never portals into `useSheetFooter()`, so this is
   *  `false` for it (mirrors the mockup's `isImport` split — the shared footer markup lives
   *  outside the import step's own block there). */
  showFooter?: boolean;
  onCancel: () => void;
  children: React.ReactNode;
}) {
  const tm = useTranslations("Manage");
  const [footerEl, setFooterEl] = useState<HTMLDivElement | null>(null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        hideClose
        onEscapeKeyDown={(e) => {
          if (!dismissible) e.preventDefault();
        }}
        onInteractOutside={(e) => {
          if (!dismissible) e.preventDefault();
        }}
        className="flex w-[calc(100%-4rem)] max-w-[1120px] flex-row gap-0 overflow-hidden rounded-[22px] border-0 bg-background p-0 shadow-[0_30px_80px_rgba(0,0,0,.4)] max-h-[calc(100vh-64px)]"
      >
        <NavRail
          active={step}
          onSelect={onSelectStep}
          labels={{
            heading: tm("addMenu.desktopHeading"),
            import: tm("addMenu.railImport"),
            manual: tm("addMenu.railAddTransaction"),
            events: tm("addMenu.railInstrumentEvent"),
            portfolio: tm("addMenu.railCreatePortfolio"),
            holder: tm("addMenu.railAccountHolder"),
          }}
        />

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          <div className="sticky top-0 z-[2] border-b border-border bg-background px-[26px] py-[18px]">
            <DialogTitle className="text-[19px] font-extrabold leading-none text-foreground">
              {headerTitle}
            </DialogTitle>
          </div>

          <SheetFooterContext.Provider value={footerEl}>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className={centered ? "mx-auto max-w-[600px] px-[26px] py-5" : "px-[26px] py-5"}>
                {children}
              </div>
            </div>

            {showFooter && (
              <div className="flex shrink-0 items-center justify-end gap-3 border-t border-border bg-background px-[26px] py-4">
                {dismissible && (
                  <Button
                    type="button"
                    variant="outline"
                    onClick={onCancel}
                    className="h-auto rounded-[13px] border-border bg-card px-[22px] py-[13px] text-[14px] font-bold text-foreground hover:bg-card"
                  >
                    {tm("addMenu.cancel")}
                  </Button>
                )}
                {/* `display:contents` so the portaled submit button (via `useSheetFooter`)
                    lands as a flex sibling of Cancel above, in DOM order — not visually
                    nested inside this otherwise-empty div. */}
                <div ref={setFooterEl} className="contents" />
              </div>
            )}
          </SheetFooterContext.Provider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
