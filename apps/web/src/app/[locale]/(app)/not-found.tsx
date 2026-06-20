import { getTranslations } from "next-intl/server";
import { SearchX } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";

/**
 * Not-found boundary for the authenticated app — catches notFound() from (app) pages
 * (e.g. an unknown transaction id). Rendered within (app)/layout + the [locale] intl
 * provider, so it keeps the shell and is fully localized. Unmatched URLs outside the app
 * fall through to Next's default not-found.
 */
export default async function AppNotFound() {
  const t = await getTranslations("NotFound");

  return (
    <EmptyState
      icon={SearchX}
      title={t("title")}
      description={t("body")}
      action={
        <Button asChild>
          <Link href="/dashboard">{t("backHome")}</Link>
        </Button>
      }
    />
  );
}
