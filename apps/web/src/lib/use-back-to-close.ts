"use client";

import * as React from "react";

/**
 * Makes the Android hardware/gesture back button close an open sheet/dialog instead of
 * navigating the route — installed PWAs have no browser chrome to fall back on, so
 * without this, back on an open modal exits the app or changes the page underneath it.
 *
 * Pattern: push a same-URL history entry when the modal opens (a "marker"), so the very
 * next back-navigation lands on it and fires `popstate` instead of leaving the page. On
 * `popstate` we close the modal — the browser has already consumed the marker entry, so
 * we don't call history APIs again. If the modal is instead closed some other way (X,
 * Save, Escape, overlay tap), we pop our own marker via `history.back()` so the stack
 * doesn't accumulate stale entries and a later real back-press behaves normally.
 *
 * No-ops for uncontrolled usage (`open`/`onOpenChange` undefined) and during SSR.
 */
export function useBackToClose(
  open: boolean | undefined,
  onOpenChange: ((open: boolean) => void) | undefined,
) {
  const pushedRef = React.useRef(false);
  const onOpenChangeRef = React.useRef(onOpenChange);
  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange;
  }, [onOpenChange]);

  const enabled = onOpenChange !== undefined;

  // Push/pop the marker on the true open<->closed TRANSITION only — deliberately keyed
  // on `open`/`enabled` alone, never on the caller's `onOpenChange` identity. Most call
  // sites pass an inline callback that's a new reference on every render; keying on it
  // would re-run this effect (and push another marker) on every unrelated re-render
  // while the sheet just sits open, stacking history entries a single back-press can't
  // fully unwind.
  const wasOpenRef = React.useRef(open);
  React.useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = open;
    if (open && !wasOpen) {
      window.history.pushState({ ...window.history.state, backToCloseMarker: true }, "");
      pushedRef.current = true;
    } else if (!open && wasOpen && pushedRef.current) {
      pushedRef.current = false;
      window.history.back();
    }
  }, [open, enabled]);

  // Listen for hardware/gesture back while a marker is pending.
  React.useEffect(() => {
    if (typeof window === "undefined" || !enabled) return;
    function handlePopState() {
      if (pushedRef.current) {
        pushedRef.current = false;
        onOpenChangeRef.current?.(false);
      }
    }
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, [enabled]);
}
