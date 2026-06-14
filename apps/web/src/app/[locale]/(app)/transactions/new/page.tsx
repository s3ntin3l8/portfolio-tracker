import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft, Wallet } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { AddTransaction } from "@/components/add-transaction";
import { CreatePortfolio } from "@/components/create-portfolio";
import { loadPortfolio } from "@/lib/server-api";

export default async function NewTransactionPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const tm = await getTranslations("Manage");
  const te = await getTranslations("Empty");

  const result = await loadPortfolio(async (_api, portfolio) => portfolio);

  const creatingPortfolio = result.status === "empty";
  const ns = creatingPortfolio ? "Manage.portfolio" : "Manage.tx";
  const t = await getTranslations(ns);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={tm("back")}>
          <Link href="/transactions">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">
            {creatingPortfolio ? tm("portfolio.needFirst") : t("subtitle")}
          </p>
        </div>
      </div>

      {result.status === "unavailable" ? (
        <EmptyState
          icon={Wallet}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      ) : result.status === "empty" ? (
        <CreatePortfolio />
      ) : (
        <AddTransaction portfolioId={result.portfolio.id} />
      )}
    </div>
  );
}
