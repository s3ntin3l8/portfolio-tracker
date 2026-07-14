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
  loadPortfolioList,
  loadTransactionsAcrossPortfolios,
  loadNetworthTransactionsPaginated,
  loadTransactionsPaginated,
  loadAnomalies,
  loadMe,
} from "@/lib/server-api";
import type { Anomaly } from "@portfolio/api-client";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";
const PAGE_SIZE = 25;

export default async function TransactionsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ page?: string; type?: string; year?: string; q?: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Transactions");
  const te = await getTranslations("Empty");
  const tm = await getTranslations("Manage");

  // Aggregate across all portfolios unless one is selected in the global switcher.
  const selectedId = await getSelectedPortfolioId();
  const aggregate = selectedId === null;
  const sp = await searchParams;
  const page = Math.max(1, Number(sp?.page ?? "1"));
  const typeFilter = (sp?.type as string) ?? undefined;
  const yearFilter = (sp?.year as string) ?? undefined;
  const searchQuery = (sp?.q as string) ?? undefined;

  // Fire ALL API calls immediately — no serial dependency on portfolios.
  const importsPromise = loadImports();
  const portfolioListPromise = loadPortfolioList();

  let status: "ok" | "empty" | "unavailable";
  let rows: TxRow[] = [];
  let total = 0;
  let txSummary: { totalInvested: string; totalProceeds: string; totalIncome: string } | null = null;
  let txYears: string[] = [];
  let singlePortfolio: { id: string; name: string; documentRetention: boolean } | null = null;
  let anomalies: Anomaly[] | null = null;
  let scopeCurrency = "IDR";

  if (aggregate) {
    const result = await loadNetworthTransactionsPaginated(page, PAGE_SIZE, typeFilter, yearFilter, searchQuery);
    status = result.status;
    rows = result.rows;
    total = result.total;
    const me = await loadMe();
    scopeCurrency = me?.displayCurrency ?? "IDR";
  } else {
    const [txResult, anomalyResult] = await Promise.all([
      loadTransactionsPaginated(selectedId!, page, PAGE_SIZE, undefined, typeFilter, yearFilter, searchQuery),
      loadAnomalies(),
    ]);
    status = txResult.status;
    if (txResult.status === "ok") {
      rows = txResult.rows;
      total = txResult.total;
      txSummary = txResult.summary ?? null;
      txYears = txResult.years ?? [];
    }
    anomalies = anomalyResult;
  }

  // Newest first (already ordered by the backend for paginated queries).
  rows = [...rows].sort((a, b) => b.executedAt.localeCompare(a.executedAt));

  // Portfolio metadata from the parallel-fetched list.
  const portfolioList = await portfolioListPromise;
  if (!aggregate && portfolioList.length > 0) {
    const selected = portfolioList.find((p) => p.id === selectedId) ?? portfolioList[0];
    singlePortfolio = {
      id: selected.id,
      name: selected.name,
      documentRetention: selected.documentRetention,
    };
    scopeCurrency = selected.baseCurrency;
  }

  // Import history is embedded here (the standalone /import route was retired). Shown as
  // a collapsed section whenever any imports exist — including for a portfolio that has
  // only pending drafts and no confirmed transactions yet.
  const imports = await importsPromise;

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] TransactionsPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
        aggregate,
        page,
        transactionCount: rows.length,
        total,
      }),
    );
  }

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
  const displayCount = aggregate ? rows.length : total;
  const heading = (action?: React.ReactNode) => (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{t("title")}</h1>
        {action}
      </div>
      <p className="text-sm font-medium text-text-2">
        {displayCount > 0 ? t("subtitleCount", { count: displayCount }) : t("subtitle")}
      </p>
    </div>
  );

  // No page-number navigation — replaced with a "Load more" button inside the table
  // component that fetches the next server page and appends progressively.

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
    const hasActiveFilter = typeFilter || yearFilter || searchQuery;
    // When a filter/search is active, fall through to the table — it shows its own
    // "No transactions match your search" message with the filter controls still visible.
    if (!hasActiveFilter) {
      return (
        <div className="space-y-5">
          {heading()}
          <EmptyState
            icon={Receipt}
            title={te("noTransactionsTitle")}
            description={te("noTransactionsBody")}
            action={<AddTransactionMenu />}
          />
          {importsSection}
        </div>
      );
    }
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
        summary={txSummary}
        years={txYears}
        typeFilter={typeFilter}
        yearFilter={yearFilter}
        searchQuery={searchQuery}
        portfolioId={singlePortfolio?.id ?? undefined}
        total={total}
      />
      {importsSection}
    </div>
  );
}
