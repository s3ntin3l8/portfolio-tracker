import { getTranslations, setRequestLocale } from "next-intl/server";
import { Briefcase, Pencil, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { TrSyncButton } from "@/components/tr-sync-button";
import { loadPortfolios, loadTrConnection } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";

export default async function PortfoliosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Portfolios");
  const tf = await getTranslations("PortfolioForm");
  const te = await getTranslations("Empty");
  const ttr = await getTranslations("TradeRepublic");

  const [result, connection] = await Promise.all([loadPortfolios(), loadTrConnection()]);

  // Determine which portfolio (if any) the TR connection is bound to.
  const trPortfolioId =
    connection !== null && connection.status !== "disconnected"
      ? connection.portfolioId
      : null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
          <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
        </div>
        {result.status !== "unavailable" && (
          <PortfolioFormDialog
            mode="create"
            trigger={
              <Button>
                <Plus className="size-4" />
                {tf("new")}
              </Button>
            }
          />
        )}
      </div>

      {result.status === "unavailable" ? (
        <EmptyState
          icon={Briefcase}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      ) : result.portfolios.length > 0 ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {result.portfolios.map(({ portfolio, netWorth }) => {
            const isTrBound = portfolio.id === trPortfolioId;
            const isTrConnected = isTrBound && connection?.status === "connected";
            return (
              <Card key={portfolio.id}>
                <CardContent className="p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <BrokerageIcon brokerage={portfolio.brokerage} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{portfolio.name}</p>
                        <p className="truncate text-xs text-muted-foreground">
                          {portfolio.baseCurrency}
                          {portfolio.brokerage && ` · ${portfolio.brokerage}`}
                          {portfolio.portfolioType === "child" &&
                            portfolio.birthYear !== null &&
                            ` · ${t("born", { year: String(portfolio.birthYear) })}`}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-1">
                      {isTrConnected && <TrSyncButton />}
                      <PortfolioFormDialog
                        mode="edit"
                        portfolio={portfolio}
                        trigger={
                          <Button size="icon" variant="ghost" aria-label={tf("edit")}>
                            <Pencil className="size-4" />
                          </Button>
                        }
                      />
                    </div>
                  </div>
                  {isTrBound && connection && (
                    <div className="mt-2">
                      <Badge variant="outline">
                        {ttr(`status.${connection.status}`)}
                      </Badge>
                    </div>
                  )}
                  <p className="tabular mt-3 text-xl font-semibold">
                    {formatMoney(Number(netWorth), portfolio.baseCurrency, locale)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("value")}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">{t("empty")}</p>
      )}
    </div>
  );
}
