"use client";

import { useEffect } from "react";
import { usePathname } from "@/i18n/navigation";

/**
 * Re-keys its children by pathname so every route change replays the `fade-in` blend
 * (opacity + slight blur, see globals.css) instead of popping in. `<AppShell>` stays
 * mounted across navigations and only `<main>`'s children swap, so keying here is enough
 * to retrigger the animation without touching server-rendered content.
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

  useEffect(() => {
    scrollContainerRef.current?.scrollTo(0, 0);
  }, [pathname, scrollContainerRef]);

  return (
    <div key={pathname} className="animate-fade-in">
      {children}
    </div>
  );
}
