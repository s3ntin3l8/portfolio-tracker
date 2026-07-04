"use client";

import { ChevronRight } from "lucide-react";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";

export interface ShellNavItem {
  key: string;
  href: string;
  /** A rendered icon element (e.g. `<UserRound />`), not a component reference —
   *  these items cross a server/client boundary and bare component references
   *  aren't serializable across it. Sized via the wrapper spans below. */
  icon: React.ReactNode;
  title: string;
  /** Shown under the title in the mobile landing row; omitted on the desktop rail. */
  subtitle?: string;
  color: string;
  bg: string;
  /** Small uppercase pill next to the title (e.g. "ADMIN"). */
  badge?: string;
}

const CARD_SHADOW = "shadow-[0_1px_2px_rgba(15,27,20,.04),0_6px_16px_rgba(15,27,20,.05)]";

/**
 * Shared master-detail shell for `/settings/*` and `/admin/*`: a sticky left rail of
 * section links on desktop, beside a content pane; a grouped landing menu on mobile at
 * the tree's exact index route, which drills into `children` (the current route's own
 * page content) on any sub-route. Real Next.js routing throughout — no client-side
 * view-switching state — so this stays a thin nav wrapper around server-rendered pages.
 *
 * `groups` controls only the mobile landing's card grouping (each group renders as its
 * own bordered list); the desktop rail always renders every item as one flat list.
 */
export function SettingsShell({
  navItems,
  groups,
  indexHref,
  railTop,
  railBottom,
  landingTop,
  children,
}: {
  navItems: ShellNavItem[];
  /** Mobile landing grouping; defaults to a single group of all `navItems`. */
  groups?: ShellNavItem[][];
  indexHref: string;
  railTop?: React.ReactNode;
  railBottom?: React.ReactNode;
  landingTop?: React.ReactNode;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const isIndex = pathname === indexHref;
  const match = navItems.find((n) => pathname === n.href || pathname.startsWith(n.href + "/"));
  // Mirrors the design's `section || (isDesktop ? "account" : null)` default: at the bare
  // index route, the first nav item's content is what's actually being shown (see the
  // section's own page delegating to the same content component as its first sub-route).
  const activeKey = match?.key ?? (isIndex ? navItems[0]?.key : undefined);

  const landingGroups = groups ?? (navItems.length > 0 ? [navItems] : []);

  return (
    <div className="md:grid md:grid-cols-[270px_1fr] md:items-start md:gap-6">
      <div className="hidden md:sticky md:top-4 md:flex md:flex-col md:gap-3 md:self-start">
        {railTop}
        <nav className={cn("rounded-[18px] border border-border bg-card p-2", CARD_SHADOW)}>
          {navItems.map((item) => {
            const active = item.key === activeKey;
            return (
              <Link
                key={item.key}
                href={item.href}
                className={cn(
                  "my-0.5 flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-sm font-bold transition-colors",
                  active ? "bg-muted" : "hover:bg-muted/50",
                )}
              >
                <span
                  className="flex size-[30px] shrink-0 items-center justify-center rounded-[9px] [&>svg]:size-4"
                  style={{ background: item.bg, color: item.color }}
                >
                  {item.icon}
                </span>
                <span className="min-w-0 flex-1 truncate text-left">{item.title}</span>
                {item.badge && (
                  <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wide text-primary">
                    {item.badge}
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
        {railBottom}
      </div>

      <div className="min-w-0">
        {isIndex && (
          <div className="space-y-4 md:hidden">
            {landingTop}
            {landingGroups.map((group, i) => (
              <div
                key={i}
                className={cn("divide-y divide-border overflow-hidden rounded-[20px] border border-border bg-card", CARD_SHADOW)}
              >
                {group.map((item) => (
                  <Link
                    key={item.key}
                    href={item.href}
                    className="flex items-center gap-3 px-4 py-3.5 transition-colors hover:bg-muted/50"
                  >
                    <span
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl [&>svg]:size-[18px]"
                      style={{ background: item.bg, color: item.color }}
                    >
                      {item.icon}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5">
                        <span className="truncate text-sm font-bold">{item.title}</span>
                        {item.badge && (
                          <span className="shrink-0 rounded-md bg-primary/10 px-1.5 py-0.5 text-[9px] font-extrabold tracking-wide text-primary">
                            {item.badge}
                          </span>
                        )}
                      </div>
                      {item.subtitle && (
                        <div className="truncate text-xs text-muted-foreground">{item.subtitle}</div>
                      )}
                    </div>
                    <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                ))}
              </div>
            ))}
          </div>
        )}

        <div className={isIndex ? "hidden md:block" : ""}>{children}</div>
      </div>
    </div>
  );
}
