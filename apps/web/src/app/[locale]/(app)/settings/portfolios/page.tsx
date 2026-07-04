import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { PortfoliosHoldersSection } from "@/components/settings-sections/portfolios-holders-section";
import { loadPortfolios, loadAccountHolders } from "@/lib/server-api";

export default async function SettingsPortfoliosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Settings");

  const [portfoliosResult, holders] = await Promise.all([
    loadPortfolios(),
    loadAccountHolders(),
  ]);

  return (
    <>
      <SectionHeader title={t("portfoliosLink")} backHref="/settings" />
      <PortfoliosHoldersSection
        portfolios={portfoliosResult.portfolios}
        holders={holders}
        locale={locale}
      />
    </>
  );
}
