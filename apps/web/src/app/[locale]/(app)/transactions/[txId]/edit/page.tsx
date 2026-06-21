import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ArrowLeft, Wallet } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { EditTransaction } from "@/components/edit-transaction";
import { DownloadReceiptButton } from "@/components/download-receipt-button";
import { loadTransactionsAcrossPortfolios } from "@/lib/server-api";

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ locale: string; txId: string }>;
}) {
  const { locale, txId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Manage");
  const te = await getTranslations("Empty");

  // Resolve across all portfolios so an aggregate-view row edits regardless of scope.
  const result = await loadTransactionsAcrossPortfolios();

  const header = (title: string, subtitle: string) => (
    <div className="flex items-center gap-3">
      <Button variant="ghost" size="icon" asChild aria-label={t("back")}>
        <Link href="/transactions">
          <ArrowLeft className="size-4" />
        </Link>
      </Button>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        <p className="text-sm text-muted-foreground">{subtitle}</p>
      </div>
    </div>
  );

  if (result.status !== "ok") {
    return (
      <div className="space-y-6">
        {header(t("tx.editTitle"), t("tx.subtitle"))}
        <EmptyState
          icon={Wallet}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      </div>
    );
  }

  const tx = result.transactions.find((x) => x.id === txId);
  if (!tx) notFound();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        {header(t("tx.editTitle"), t("tx.subtitle"))}
        {tx.hasDocument && (
          <DownloadReceiptButton portfolioId={tx.portfolioId} txId={tx.id} />
        )}
      </div>
      <EditTransaction
        portfolioId={tx.portfolioId}
        txId={tx.id}
        initial={{
          type: tx.type,
          instrumentId: tx.instrumentId,
          instrument: tx.instrument,
          quantity: tx.quantity,
          price: tx.price,
          fees: tx.fees,
          tax: tx.tax,
          fxRate: tx.fxRate,
          description: tx.description,
          tags: tx.tags,
          currency: tx.currency,
          executedAt: tx.executedAt,
          sources: tx.sources,
          hasFullTaxDetail: tx.hasFullTaxDetail,
        }}
      />
    </div>
  );
}
