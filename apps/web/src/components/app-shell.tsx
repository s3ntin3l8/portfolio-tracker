"use client";

import { Suspense } from "react";
import { useTranslations } from "next-intl";
import { LogOut } from "lucide-react";
import { signOut } from "next-auth/react";
import type { Portfolio, AccountHolder } from "@portfolio/api-client";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PortfolioSwitcher } from "@/components/portfolio-switcher";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { GlobalSearch } from "@/components/global-search";
import { InstallPrompt } from "@/components/install-prompt";
import { Brand } from "@/components/brand";
import { BottomNav } from "@/components/bottom-nav";
import { MAIN_NAV, ADMIN_NAV, navActiveKey } from "@/components/nav-items";

export function AppShell({
  children,
  portfolios = [],
  holders = [],
  selectedId = null,
  selectedHolderId = null,
  isAdmin = false,
  anomalyCount = 0,
  anomalyError = false,
}: {
  children: React.ReactNode;
  portfolios?: Pick<Portfolio, "id" | "name" | "brokerage" | "accountHolder">[];
  holders?: Pick<AccountHolder, "id" | "name">[];
  selectedId?: string | null;
  selectedHolderId?: string | null;
  isAdmin?: boolean;
  anomalyCount?: number;
  anomalyError?: boolean;
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

  const signOutButton = (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/" })}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground"
    >
      <LogOut className="size-4" />
      {t("signOut")}
    </button>
  );

  return (
    <div className="flex h-dvh overflow-hidden">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-card p-4 pl-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] md:flex">
        <div className="px-1 pb-4">
          <Brand />
        </div>
        <nav className="flex flex-col gap-1">
          {navItems.map(({ href, icon: Icon, key }) => {
            const active = key === activeKey;
            const badge =
              key === "activity" && anomalyCount > 0 ? anomalyCount : null;
            return (
              <Link
                key={key}
                href={href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition-colors",
                  active
                    ? "bg-primary/10 font-semibold text-primary"
                    : "font-medium text-muted-foreground hover:bg-secondary hover:text-foreground",
                )}
              >
                <Icon className="size-[18px]" strokeWidth={active ? 2 : 1.8} />
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
        <div className="mt-auto pt-4">{signOutButton}</div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border bg-background/80 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur">
          {/* Mobile brand (desktop shows it in the sidebar). */}
          <Link href="/holdings" className="md:hidden" aria-label="Pocket">
            <Brand />
          </Link>
          <div className="min-w-0">{switcher}</div>
          <div className="ml-auto flex items-center gap-1">
            <GlobalSearch holderId={selectedHolderId} />
            {/* Global add-entry affordance: reachable from every screen, owns the
                share-target / shortcut auto-open. Suspense is required because
                AddTransactionMenu reads useSearchParams and this shell renders on
                every route (avoids a CSR-bailout de-opt). */}
            <Suspense fallback={null}>
              <AddTransactionMenu autoOpenFromParams />
            </Suspense>
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-[max(6rem,calc(env(safe-area-inset-bottom)+5rem))] sm:px-6 md:pb-[max(1.5rem,env(safe-area-inset-bottom))]">
          <InstallPrompt />
          {children}
        </main>
      </div>

      <BottomNav anomalyCount={anomalyCount} anomalyError={anomalyError} />
    </div>
  );
}
