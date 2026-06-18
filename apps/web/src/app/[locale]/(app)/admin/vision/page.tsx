import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { ChevronLeft } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminVisionProviders } from "@/components/admin-vision-providers";
import { Link } from "@/i18n/navigation";
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
    <div className="space-y-4">
      <Link
        href="/admin"
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
      >
        <ChevronLeft className="size-4" />
        {t("title")}
      </Link>

      <Card>
        <CardHeader>
          <CardTitle>{t("visionProviders")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">{t("visionProvidersHint")}</p>
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
    </div>
  );
}
