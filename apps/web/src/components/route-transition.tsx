"use client";

import { usePathname } from "@/i18n/navigation";

/**
 * Re-keys its children by pathname so every route change replays the `fade-in` blend
 * (opacity + slight blur, see globals.css) instead of popping in. `<AppShell>` stays
 * mounted across navigations and only `<main>`'s children swap, so keying here is enough
 * to retrigger the animation without touching server-rendered content.
 */
export function RouteTransition({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  return (
    <div key={pathname} className="animate-fade-in">
      {children}
    </div>
  );
}
