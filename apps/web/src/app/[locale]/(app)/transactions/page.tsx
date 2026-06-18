import { getTranslations, setRequestLocale } from "next-intl/server";
import { Receipt, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import {
  TransactionsTable,
  type TxRow,
} from "@/components/transactions-table";
import { ExportCsvButton } from "@/components/export-csv-button";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { Link } from "@/i18n/navigation";
import {
  getSelectedPortfolioId,
  loadPortfolio,
  loadTransactionsAcrossPortfolios,
} from "@/lib/server-api";

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
  if (aggregate) {
    const result = await loadTransactionsAcrossPortfolios();
    status = result.status;
    rows = result.transactions;
  } else {
    const result = await loadPortfolio((api, portfolio) =>
      api.listTransactions(portfolio.id),
    );
    status = result.status;
    rows = result.status === "ok" ? result.data : [];
  }

  // Newest first.
  rows = [...rows].sort((a, b) => b.executedAt.localeCompare(a.executedAt));

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

  const addButton = (
    <div className="flex items-center gap-2">
      <ExportCsvButton
        filename="transactions.csv"
        headers={exportHeaders}
        rows={exportRows}
        label={t("exportCsv")}
      />
      <AddTransactionMenu />
    </div>
  );

  const heading = (action?: React.ReactNode) => (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {action}
    </div>
  );

  if (status === "unavailable") {
    return (
      <div className="space-y-6">
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
      <div className="space-y-6">
        {heading()}
        <EmptyState
          icon={Receipt}
          title={isEmptyPortfolio ? te("noPortfolioTitle") : te("noTransactionsTitle")}
          description={
            isEmptyPortfolio ? te("noPortfolioBody") : te("noTransactionsBody")
          }
          action={
            <Button asChild>
              <Link href="/transactions/new">
                <Plus className="size-4" />
                {isEmptyPortfolio ? tm("createPortfolio") : tm("addTransaction")}
              </Link>
            </Button>
          }
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {heading(addButton)}
      <TransactionsTable rows={rows} showPortfolio={aggregate} />
    </div>
  );
}
