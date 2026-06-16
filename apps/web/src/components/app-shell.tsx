"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  LayoutDashboard,
  Wallet,
  ArrowLeftRight,
  Coins,
  PiggyBank,
  ScanLine,
  Briefcase,
  Settings,
  Menu,
  X,
  LogOut,
} from "lucide-react";
import { signOut } from "next-auth/react";
import type { Portfolio } from "@portfolio/api-client";
import { Link, usePathname } from "@/i18n/navigation";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { ThemeToggle } from "@/components/theme-toggle";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { PortfolioSwitcher } from "@/components/portfolio-switcher";
import { InstallPrompt } from "@/components/install-prompt";

const NAV = [
  { href: "/dashboard", icon: LayoutDashboard, key: "dashboard" },
  { href: "/holdings", icon: Wallet, key: "holdings" },
  { href: "/transactions", icon: ArrowLeftRight, key: "transactions" },
  { href: "/income", icon: Coins, key: "income" },
  { href: "/savings", icon: PiggyBank, key: "savings" },
  { href: "/import", icon: ScanLine, key: "import" },
  { href: "/portfolios", icon: Briefcase, key: "portfolios" },
  { href: "/settings", icon: Settings, key: "settings" },
] as const;

export function AppShell({
  children,
  portfolios = [],
  selectedId = null,
}: {
  children: React.ReactNode;
  portfolios?: Pick<Portfolio, "id" | "name">[];
  selectedId?: string | null;
}) {
  const t = useTranslations("Nav");
  const pathname = usePathname();
  const [open, setOpen] = useState(false);

  const switcher = (
    <PortfolioSwitcher portfolios={portfolios} selectedId={selectedId} />
  );

  const signOutButton = (
    <button
      type="button"
      onClick={() => signOut({ callbackUrl: "/" })}
      className="flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground"
    >
      <LogOut className="size-4" />
      {t("signOut")}
    </button>
  );

  const navLinks = (
    <nav className="flex flex-col gap-1">
      {NAV.map(({ href, icon: Icon, key }) => {
        const active = pathname === href;
        return (
          <Link
            key={href}
            href={href}
            onClick={() => setOpen(false)}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-secondary text-foreground"
                : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
            )}
          >
            <Icon className="size-4" />
            {t(key)}
          </Link>
        );
      })}
    </nav>
  );

  return (
    <div className="flex min-h-dvh">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-card/40 p-4 pl-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] md:flex">
        <Brand />
        <div className="mt-4">{switcher}</div>
        <div className="mt-6">{navLinks}</div>
        <div className="mt-auto pt-4">{signOutButton}</div>
      </aside>

      {/* Mobile drawer */}
      {open && (
        <div className="fixed inset-0 z-40 md:hidden">
          <div
            className="absolute inset-0 bg-black/60"
            onClick={() => setOpen(false)}
          />
          <aside className="absolute left-0 top-0 flex h-full w-64 flex-col border-r border-border bg-card p-4 pl-[max(1rem,env(safe-area-inset-left))] pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center justify-between">
              <Brand />
              <Button variant="ghost" size="icon" aria-label="Close menu" onClick={() => setOpen(false)}>
                <X />
              </Button>
            </div>
            <div className="mt-4">{switcher}</div>
            <div className="mt-6">{navLinks}</div>
            <div className="mt-auto pt-4">{signOutButton}</div>
          </aside>
        </div>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex min-h-14 items-center gap-2 border-b border-border bg-background/80 pl-[max(1rem,env(safe-area-inset-left))] pr-[max(1rem,env(safe-area-inset-right))] pt-[env(safe-area-inset-top)] backdrop-blur">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            aria-label="Open menu"
            onClick={() => setOpen(true)}
          >
            <Menu />
          </Button>
          <div className="ml-auto flex items-center gap-1">
            <LocaleSwitcher />
            <ThemeToggle />
          </div>
        </header>
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-6 pb-[max(1.5rem,env(safe-area-inset-bottom))] sm:px-6">
          <InstallPrompt />
          {children}
        </main>
      </div>
    </div>
  );
}

function Brand() {
  return (
    <div className="flex items-center gap-2">
      <div className="flex size-7 items-center justify-center rounded-md bg-primary text-primary-foreground">
        <Wallet className="size-4" />
      </div>
      <span className="font-semibold tracking-tight">Portfolio</span>
    </div>
  );
}
