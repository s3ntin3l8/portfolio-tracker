import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { Card, CardContent } from "@/components/ui/card";
import { AdminUsersTable } from "@/components/admin-users-table";
import { SectionHeader } from "@/components/section-header";
import { loadMe, loadAdminUsers } from "@/lib/server-api";

export default async function AdminUsersPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Admin");

  const me = await loadMe();
  if (!me?.isAdmin) notFound();

  const result = await loadAdminUsers();

  return (
    <>
      <SectionHeader title={t("users")} backHref="/admin" />
      <p className="mb-4 text-sm text-muted-foreground">{t("usersHint")}</p>
      <Card>
        <CardContent className="p-5">
          {result.status === "ok" ? (
            <AdminUsersTable users={result.users} />
          ) : (
            <p className="text-sm text-muted-foreground">{t("unavailable")}</p>
          )}
        </CardContent>
      </Card>
    </>
  );
}
