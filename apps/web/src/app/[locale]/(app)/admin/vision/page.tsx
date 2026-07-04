import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminVisionProviders } from "@/components/admin-vision-providers";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminVisionProviders } from "@/lib/server-api";

export default async function AdminVisionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminVisionProviders();

  return (
    <>
      <SectionHeader title={t("visionProviders")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("visionProvidersHint")}</p>
      <Card>
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminVisionProviders
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
