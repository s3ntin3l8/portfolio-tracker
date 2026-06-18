import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AdminProviders } from "@/components/admin-providers";
import { AdminVisionProviders } from "@/components/admin-vision-providers";
import { AdminStats } from "@/components/admin-stats";
import { AdminJobs } from "@/components/admin-jobs";
import { AdminMenu } from "@/components/admin-menu";
import {
  loadMe,
  loadAdminProviders,
  loadAdminVisionProviders,
  loadAdminStats,
  loadAdminJobs,
} from "@/lib/server-api";

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

  const [result, visionResult, statsResult, jobsResult] = await Promise.all([
    loadAdminProviders(),
    loadAdminVisionProviders(),
    loadAdminStats(),
    loadAdminJobs(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {/* Mobile — iOS-Settings grouped list (md:hidden) */}
      <div className="md:hidden">
        <AdminMenu />
      </div>

      {/* Desktop — full section cards stacked (hidden on mobile) */}
      <div className="hidden md:block space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("providers")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">{t("providersHint")}</p>
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

        <Card>
          <CardHeader>
            <CardTitle>{t("visionProviders")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">{t("visionProvidersHint")}</p>
            {visionResult.status === "ok" ? (
              <AdminVisionProviders
                initialProviders={visionResult.providers}
                encryptionEnabled={visionResult.encryptionEnabled}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("stats")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">{t("statsHint")}</p>
            {statsResult.status === "ok" ? (
              <AdminStats stats={statsResult.stats} />
            ) : (
              <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("jobs")}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="mb-4 text-sm text-muted-foreground">{t("jobsHint")}</p>
            {jobsResult.status === "ok" ? (
              <AdminJobs
                initialJobs={jobsResult.jobs}
                schedulerAvailable={jobsResult.schedulerAvailable}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
