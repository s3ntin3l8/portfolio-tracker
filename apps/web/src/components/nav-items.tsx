import { Layers, List, FileText, LineChart, User, ShieldCheck } from "lucide-react";
import type { LucideIcon } from "lucide-react";

/**
 * The Pocket 5-tab information architecture. These five destinations are the whole app:
 * leaf screens (income, tax, savings, trades, instruments, portfolios, admin) live under
 * one of them and highlight that tab (see {@link navActiveKey}).
 *
 *  - Holdings  (/holdings)      — net worth, allocation, positions (merges the old dashboard)
 *  - Activity  (/transactions)  — the transaction ledger + imports
 *  - Reports   (/reports)       — Income · Realized P&L · Savings · Tax hub
 *  - Insights  (/insights)      — XIRR, rebalancing, concentration
 *  - Profile   (/settings)      — account, portfolios, holders, admin
 */
export type NavItem = { href: string; icon: LucideIcon; key: string };

export const MAIN_NAV: readonly NavItem[] = [
  { href: "/holdings", icon: Layers, key: "holdings" },
  { href: "/transactions", icon: List, key: "activity" },
  { href: "/reports", icon: FileText, key: "reports" },
  { href: "/insights", icon: LineChart, key: "insights" },
  { href: "/settings", icon: User, key: "profile" },
] as const;

export const ADMIN_NAV: NavItem = {
  href: "/admin",
  icon: ShieldCheck,
  key: "admin",
};

/**
 * Resolve which of the five tabs owns a given pathname (locale prefix already stripped by
 * next-intl's usePathname). Leaf routes map back onto their parent tab so the nav stays
 * highlighted while you drill in — mirrors the design's `navParent` map.
 */
export function navActiveKey(pathname: string): string {
  const p = pathname;
  const under = (base: string) => p === base || p.startsWith(base + "/");

  if (under("/holdings") || under("/dashboard") || under("/instruments")) return "holdings";
  if (under("/transactions")) return "activity";
  if (
    under("/reports") ||
    under("/income") ||
    under("/tax") ||
    under("/savings") ||
    under("/trades")
  )
    return "reports";
  if (under("/insights")) return "insights";
  if (under("/settings") || under("/portfolios") || under("/admin")) return "profile";
  return "holdings";
}
