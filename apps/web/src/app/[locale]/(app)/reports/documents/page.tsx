import { getTranslations, setRequestLocale } from "next-intl/server";
import { ReportHeader } from "@/components/report-header";
import { TaxReportsInbox } from "@/components/tax-reports-inbox";
import { loadDocuments, resolveSelection } from "@/lib/server-api";

export default async function TaxReportsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("TaxReports");

  const [documents, selection] = await Promise.all([
    loadDocuments("tax_report"),
    resolveSelection(),
  ]);
  // Uploads require a real portfolioId (routes/documents.ts) — default to the
  // switcher-selected portfolio, or the first one in the aggregate ("All portfolios")
  // scope, exactly like transactions/new/page.tsx's NewEntryTabs wiring.
  const portfolios =
    selection.status === "ok"
      ? selection.portfolios.map((p) => ({
          id: p.id,
          name: p.name,
          brokerage: p.brokerage,
          accountHolder: p.accountHolder,
        }))
      : [];
  const initialPortfolioId =
    selection.status === "ok" && selection.portfolios.length > 0
      ? (selection.selectedId ?? selection.portfolios[0].id)
      : "";

  return (
    <div className="space-y-6">
      <ReportHeader title={t("title")} subtitle={t("headerSubtitle")} />
      <TaxReportsInbox
        initialDocuments={documents}
        portfolios={portfolios}
        initialPortfolioId={initialPortfolioId}
      />
    </div>
  );
}
