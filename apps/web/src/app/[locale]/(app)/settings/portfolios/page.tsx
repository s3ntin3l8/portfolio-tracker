import { getTranslations, setRequestLocale } from "next-intl/server";
import { Briefcase, Plus } from "lucide-react";
import { SectionHeader } from "@/components/section-header";
import { Card, CardContent } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { Button } from "@/components/ui/button";
import { PortfolioCardLink, PortfolioCardChevron } from "@/components/portfolio-card-link";
import { PortfolioSyncWatcher } from "@/components/portfolio-sync-watcher";
import { AccountHoldersManager } from "@/components/account-holders-manager";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { Link } from "@/i18n/navigation";
import {
  loadAccountHolders,
  loadPortfolios,
  loadTrConnection,
  loadIbkrConnection,
} from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";

/**
 * The Settings "Portfolios & holders" section: the full portfolio manager (create / edit /
 * delete cards + the account-holders manager) rendered inline within the settings shell —
 * no read-only intermediate, no "Manage ›" hop. Reached from the settings rail/landing.
 */
export default async function SettingsPortfoliosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Portfolios");
  const tf = await getTranslations("PortfolioForm");
  const te = await getTranslations("Empty");
  const ts = await getTranslations("Settings");
  const ttr = await getTranslations("TradeRepublic");
  const tibkr = await getTranslations("InteractiveBrokers");

  const [result, connection, ibkrConn, holders] = await Promise.all([
    loadPortfolios(),
    loadTrConnection(),
    loadIbkrConnection(),
    loadAccountHolders(),
  ]);

  const trPortfolioId =
    connection !== null && connection.status !== "disconnected" ? connection.portfolioId : null;
  const ibkrPortfolioId =
    ibkrConn !== null && ibkrConn.status !== "disconnected" ? ibkrConn.portfolioId : null;

  return (
    <>
      <SectionHeader title={ts("portfoliosLink")} backHref="/settings" />

      <div className="space-y-6">
        {result.status === "unavailable" ? (
          <EmptyState
            icon={Briefcase}
            title={te("unavailableTitle")}
            description={te("unavailableBody")}
          />
        ) : result.portfolios.length > 0 ? (
          <div className="grid gap-3.5 sm:grid-cols-2 lg:grid-cols-3">
            {result.portfolios.map(({ portfolio, netWorth }) => {
              const isTrBound = portfolio.id === trPortfolioId;
              const isTrConnected = isTrBound && connection?.status === "connected";
              const isIbkrBound = portfolio.id === ibkrPortfolioId;
              const isIbkrConnected = isIbkrBound && ibkrConn?.status === "connected";
              const isSyncing =
                (isTrBound && connection?.syncing) || (isIbkrBound && ibkrConn?.syncing);
              const statusLabel = isTrBound
                ? connection && ttr(`status.${connection.status}`)
                : isIbkrBound
                  ? ibkrConn && tibkr(`status.${ibkrConn.status}`)
                  : null;

              const flags: string[] = [];
              if (portfolio.cashCounted) flags.push(t("cashIn"));
              if (portfolio.documentRetention) flags.push(t("docsKept"));
              if (portfolio.taxAllowanceAnnual != null) {
                flags.push(`FSA €${Math.round(Number(portfolio.taxAllowanceAnnual))}`);
              }
              if (!portfolio.includeInAggregate) flags.push(t("excluded"));

              return (
                <Card
                  key={portfolio.id}
                  className="relative flex flex-col rounded-[18px] border-border shadow-card transition-colors hover:bg-accent/50"
                >
                  {/* Overlay link — the whole card opens the inline edit page (design:
                      chevron affordance, no `⋯` menu). */}
                  <PortfolioCardLink portfolioId={portfolio.id} name={portfolio.name} />
                  {/* Headless — keeps the SYNCING…/CONNECTED badge below auto-updating; the
                      manual "Sync now" trigger now lives on the edit page instead. */}
                  <PortfolioSyncWatcher
                    trSync={
                      isTrConnected ? { initialSyncing: connection?.syncing ?? false } : undefined
                    }
                    ibkrSync={
                      isIbkrConnected ? { initialSyncing: ibkrConn?.syncing ?? false } : undefined
                    }
                  />
                  <CardContent className="flex flex-1 flex-col p-[17px]">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex min-w-0 items-center gap-2.5">
                        <BrokerageIcon brokerage={portfolio.brokerage} />
                        <div className="min-w-0">
                          <p className="truncate text-[15px] font-bold">{portfolio.name}</p>
                          {portfolio.accountHolder && (
                            <p className="truncate text-xs text-muted-foreground">
                              {portfolio.accountHolder}
                            </p>
                          )}
                        </div>
                      </div>
                      <PortfolioCardChevron />
                    </div>
                    {statusLabel && (
                      <div className="mt-2.5">
                        <span
                          className={
                            "inline-flex items-center gap-1.5 rounded-[7px] px-2 py-1 text-[10px] font-bold " +
                            (isSyncing
                              ? "bg-warning/15 text-warning"
                              : "bg-success/15 text-success")
                          }
                        >
                          <span
                            className={
                              "size-1.5 shrink-0 rounded-full " +
                              (isSyncing ? "bg-warning" : "bg-success")
                            }
                          />
                          {statusLabel}
                        </span>
                      </div>
                    )}
                    <p className="tabular mt-4 text-[22px] font-extrabold">
                      {formatMoney(Number(netWorth), portfolio.baseCurrency, locale)}
                    </p>
                    <p className="mt-0.5 text-xs font-semibold text-muted-foreground">
                      {t("value")}
                    </p>
                    {/* Footer flag strip — only rendered when at least one non-default flag is set */}
                    {flags.length > 0 && (
                      <>
                        {/* flex-1 pushes footer to card bottom; min-h-2.5 keeps a minimum gap */}
                        <div className="min-h-2.5 flex-1" />
                        <div className="flex flex-wrap gap-x-2.5 gap-y-1.5 border-t border-border pt-2.5">
                          {flags.map((flag) => (
                            <span
                              key={flag}
                              className="text-[11px] font-medium text-muted-foreground"
                            >
                              {flag}
                            </span>
                          ))}
                        </div>
                      </>
                    )}
                  </CardContent>
                </Card>
              );
            })}

            <Link
              href="/settings/portfolios/new"
              className="flex min-h-[170px] flex-col items-center justify-center gap-2.5 rounded-[18px] border-[1.5px] border-dashed border-border p-[18px] text-center text-muted-foreground transition-colors hover:bg-accent/40"
            >
              <span className="flex size-[42px] items-center justify-center rounded-[13px] bg-success/15 text-success">
                <Plus className="size-[22px]" />
              </span>
              <span className="text-sm font-bold text-foreground">{tf("new")}</span>
              <span className="text-xs text-muted-foreground">{t("newPortfolioHint")}</span>
            </Link>
          </div>
        ) : (
          <EmptyState
            icon={Briefcase}
            title={te("noPortfolioTitle")}
            description={te("noPortfolioBody")}
            action={
              <Button asChild>
                <Link href="/settings/portfolios/new">
                  <Plus className="size-4" />
                  {tf("new")}
                </Link>
              </Button>
            }
          />
        )}

        {result.status !== "unavailable" && <AccountHoldersManager holders={holders} />}
      </div>
    </>
  );
}
