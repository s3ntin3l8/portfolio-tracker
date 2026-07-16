import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminJobs } from "@/components/admin-jobs";
import { UnmappedTypesAlert } from "@/components/unmapped-types-alert";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminJobs, loadUnmappedEventTypes } from "@/lib/server-api";

export default async function AdminJobsPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const [result, unmappedTypes] = await Promise.all([loadAdminJobs(), loadUnmappedEventTypes()]);

  return (
    <>
      <SectionHeader title={t("jobs")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("jobsHint")}</p>

      <UnmappedTypesAlert types={unmappedTypes} />

      <Card className="mt-4">
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminJobs initialJobs={result.jobs} schedulerAvailable={result.schedulerAvailable} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
