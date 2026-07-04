import { getTranslations } from "next-intl/server";
import { Compass } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";

/**
 * Not-found boundary for the authenticated app — catches notFound() from (app) pages
 * (e.g. an unknown transaction id). Rendered within (app)/layout + the [locale] intl
 * provider, so it keeps the shell and is fully localized. Unmatched URLs outside the app
 * fall through to the root [locale]/not-found.
 */
export default async function AppNotFound() {
  const t = await getTranslations("NotFound");

  return (
    <ErrorState
      icon={Compass}
      tone="brand"
      eyebrow="404"
      title={t("title")}
      body={t("body")}
      primary={
        <Button asChild>
          <Link href="/holdings">{t("backHome")}</Link>
        </Button>
      }
    />
  );
}
