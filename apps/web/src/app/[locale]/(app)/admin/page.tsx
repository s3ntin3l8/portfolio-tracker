import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminProviders } from "@/components/admin-providers";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminProviders } from "@/lib/server-api";

/**
 * `/admin` index. On mobile the shared `SettingsShell` shows the grouped landing menu
 * here instead of this content; on desktop this is the rail's default section (mirrors
 * the design's `view = state.view || "providers"`) — identical content to
 * `/admin/providers`, the mobile drill-in route for the same section.
 */
export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminProviders();

  return (
    <>
      <SectionHeader title={t("providers")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("providersHint")}</p>
      <Card>
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminProviders
              initialProviders={result.providers}
              encryptionEnabled={result.encryptionEnabled}
            />
          ) : (
            <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
