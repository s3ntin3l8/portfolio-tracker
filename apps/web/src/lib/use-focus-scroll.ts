"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * When the OS keyboard opens inside a bottom sheet, the focused input can end up
 * behind the keyboard despite `scroll-padding-bottom` on the scroll host (iOS Safari
 * sometimes skips auto-scroll for `fixed`-positioned sheets). This hook explicitly
 * scrolls the focused element into view whenever focus changes within the container
 * (#472).
 *
 * `focusin` fires *before* the keyboard opens, while the sheet is still at its
 * pre-keyboard height (`--visual-viewport-height` in `ui/sheet.tsx` hasn't shrunk yet) —
 * so "center" is computed against the wrong geometry. Once the keyboard finishes opening,
 * the sheet shrinks and any sticky/portaled footer settles into its final position, which
 * can leave the already-centered field behind it. Re-running `scrollIntoView` on the
 * tracked focused element when `visualViewport` resizes corrects for that race.
 */
export function useFocusScroll(containerRef: RefObject<HTMLElement | null>) {
  const focusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const scrollIntoView = (target: HTMLElement) =>
      target.scrollIntoView({ block: "center", behavior: "smooth" });

    const handleFocusIn = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && el.contains(target)) {
        focusedRef.current = target;
        scrollIntoView(target);
      }
    };
    const handleFocusOut = (e: FocusEvent) => {
      if (e.target === focusedRef.current) focusedRef.current = null;
    };
    const handleViewportResize = () => {
      const target = focusedRef.current;
      if (target && document.activeElement === target) scrollIntoView(target);
    };

    el.addEventListener("focusin", handleFocusIn);
    el.addEventListener("focusout", handleFocusOut);
    window.visualViewport?.addEventListener("resize", handleViewportResize);
    return () => {
      el.removeEventListener("focusin", handleFocusIn);
      el.removeEventListener("focusout", handleFocusOut);
      window.visualViewport?.removeEventListener("resize", handleViewportResize);
    };
  }, [containerRef]);
}
