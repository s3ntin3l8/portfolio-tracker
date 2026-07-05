import { getTranslations, setRequestLocale } from "next-intl/server";
import { UserRound, TrendingUp, Briefcase, KeyRound, ShieldCheck } from "lucide-react";
import { SettingsShell, type ShellNavItem } from "@/components/settings-shell";
import { SignOutButton } from "@/components/sign-out-button";
import { Link } from "@/i18n/navigation";
import { loadMe, loadPortfolios, loadAccountHolders } from "@/lib/server-api";

/**
 * Shared master-detail layout for every `/settings/*` route: a persistent desktop rail
 * (identity card + section nav + sign-out) beside the section's own content, or — at the
 * bare `/settings` index on mobile — a grouped landing menu instead. See
 * `SettingsShell` for the routing-based rail/landing mechanics shared with `/admin/*`.
 */
export default async function SettingsLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");

  const [me, portfoliosResult, holders] = await Promise.all([
    loadMe(),
    loadPortfolios(),
    loadAccountHolders(),
  ]);

  const navItems: ShellNavItem[] = [
    {
      key: "account",
      href: "/settings/account",
      icon: <UserRound />,
      title: t("navAccount"),
      subtitle: t("navAccountSub"),
      color: "#0E9F6E",
      bg: "rgba(16,163,114,.14)",
    },
    {
      key: "investing",
      href: "/settings/investing",
      icon: <TrendingUp />,
      title: t("navInvesting"),
      subtitle: t("navInvestingSub"),
      color: "#0D9488",
      bg: "rgba(13,148,136,.16)",
    },
    {
      key: "portfolios",
      href: "/settings/portfolios",
      icon: <Briefcase />,
      title: t("portfoliosLink"),
      subtitle: t("navPortfoliosCount", {
        portfolios: portfoliosResult.portfolios.length,
        holders: holders.length,
      }),
      color: "#7C5CFC",
      bg: "rgba(124,92,252,.16)",
    },
    {
      key: "data",
      href: "/settings/connections",
      icon: <KeyRound />,
      title: t("navData"),
      subtitle: t("navDataSub"),
      color: "var(--gold-fg)",
      bg: "rgba(224,165,58,.16)",
    },
  ];

  const groups = [[navItems[0], navItems[1]], [navItems[2], navItems[3]]];

  if (me?.isAdmin) {
    navItems.push({
      key: "admin",
      href: "/admin",
      icon: <ShieldCheck />,
      title: t("adminLink"),
      subtitle: t("adminDesc"),
      color: "#2A6FDB",
      bg: "rgba(42,111,219,.14)",
      badge: t("adminBadge"),
    });
    groups.push([navItems[navItems.length - 1]]);
  }

  const initials = (me?.name?.trim() || me?.email || "").slice(0, 2).toUpperCase() || "?";

  const identityCard = me && (
    <div className="flex items-center gap-3">
      <span className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-foreground text-sm font-bold text-background">
        {initials}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-extrabold">{me.name || me.email}</p>
        <p className="truncate text-xs text-muted-foreground">{me.email}</p>
      </div>
    </div>
  );

  return (
    <SettingsShell
      navItems={navItems}
      groups={groups}
      indexHref="/settings"
      railTop={
        identityCard && (
          <div className="rounded-[18px] border border-border bg-card p-3.5 shadow-card">
            {identityCard}
          </div>
        )
      }
      railBottom={<SignOutButton />}
      landingBottom={
        // Mobile has no desktop rail, so surface sign-out here — with the auth/identity
        // line directly above it (matches the desktop account section's footer note).
        <div className="space-y-2 pt-1">
          <p className="px-1 text-center text-xs text-muted-foreground">
            {t("authVia", { email: me?.email ?? "" })}
          </p>
          <SignOutButton />
        </div>
      }
      landingTop={
        identityCard && (
          <Link
            href="/settings/account"
            className="mb-4 flex items-center gap-3.5 rounded-[20px] border border-border bg-card p-4 shadow-card transition-colors hover:bg-muted/50"
          >
            {identityCard}
          </Link>
        )
      }
    >
      {children}
    </SettingsShell>
  );
}
