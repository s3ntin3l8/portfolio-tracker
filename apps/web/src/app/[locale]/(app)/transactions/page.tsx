import { getTranslations, setRequestLocale } from "next-intl/server";
import { Receipt, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import {
  TransactionsTable,
  type TxRow,
} from "@/components/transactions-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import { ExportDocumentsButton } from "@/components/export-documents-button";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { RecentImportsSection } from "@/components/recent-imports-section";
import { Link } from "@/i18n/navigation";
import {
  getSelectedPortfolioId,
  loadImports,
  loadPortfolio,
  loadPortfolioList,
  loadTransactionsAcrossPortfolios,
  loadAnomalies,
} from "@/lib/server-api";
import type { Anomaly } from "@portfolio/api-client";

export default async function TransactionsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Transactions");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");

  // Aggregate across all portfolios unless one is selected in the global switcher.
  const selectedId = await getSelectedPortfolioId();
  const aggregate = selectedId === null;

  let status: "ok" | "empty" | "unavailable";
  let rows: TxRow[] = [];
  let singlePortfolio: { id: string; name: string; documentRetention: boolean } | null = null;
  let anomalies: Anomaly[] | null = null;
  // "Scope currency" (#465): single portfolio → its baseCurrency; aggregate/holder → the
  // display-currency selector. Drives the Activity banners (which must include every
  // transaction, converted, rather than dropping non-dominant currencies) and the row
  // detail sheets' secondary converted amount.
  let scopeCurrency = "IDR";

  if (aggregate) {
    const result = await loadTransactionsAcrossPortfolios();
    status = result.status;
    rows = result.transactions;
    scopeCurrency = result.scopeCurrency;
  } else {
    const [txResult, anomalyResult] = await Promise.all([
      loadPortfolio((api, portfolio) => api.listTransactions(portfolio.id, portfolio.baseCurrency)),
      loadAnomalies(),
    ]);
    status = txResult.status;
    rows = txResult.status === "ok" ? txResult.data : [];
    anomalies = anomalyResult;
    if (txResult.status === "ok") {
      singlePortfolio = {
        id: txResult.portfolio.id,
        name: txResult.portfolio.name,
        documentRetention: txResult.portfolio.documentRetention,
      };
      scopeCurrency = txResult.portfolio.baseCurrency;
    }
  }

  // Newest first.
  rows = [...rows].sort((a, b) => b.executedAt.localeCompare(a.executedAt));

  // Import history is embedded here (the standalone /import route was retired). Shown as
  // a collapsed section whenever any imports exist — including for a portfolio that has
  // only pending drafts and no confirmed transactions yet.
  const imports = await loadImports();
  // The full portfolio list powers the "Reassign…" actions (move rows / a whole import to
  // another portfolio) in both the table and the import history.
  const portfolioList = await loadPortfolioList();
  const importsSection =
    imports.length > 0 ? (
      <RecentImportsSection items={imports} portfolios={portfolioList} />
    ) : null;

  // Plain-data CSV of the visible transactions (built client-side on click).
  const exportHeaders = [
    "Date",
    "Type",
    "Symbol",
    "Name",
    "Quantity",
    "Price",
    "Currency",
    "Source",
    ...(aggregate ? ["Portfolio"] : []),
  ];
  const exportRows: (string | number)[][] = rows.map((r) => [
    r.executedAt.slice(0, 10),
    r.type,
    r.instrument?.symbol ?? "",
    r.instrument?.name ?? "",
    r.quantity,
    r.price,
    r.currency,
    r.source,
    ...(aggregate ? [r.portfolioName ?? ""] : []),
  ]);

  // Adding is handled by the global add-entry menu in the app-shell header, so this page
  // header only carries the export actions (no redundant second Add button).
  const addButton = (
    <div className="flex items-center gap-2">
      <ExportCsvButton
        filename="transactions.csv"
        headers={exportHeaders}
        rows={exportRows}
        label={t("exportCsv")}
        iconOnly
      />
      {singlePortfolio?.documentRetention && (
        <ExportDocumentsButton
          portfolioId={singlePortfolio.id}
          portfolioName={singlePortfolio.name}
          label={t("exportDocuments")}
          iconOnly
        />
      )}
    </div>
  );

  // Title + (icon-only) actions share the top line; the subtitle spans the full width
  // below it — so on narrow screens the count isn't squeezed against the buttons.
  const heading = (action?: React.ReactNode) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {action}
      </div>
      <p className="text-sm font-medium text-text-2">
        {rows.length > 0 ? t("subtitleCount", { count: rows.length }) : t("subtitle")}
      </p>
    </div>
  );

  if (status === "unavailable") {
    return (
      <div className="space-y-5">
        {heading()}
        <EmptyState
          icon={Receipt}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      </div>
    );
  }

  if (rows.length === 0) {
    const isEmptyPortfolio = status === "empty";
    return (
      <div className="space-y-5">
        {heading()}
        <EmptyState
          icon={Receipt}
          title={isEmptyPortfolio ? te("noPortfolioTitle") : te("noTransactionsTitle")}
          description={
            isEmptyPortfolio ? te("noPortfolioBody") : te("noTransactionsBody")
          }
          action={
            isEmptyPortfolio ? (
              <Button asChild>
                <Link href="/transactions/new">
                  <Plus className="size-4" />
                  {tm("createPortfolio")}
                </Link>
              </Button>
            ) : (
              <AddTransactionMenu />
            )
          }
        />
        {importsSection}
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {heading(addButton)}
      <TransactionsTable
        rows={rows}
        showPortfolio={aggregate}
        anomalies={anomalies ?? []}
        portfolios={portfolioList}
        scopeCurrency={scopeCurrency}
      />
      {importsSection}
    </div>
  );
}
