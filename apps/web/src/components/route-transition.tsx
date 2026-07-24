"use client";

import { useEffect, useState } from "react";
import { usePathname } from "@/i18n/navigation";

/** Routes intercepted into the `@modal` slot (`app/[locale]/(app)/@modal/(.)settings`,
 *  `(.)admin`) — soft-navigating into one of these only swaps the modal overlay; the page
 *  underneath (this component's `children`) doesn't actually change. `pathname` here has
 *  already had its locale prefix stripped (next-intl's `usePathname`). */
function isModalRoute(pathname: string): boolean {
  return (
    pathname === "/settings" ||
    pathname.startsWith("/settings/") ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/")
  );
}

/**
 * Re-keys its children by pathname so every route change replays the `fade-in` blend
 * (opacity + slight blur, see globals.css) instead of popping in. `<AppShell>` stays
 * mounted across navigations and only `<main>`'s children swap, so keying here is enough
 * to retrigger the animation without touching server-rendered content.
 *
 * The key freezes at the last non-modal pathname while a `/settings*`/`/admin*` overlay is
 * open. Route interception (see `@modal/`) only swaps the `@modal` slot — this component's
 * `children` prop is still whatever page was showing before the overlay opened. Re-keying
 * on the raw pathname anyway would remount that unchanged page for every settings/admin
 * sub-navigation, replaying its fade-in and resetting any client-side state on it — which
 * reads as the current page "reloading" right as the overlay appears, on both mobile and
 * desktop (it's a pathname effect, not viewport-specific).
 */
export function RouteTransition({
  children,
  scrollContainerRef,
}: {
  children: React.ReactNode;
  /**
   * AppShell's scrollable div — a custom element, not `window`/`document`, so
   * Next's built-in scroll-restoration doesn't reach it (#584). Reset it to the
   * top on every route change so navigating in doesn't leave the new page's
   * header scrolled out of view.
   */
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const pathname = usePathname();

  // "Adjusting state when a prop changes" (react.dev) — comparing against a stored previous
  // pathname and conditionally updating state during render, not a ref mutation, so this
  // stays compiler/lint-safe. `transitionKey` only advances when the new pathname isn't a
  // modal route; entering/leaving/staying within `/settings*`/`/admin*` all leave it as-is.
  const [prevPathname, setPrevPathname] = useState(pathname);
  const [transitionKey, setTransitionKey] = useState(pathname);
  if (pathname !== prevPathname) {
    setPrevPathname(pathname);
    if (!isModalRoute(pathname)) setTransitionKey(pathname);
  }

  useEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
  }, [transitionKey, scrollContainerRef]);

  return (
    <div key={transitionKey} className="animate-fade-in">
      {children}
    </div>
  );
}
