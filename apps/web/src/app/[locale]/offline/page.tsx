import { getTranslations, setRequestLocale } from "next-intl/server";
import { WifiOff } from "lucide-react";

// Served by the service worker as the navigation fallback when a route isn't cached and
// the network is unreachable (see `fallbacks` in src/app/sw.ts). Kept dependency-free so
// it renders without any network or API access.
export default async function OfflinePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Offline");

  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-secondary">
        <WifiOff className="size-7 text-muted-foreground" />
      </span>
      <h1 className="text-xl font-semibold tracking-tight">{t("title")}</h1>
      <p className="text-sm text-muted-foreground">{t("body")}</p>
    </div>
  );
}
