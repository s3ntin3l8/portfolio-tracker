"use client";

import { useEffect, type RefObject } from "react";

/**
 * When the OS keyboard opens inside a bottom sheet, the focused input can end up
 * behind the keyboard despite `scroll-padding-bottom` on the scroll host (iOS Safari
 * sometimes skips auto-scroll for `fixed`-positioned sheets). This hook explicitly
 * scrolls the focused element into view whenever focus changes within the container
 * (#472).
 */
export function useFocusScroll(containerRef: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (e: FocusEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && el.contains(target)) {
        target.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    };
    el.addEventListener("focusin", handler);
    return () => el.removeEventListener("focusin", handler);
  }, [containerRef]);
}
