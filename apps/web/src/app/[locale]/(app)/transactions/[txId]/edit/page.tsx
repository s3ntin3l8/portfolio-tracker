import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { ArrowLeft, Wallet } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { EditTransaction } from "@/components/edit-transaction";
import { loadPortfolio } from "@/lib/server-api";

export default async function EditTransactionPage({
  params,
}: {
  params: Promise<{ locale: string; txId: string }>;
}) {
  const { locale, txId } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Manage");
  const te = await getTranslations("Empty");

  const result = await loadPortfolio((api, portfolio) =>
    api.listTransactions(portfolio.id),
  );

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

  const tx = result.data.find((x) => x.id === txId);
  if (!tx) notFound();

  return (
    <div className="space-y-6">
      {header(t("tx.editTitle"), t("tx.subtitle"))}
      <EditTransaction
        portfolioId={result.portfolio.id}
        txId={tx.id}
        initial={{
          type: tx.type,
          instrumentId: tx.instrumentId,
          instrument: tx.instrument,
          quantity: tx.quantity,
          price: tx.price,
          fees: tx.fees,
          currency: tx.currency,
          executedAt: tx.executedAt,
        }}
      />
    </div>
  );
}
