"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { MAIN_NAV, navActiveKey } from "@/components/nav-items";

/**
 * Mobile bottom tab bar — the five Pocket destinations. Frosted, safe-area aware. The
 * Activity tab carries a "needs review" anomaly badge (red for error-severity, gold
 * otherwise). Hidden at `md`+, where the sidebar takes over.
 */
export function BottomNav({
  anomalyCount = 0,
  anomalyError = false,
}: {
  anomalyCount?: number;
  anomalyError?: boolean;
}) {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const activeKey = navActiveKey(pathname);

  return (
    <nav
      aria-label="Primary"
      className="fixed inset-x-0 bottom-0 z-30 flex items-start justify-around border-t border-border bg-card/80 px-3 pt-2.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur-lg md:hidden"
    >
      {MAIN_NAV.map(({ href, icon: Icon, key }) => {
        const active = key === activeKey;
        const badge = key === "activity" && anomalyCount > 0 ? anomalyCount : null;
        return (
          <Link
            key={key}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex min-w-14 flex-col items-center gap-1 py-0.5 transition-colors",
              active ? "text-primary" : "text-muted-foreground",
            )}
          >
            <span className="relative flex">
              <Icon className="size-6" strokeWidth={active ? 2 : 1.8} />
              {badge != null && (
                <span
                  className={cn(
                    "absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-extrabold text-white ring-2 ring-card",
                    anomalyError ? "bg-destructive" : "bg-[var(--gold-fg)]",
                  )}
                >
                  {badge > 99 ? "99+" : badge}
                </span>
              )}
            </span>
            <span className={cn("text-[10px]", active ? "font-bold" : "font-semibold")}>
              {t(key)}
            </span>
          </Link>
        );
      })}
    </nav>
  );
}
