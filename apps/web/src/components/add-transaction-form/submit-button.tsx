"use client";

import { createPortal } from "react-dom";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface SubmitButtonProps {
  busy: boolean;
  isEdit: boolean;
  formId: string;
  stickyFooter: boolean;
  footerEl: HTMLElement | null;
  t: (key: string) => string;
  /** Desktop modal shell — compact button, no full-width/border-t wrapper (the desktop
   *  footer bar itself already supplies border-t/bg/padding/justify-end, alongside the
   *  Cancel button — see `add-transaction-menu/desktop-shell.tsx`). Defaults to the
   *  mobile-sheet styling. */
  isDesktop?: boolean;
}

export function SubmitButton({
  busy,
  isEdit,
  formId,
  stickyFooter,
  footerEl,
  t,
  isDesktop = false,
}: SubmitButtonProps) {
  const footerPortal = Boolean(stickyFooter && footerEl);

  const button = (
    <Button
      type="submit"
      form={formId}
      disabled={busy}
      className={
        isDesktop
          ? "h-auto rounded-[13px] px-[26px] py-[13px] text-[14px] font-bold"
          : "h-auto w-full rounded-[15px] py-[15px] text-[15px] font-bold"
      }
    >
      {busy && <Spinner size="sm" />}
      {busy ? t("submitting") : isEdit ? t("save") : t("submit")}
    </Button>
  );

  if (footerPortal && footerEl) {
    if (isDesktop) {
      // The desktop footer node already supplies border-t/bg/padding/justify-end layout —
      // portal just the bare button into it (the Cancel button sits alongside it there).
      return createPortal(button, footerEl);
    }
    return createPortal(
      <div className="border-t border-border bg-background px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {button}
      </div>,
      footerEl,
    );
  }

  return (
    <div
      className={cn(
        stickyFooter &&
          "sticky bottom-0 -mx-5 border-t border-border bg-background px-5 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] scroll-mb-24",
      )}
    >
      {button}
    </div>
  );
}
