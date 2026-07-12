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
export function ThemeColorSync() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    if (resolvedTheme !== "light" && resolvedTheme !== "dark") return;
    const color = THEME_COLOR[resolvedTheme];
    document
      .querySelectorAll('meta[name="theme-color"]')
      .forEach((el) => el.setAttribute("content", color));
  }, [resolvedTheme]);

  return null;
}
