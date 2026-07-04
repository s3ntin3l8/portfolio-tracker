import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminStorageForm } from "@/components/admin-storage-form";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminStorageProviders } from "@/lib/server-api";

export default async function AdminStoragePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminStorageProviders();

  return (
    <>
      <SectionHeader title={t("storage")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("storageHint")}</p>
      <Card>
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminStorageForm initial={result.storage} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
