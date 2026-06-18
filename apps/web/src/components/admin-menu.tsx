import { getTranslations } from "next-intl/server";
import { ChevronRight } from "lucide-react";
import { Link } from "@/i18n/navigation";

const SECTIONS = [
  { key: "providers", titleKey: "providers", hintKey: "providersHint", href: "/admin/providers" },
  { key: "vision", titleKey: "visionProviders", hintKey: "visionProvidersHint", href: "/admin/vision" },
  { key: "database", titleKey: "stats", hintKey: "statsHint", href: "/admin/database" },
  { key: "jobs", titleKey: "jobs", hintKey: "jobsHint", href: "/admin/jobs" },
] as const;

/** iOS-Settings-style grouped list of admin sections. Shown on mobile only. */
export async function AdminMenu() {
  const t = await getTranslations("Admin");

  return (
    <div className="overflow-hidden rounded-xl border border-border bg-card divide-y divide-border">
      {SECTIONS.map(({ key, titleKey, hintKey, href }) => (
        <Link
          key={key}
          href={href}
          className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50"
        >
          <div className="min-w-0 flex-1">
            <div className="text-sm font-medium">{t(titleKey)}</div>
            <div className="truncate text-xs text-muted-foreground">{t(hintKey)}</div>
          </div>
          <ChevronRight className="size-4 shrink-0 text-muted-foreground" />
        </Link>
      ))}
    </div>
  );
}
