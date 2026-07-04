import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { AccountSection } from "@/components/settings-sections/account-section";
import { loadMe } from "@/lib/server-api";

export default async function SettingsAccountPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");
  const me = await loadMe();

  return (
    <>
      <SectionHeader title={t("navAccount")} backHref="/settings" />
      <AccountSection me={me} />
    </>
  );
}
