import { getTranslations, setRequestLocale } from "next-intl/server";
import { WifiOff } from "lucide-react";
import { ErrorState } from "@/components/error-state";

// Served by the service worker as the navigation fallback when a route isn't cached and
// the network is unreachable (see `fallbacks` in src/app/sw.ts). Kept dependency-free so
// it renders without any network or API access.
export default async function OfflinePage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Offline");

  return (
    <ErrorState
      icon={WifiOff}
      tone="neutral"
      title={t("title")}
      body={t("body")}
      className="min-h-dvh"
    />
  );
}
