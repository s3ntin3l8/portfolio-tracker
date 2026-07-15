import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { InstallAppSection } from "@/components/settings-sections/install-app-section";

export default async function InstallAppSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");

  return (
    <>
      <SectionHeader title={t("navInstall")} backHref="/settings" />
      <InstallAppSection />
    </>
  );
}
