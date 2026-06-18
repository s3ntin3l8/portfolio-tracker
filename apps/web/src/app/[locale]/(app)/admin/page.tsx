import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminProviders } from "@/components/admin-providers";
import { loadMe, loadAdminProviders } from "@/lib/server-api";

export default async function AdminPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  // Server-side admin gate (the API also enforces it on every /admin request).
  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminProviders();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("providers")}</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="mb-4 text-sm text-muted-foreground">
            {t("providersHint")}
          </p>
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
    </div>
  );
}
