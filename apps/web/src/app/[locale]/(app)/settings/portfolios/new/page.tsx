import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { PortfolioEditForm } from "@/components/portfolio-edit-form";

/**
 * The design's inline "New portfolio" page — tapping the dashed "New portfolio" tile in
 * Settings → Portfolios & holders opens this, replacing the old create-Sheet flow.
 */
export default async function NewPortfolioPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("PortfolioForm");

  return (
    <>
      <SectionHeader title={t("createTitle")} backHref="/settings/portfolios" />
      <PortfolioEditForm mode="create" />
    </>
  );
}
