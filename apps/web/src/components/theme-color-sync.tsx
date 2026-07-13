"use client";

import { useEffect } from "react";
import { useTheme } from "next-themes";

// Keep in sync with globals.css `--background` (light/dark).
const THEME_COLOR = { light: "#f4f7f5", dark: "#0e1512" } as const;

/**
 * The static `<meta name="theme-color">` (set via Next's `viewport.themeColor` media
 * queries in layout.tsx) tracks the OS color scheme, not the in-app theme toggle. A user
 * who forces light mode in-app while their OS stays dark otherwise gets a mismatched
 * status-bar/address-bar tint. This overwrites the tag's `content` to follow the actually
 * *applied* theme instead, once resolved on the client.
 */
const STORAGE_KEY = "theme";

export function ThemeColorSync() {
  const { resolvedTheme, setTheme } = useTheme();

  useEffect(() => {
    // Auto-switch theme by device/OS preference on mobile if no manual theme preference has been saved.
    // Evaluated once on mount (first-load viewport width) to avoid switching on resize (Finding #1).
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    const hasUserTheme = typeof window !== "undefined" && window.localStorage.getItem(STORAGE_KEY) !== null;
    if (isMobile && !hasUserTheme) {
      setTheme("system");
    }
  }, [setTheme]);

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    const color = THEME_COLOR[resolvedTheme];
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((el) => el.setAttribute("content", color));
  }, [resolvedTheme]);

  return null;
}
