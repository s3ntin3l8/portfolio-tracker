import { notFound } from "next/navigation";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { SectionHeader } from "@/components/section-header";
import { HolderEditForm } from "@/components/holder-edit-form";
import { loadAccountHolders } from "@/lib/server-api";

/**
 * The design's inline "Edit account holder" page — tapping a holder row in Settings →
 * Portfolios & holders opens this (chevron affordance, whole-row click), replacing the
 * old `⋯` menu → edit Sheet flow.
 */
export default async function EditHolderPage({
  params,
}: {
  params: Promise<{ locale: string; holderId: string }>;
}) {
  const { locale, holderId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("AccountHolders");

  const holders = await loadAccountHolders();
  const holder = holders.find((h) => h.id === holderId);
  if (!holder) notFound();

  return (
    <>
      <SectionHeader title={t("editTitle")} backHref="/settings/portfolios" />
      <HolderEditForm mode="edit" holder={holder} />
    </>
  );
}
