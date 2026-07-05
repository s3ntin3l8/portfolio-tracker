import { getTranslations } from "next-intl/server";
import { Compass } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";

/**
 * Root not-found boundary — catches any unmatched URL under a valid locale prefix that
 * falls outside the (app) route group entirely (so (app)/not-found.tsx never mounts to
 * handle it). Without this file those URLs fell through to Next's unstyled default 404.
 * Rendered directly under the locale layout (fonts/theme/i18n, no app shell/sidebar),
 * so it's centered on a blank page rather than assuming a signed-in session.
 */
export default async function RootNotFound() {
  const t = await getTranslations("NotFound");

  return (
    <div className="flex min-h-dvh items-center justify-center">
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
    </div>
  );
}
