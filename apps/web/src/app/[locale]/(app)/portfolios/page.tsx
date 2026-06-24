import { getTranslations, setRequestLocale } from "next-intl/server";
import { Briefcase, Coins, EyeOff, FolderCheck, Plus, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { PortfolioCardMenu } from "@/components/portfolio-card-menu";
import { PortfolioCardLink } from "@/components/portfolio-card-link";
import { AccountHoldersManager } from "@/components/account-holders-manager";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { loadAccountHolders, loadPortfolios, loadTrConnection, loadIbkrConnection } from "@/lib/server-api";
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
  const tibkr = await getTranslations("InteractiveBrokers");

  const [result, connection, ibkrConn, holders] = await Promise.all([
    loadPortfolios(),
    loadTrConnection(),
    loadIbkrConnection(),
    loadAccountHolders(),
  ]);

  // Determine which portfolio (if any) the TR connection is bound to.
  const trPortfolioId =
    connection !== null && connection.status !== "disconnected"
      ? connection.portfolioId
      : null;

  // Determine which portfolio (if any) the IBKR connection is bound to.
  const ibkrPortfolioId =
    ibkrConn !== null && ibkrConn.status !== "disconnected"
      ? ibkrConn.portfolioId
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
            const isIbkrBound = portfolio.id === ibkrPortfolioId;
            const isIbkrConnected = isIbkrBound && ibkrConn?.status === "connected";
            return (
              <Card key={portfolio.id} className="relative flex flex-col transition-colors hover:bg-accent/50">
                {/* Overlay button — sets the pf cookie and navigates to /holdings */}
                <PortfolioCardLink portfolioId={portfolio.id} name={portfolio.name} />
                <CardContent className="flex flex-1 flex-col p-5">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-2.5">
                      <BrokerageIcon brokerage={portfolio.brokerage} />
                      <div className="min-w-0">
                        <p className="truncate font-medium">{portfolio.name}</p>
                        {portfolio.accountHolder && (
                          <p className="truncate text-xs text-muted-foreground">
                            {portfolio.accountHolder}
                          </p>
                        )}
                      </div>
                    </div>
                    {/* Interactive controls — z-20 to sit above the overlay link */}
                    <div className="relative z-20 flex shrink-0 items-center gap-1">
                      <PortfolioCardMenu
                        portfolio={portfolio}
                        trSync={isTrConnected ? { initialSyncing: connection?.syncing ?? false } : undefined}
                        ibkrSync={isIbkrConnected ? { initialSyncing: ibkrConn?.syncing ?? false } : undefined}
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
                  {isIbkrBound && ibkrConn && (
                    <div className="mt-2">
                      <Badge variant="outline">
                        {tibkr(`status.${ibkrConn.status}`)}
                      </Badge>
                    </div>
                  )}
                  <p className="tabular mt-3 text-xl font-semibold">
                    {formatMoney(Number(netWorth), portfolio.baseCurrency, locale)}
                  </p>
                  <p className="text-xs text-muted-foreground">{t("value")}</p>
                  {/* Footer flag strip — only rendered when at least one non-default flag is set */}
                  {(portfolio.cashCounted ||
                    portfolio.documentRetention ||
                    portfolio.taxAllowanceAnnual != null ||
                    !portfolio.includeInAggregate) && (
                    <div className="mt-auto flex flex-wrap gap-x-3 gap-y-1 border-t pt-3">
                      {portfolio.cashCounted && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <Coins className="size-3.5 shrink-0" />
                          {t("cashIn")}
                        </span>
                      )}
                      {portfolio.documentRetention && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <FolderCheck className="size-3.5 shrink-0" />
                          {t("docsKept")}
                        </span>
                      )}
                      {portfolio.taxAllowanceAnnual != null && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <ShieldCheck className="size-3.5 shrink-0" />
                          {`FSA €${Math.round(Number(portfolio.taxAllowanceAnnual))}`}
                        </span>
                      )}
                      {!portfolio.includeInAggregate && (
                        <span className="flex items-center gap-1 text-xs text-muted-foreground">
                          <EyeOff className="size-3.5 shrink-0" />
                          {t("excluded")}
                        </span>
                      )}
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      ) : (
        <EmptyState
          icon={Briefcase}
          title={te("noPortfolioTitle")}
          description={te("noPortfolioBody")}
          action={
            <PortfolioFormDialog
              mode="create"
              trigger={
                <Button>
                  <Plus className="size-4" />
                  {tf("new")}
                </Button>
              }
            />
          }
        />
      )}

      {result.status !== "unavailable" && <AccountHoldersManager holders={holders} />}
    </div>
  );
}
