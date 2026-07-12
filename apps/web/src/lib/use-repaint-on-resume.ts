"use client";

import { useEffect } from "react";

/**
 * Fixes #451: on Android, a `backdrop-filter` layer that survives the browser freezing a
 * backgrounded PWA can come back from "thaw" visually intact but with its hit-test region
 * never re-established by the compositor — taps land on the layer and do nothing. The
 * bottom nav (`bg-card/80 backdrop-blur-lg`) is the app's only interactive fixed element
 * using `backdrop-filter`, which matches the report exactly: nav fully visible, taps dead,
 * rest of the app fine.
 *
 * Forcing the browser to drop and recreate the backdrop-filter layer re-establishes hit
 * testing. We do that on every resume signal (`visibilitychange` → visible, and `pageshow`
 * for bfcache restores): clear `backdropFilter` + nudge a compositor property so the layer
 * is torn down, then restore it next frame so the recreated layer picks up hit testing
 * correctly. No-op during SSR / before the ref is attached.
 */
export function useRepaintOnResume(ref: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const repaint = () => {
      const el = ref.current;
      if (!el) return;

      const prevFilter = el.style.backdropFilter;
      const prevTransform = el.style.transform;

      el.style.backdropFilter = "none";
      el.style.transform = "translateZ(0)";

      requestAnimationFrame(() => {
        el.style.backdropFilter = prevFilter;
        el.style.transform = prevTransform;
      });
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") repaint();
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pageshow", repaint);

    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pageshow", repaint);
    };
  }, [ref]);
}
