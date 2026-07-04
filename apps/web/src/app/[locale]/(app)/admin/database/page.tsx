import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminStats } from "@/components/admin-stats";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminStats } from "@/lib/server-api";

export default async function AdminDatabasePage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminStats();

  return (
    <>
      <SectionHeader title={t("stats")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("statsHint")}</p>
      <Card>
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminStats stats={result.stats} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
