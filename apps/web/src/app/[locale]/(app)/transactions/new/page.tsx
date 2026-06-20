import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft, Plus, Wallet } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { NewEntryTabs, type NewEntryTab } from "@/components/new-entry-tabs";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { loadPortfolio } from "@/lib/server-api";

export default async function NewTransactionPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ kind?: string }>;
}) {
  const { locale } = await params;
  const { kind } = await searchParams;
  setRequestLocale(locale);
  const tm = await getTranslations("Manage");
  const tf = await getTranslations("PortfolioForm");
  const te = await getTranslations("Empty");

  const result = await loadPortfolio(async (_api, portfolio) => portfolio);

  const creatingPortfolio = result.status === "empty";
  const ns = creatingPortfolio ? "Manage.portfolio" : "Manage.tx";
  const t = await getTranslations(ns);
  const defaultTab: NewEntryTab =
    kind === "corporate-action" ? "corporate-action" : kind === "merger" ? "merger" : "transaction";
  // Neutral H1 so it reads correctly across both tabs (the empty/creating-portfolio
  // branches keep their own portfolio-specific title).
  const heading = creatingPortfolio ? t("title") : tm("tx.entryTitle");

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button variant="ghost" size="icon" asChild aria-label={tm("back")}>
          <Link href="/transactions">
            <ArrowLeft className="size-4" />
          </Link>
        </Button>
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{heading}</h1>
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
        <PortfolioFormDialog
          mode="create"
          trigger={
            <Button>
              <Plus className="size-4" />
              {tf("new")}
            </Button>
          }
        />
      ) : (
        <NewEntryTabs
          portfolioId={result.portfolio.id}
          defaultTab={defaultTab}
        />
      )}
    </div>
  );
}
