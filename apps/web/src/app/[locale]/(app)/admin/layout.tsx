import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  LineChart,
  Eye,
  ArrowDownUp,
  HardDrive,
  Database,
  Clock,
  Users,
  ChevronLeft,
} from "lucide-react";
import { SettingsShell, type ShellNavItem } from "@/components/settings-shell";
import { Link } from "@/i18n/navigation";
import { loadMe } from "@/lib/server-api";

/**
 * Shared master-detail layout for every `/admin/*` route — the same `SettingsShell`
 * pattern as `/settings/*`. Desktop rail links to the 6 real admin sub-routes with a
 * "‹ Profile" exit above the list; mobile shows the grouped landing menu at the bare
 * `/admin` index, or the section's own content (with its own `SectionHeader` back-link)
 * on any sub-route. The admin gate lives here (DRY) — each sub-page also re-checks
 * `me.isAdmin` itself as a belt-and-suspenders guard, matching the existing convention.
 */
export default async function AdminLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const navItems: ShellNavItem[] = [
    {
      key: "providers",
      href: "/admin/providers",
      icon: <LineChart />,
      title: t("providers"),
      subtitle: t("providersHint"),
      color: "#0E9F6E",
      bg: "rgba(16,163,114,.14)",
    },
    {
      key: "vision",
      href: "/admin/vision",
      icon: <Eye />,
      title: t("visionProviders"),
      subtitle: t("visionProvidersHint"),
      color: "#7C5CFC",
      bg: "rgba(124,92,252,.16)",
    },
    {
      key: "imports",
      href: "/admin/imports",
      icon: <ArrowDownUp />,
      title: t("importStrategy"),
      subtitle: t("importStrategyHint"),
      color: "#0D9488",
      bg: "rgba(13,148,136,.16)",
    },
    {
      key: "storage",
      href: "/admin/storage",
      icon: <HardDrive />,
      title: t("storage"),
      subtitle: t("storageHint"),
      color: "#2A6FDB",
      bg: "rgba(42,111,219,.14)",
    },
    {
      key: "database",
      href: "/admin/database",
      icon: <Database />,
      title: t("stats"),
      subtitle: t("statsHint"),
      color: "var(--gold-fg)",
      bg: "rgba(224,165,58,.16)",
    },
    {
      key: "users",
      href: "/admin/users",
      icon: <Users />,
      title: t("users"),
      subtitle: t("usersHint"),
      color: "#F59E0B",
      bg: "rgba(245,158,11,.15)",
    },
    {
      key: "jobs",
      href: "/admin/jobs",
      icon: <Clock />,
      title: t("jobs"),
      subtitle: t("jobsHint"),
      color: "#E5484D",
      bg: "rgba(229,72,77,.12)",
    },
  ];

  return (
    <SettingsShell
      navItems={navItems}
      indexHref="/admin"
      railTop={
        <Link
          href="/settings"
          className="flex items-center gap-2 rounded-[18px] border border-border bg-card px-3 py-2.5 text-xs font-bold text-muted-foreground shadow-card transition-colors hover:text-foreground"
        >
          <ChevronLeft className="size-[15px]" />
          {t("title")}
        </Link>
      }
      landingTop={
        <div className="mb-4 flex items-center gap-3">
          <Link
            href="/settings"
            aria-label="Back"
            className="flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm"
          >
            <ChevronLeft className="size-[18px]" />
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-xl font-extrabold tracking-tight">{t("title")}</h1>
            <p className="truncate text-xs text-muted-foreground">{t("subtitle")}</p>
          </div>
        </div>
      }
    >
      {children}
    </SettingsShell>
  );
}
