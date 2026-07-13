"use client";

import { Suspense } from "react";
import { useTranslations } from "next-intl";
import type { Portfolio, AccountHolder } from "@portfolio/api-client";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { PortfolioSwitcher } from "@/components/portfolio-switcher";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { GlobalSearch } from "@/components/global-search";
import { InstallPrompt } from "@/components/install-prompt";
import { Brand } from "@/components/brand";
import { BottomNav } from "@/components/bottom-nav";
import { SignOutButton } from "@/components/sign-out-button";
import { AppVersion } from "@/components/app-version";
import { APP_VERSION } from "@/lib/version";
import { MAIN_NAV, ADMIN_NAV, navActiveKey } from "@/components/nav-items";
import { NavProgressProvider, LinkPendingSignal } from "@/components/nav-progress";
import { RouteTransition } from "@/components/route-transition";

export function AppShell({
  children,
  portfolios = [],
  holders = [],
  selectedId = null,
  selectedHolderId = null,
  isAdmin = false,
  anomalyCount = 0,
  anomalyError = false,
  netWorthSummary = null,
}: {
  children: React.ReactNode;
  portfolios?: Pick<Portfolio, "id" | "name" | "brokerage" | "accountHolder">[];
  holders?: Pick<AccountHolder, "id" | "name">[];
  selectedId?: string | null;
  selectedHolderId?: string | null;
  isAdmin?: boolean;
  anomalyCount?: number;
  anomalyError?: boolean;
  /** Sidebar footer summary (reference: always-visible, pinned bottom, above sign-out). */
  netWorthSummary?: { valueFormatted: string; allTimePctFormatted: string | null } | null;
}) {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const activeKey = navActiveKey(pathname);

  const navItems = isAdmin ? [...MAIN_NAV, ADMIN_NAV] : MAIN_NAV;

  // The portfolio switcher is meaningless on account-scoped screens (settings/admin/
  // portfolios all manage across portfolios), so hide it there.
  const hideSelector = ["/portfolios", "/settings", "/admin"].some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );

  // Suspense required: PortfolioSwitcher reads useSearchParams (for the transient
  // drill-in override on /holdings) and this shell renders on every route.
  const switcher = hideSelector ? null : (
    <Suspense fallback={null}>
      <PortfolioSwitcher
        portfolios={portfolios}
        holders={holders}
        selectedId={selectedId}
        selectedHolderId={selectedHolderId}
      />
    </Suspense>
  );

  return (
    <NavProgressProvider>
      <div className="flex h-dvh overflow-hidden">
        {/* Desktop sidebar — transcribed from the reference: 236px, 22/16 padding, nav
          items 600 14px text-mute (inactive) / 700 14px green on a green tint (active),
          12px radius, 19px icons, 3px gap. */}
        <aside className="hidden w-[236px] shrink-0 flex-col overflow-y-auto border-r border-border bg-card px-4 pb-[max(1rem,env(safe-area-inset-bottom))] pl-[max(1rem,env(safe-area-inset-left))] pt-[max(22px,env(safe-area-inset-top))] md:flex">
          <div className="px-2 pb-6">
            <Brand />
          </div>
          <nav className="flex flex-col gap-[3px]">
            {navItems.map(({ href, icon: Icon, key }) => {
              const active = key === activeKey;
              const badge = key === "activity" && anomalyCount > 0 ? anomalyCount : null;
              return (
                <Link
                  key={key}
                  href={href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-center gap-[11px] rounded-[12px] px-3 py-2.5 text-sm transition-colors",
                    active
                      ? "bg-[rgba(16,163,114,.14)] font-bold text-primary"
                      : "font-semibold text-text-mute hover:bg-secondary hover:text-foreground",
                  )}
                >
                  <LinkPendingSignal id={`sidebar-${key}`} />
                  <Icon className="size-[19px]" strokeWidth={active ? 2 : 1.8} />
                  <span className="flex-1">{t(key)}</span>
                  {badge != null && (
                    <span
                      className={cn(
                        "flex h-[19px] min-w-[19px] items-center justify-center rounded-full px-1.5 text-[11px] font-extrabold text-white",
                        anomalyError ? "bg-destructive" : "bg-[var(--gold-fg)]",
                      )}
                    >
                      {badge > 99 ? "99+" : badge}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto flex flex-col gap-3 pt-4">
            {netWorthSummary && (
              <div className="rounded-[14px] bg-background p-3.5">
                <p className="text-[11px] font-semibold text-text-2">{t("netWorth")}</p>
                <p className="tabular mt-0.5 text-lg font-extrabold">
                  {netWorthSummary.valueFormatted}
                </p>
                {netWorthSummary.allTimePctFormatted && (
                  <p className="tabular mt-0.5 text-xs font-bold text-success">
                    {netWorthSummary.allTimePctFormatted} {t("allTime")}
                  </p>
                )}
              </div>
            )}
            <SignOutButton />
            <AppVersion
              ariaLabel={t("version", { version: APP_VERSION })}
              className="block self-center text-[11px] text-text-3"
            />
          </div>
        </aside>

        {/* overscroll-contain: stop rubber-band/scroll-chaining to the page behind it —
            matters most in the installed PWA, which has no browser chrome to absorb it. */}
        <div className="flex min-w-0 flex-1 flex-col overflow-y-auto overscroll-contain">
          {/* Reference top bar: 62px, card surface, 24px side padding, 12px gaps.
            Padding lives on the INNER wrapper (not the outer bar) so its cap/center
            matches <main>'s content edges exactly — see the widescreen note on <main>.
            The outer bar stays edge-to-edge (bg-card, sticky, safe-area-top only) so it
            still reads as one continuous surface across the full width. */}
          <header className="sticky top-0 z-30 flex min-h-[62px] items-center border-b border-border bg-card pt-[env(safe-area-inset-top)]">
            <div className="mx-auto flex w-full max-w-[1600px] items-center gap-3 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] md:pl-6 md:pr-6">
              {/* Mobile brand (desktop shows it in the sidebar). */}
              <Link href="/holdings" className="md:hidden" aria-label="Pocket">
                <Brand />
              </Link>
              <div className="min-w-0">{switcher}</div>
              <div className="ml-auto flex items-center gap-1">
                <ThemeToggle className="hidden md:inline-flex" />
                <GlobalSearch holderId={selectedHolderId} />
                {/* Global add-entry affordance: reachable from every screen, owns the
                  share-target / shortcut auto-open. Suspense is required because
                  AddTransactionMenu reads useSearchParams and this shell renders on
                  every route (avoids a CSR-bailout de-opt). */}
                <Suspense fallback={null}>
                  <AddTransactionMenu autoOpenFromParams />
                </Suspense>
              </div>
            </div>
          </header>
          {/* Widescreen desktop (issue #462): the Pocket Prototype reference is a
            padding:24px scroll area with LEFT-ALIGNED max-width:1100px content — not a
            centered column. We intentionally deviate from that reference above typical
            laptop widths: content grows to a generous 1600px cap and centers within the
            space right of the sidebar (sidebar treated as chrome, not the viewport), so
            wide/ultrawide monitors don't leave a large blank right margin. `@container`
            lets page grids key density tiers off this real content width rather than
            viewport width, which is otherwise skewed by the 236px sidebar offset. */}
          <main className="@container mx-auto w-full max-w-[1600px] flex-1 px-4 pb-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] pt-4 sm:px-6 sm:pt-6 md:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
            <InstallPrompt />
            <RouteTransition>{children}</RouteTransition>
          </main>
        </div>

        <BottomNav anomalyCount={anomalyCount} anomalyError={anomalyError} />
      </div>
    </NavProgressProvider>
  );
}
