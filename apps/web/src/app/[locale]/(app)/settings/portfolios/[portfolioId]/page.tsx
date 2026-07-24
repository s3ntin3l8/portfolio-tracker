import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { PortfolioEditForm } from "@/components/portfolio-edit-form";
import { loadPortfolioList } from "@/lib/server-api";

/**
 * The design's inline "Edit portfolio" page — tapping a portfolio card in Settings →
 * Portfolios & holders opens this (chevron affordance, whole-card click), replacing the
 * old `⋯` menu → edit Sheet flow.
 */
export default async function EditPortfolioPage({
  params,
}: {
  params: Promise<{ locale: string; portfolioId: string }>;
}) {
  const { locale, portfolioId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("PortfolioForm");

  const portfolios = await loadPortfolioList();
  const portfolio = portfolios.find((p) => p.id === portfolioId);
  if (!portfolio) notFound();

  return (
    <>
      <SectionHeader title={t("editTitle")} backHref="/settings/portfolios" />
      <PortfolioEditForm mode="edit" portfolio={portfolio} />
    </>
  );
}
