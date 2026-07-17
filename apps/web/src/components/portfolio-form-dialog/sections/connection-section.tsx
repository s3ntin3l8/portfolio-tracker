"use client";

import { useTranslations } from "next-intl";
import { Spinner } from "@/components/ui/spinner";
import { TrConnectFlow, type TrConnectClient } from "@/components/tr-connect-flow";
import { IbkrConnectFlow, type IbkrConnectClient } from "@/components/ibkr-connect-flow";
import type { Portfolio, TrConnection, IbkrConnection } from "@portfolio/api-client";

export function TrConnectionSection({
  trConnection,
  effectivePortfolio,
  cashCounted,
  boundElsewhere,
  trInitForFlow,
  client,
  onRefresh,
  onFetchTrigger,
}: {
  trConnection: TrConnection | null | false;
  effectivePortfolio: Pick<Portfolio, "id">;
  cashCounted: boolean;
  boundElsewhere: boolean;
  trInitForFlow: TrConnection | null;
  client: TrConnectClient;
  onRefresh: () => void;
  onFetchTrigger: () => void;
}) {
  const t = useTranslations("PortfolioForm");
  const ttr = useTranslations("TradeRepublic");
  const te = useTranslations("Empty");

  return (
    <div className="border-t border-line px-6 pb-6 pt-4">
      <p className="mb-3 text-sm font-medium">{t("trSectionTitle")}</p>
      {trConnection === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          <span>{t("trLoading")}</span>
        </div>
      ) : trConnection === false ? (
        <p className="text-sm text-muted-foreground">{te("unavailableBody")}</p>
      ) : (
        <>
          {boundElsewhere && (
            <div
              role="note"
              className="mb-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100"
            >
              {ttr("boundElsewhere")}
            </div>
          )}
          <TrConnectFlow
            client={client}
            portfolioId={effectivePortfolio.id}
            cashCounted={cashCounted}
            initial={trInitForFlow!}
            onChanged={() => {
              onRefresh();
              onFetchTrigger();
            }}
          />
        </>
      )}
    </div>
  );
}

export function IbkrConnectionSection({
  ibkrConnection,
  effectivePortfolio,
  client,
  onRefresh,
  onFetchTrigger,
}: {
  ibkrConnection: IbkrConnection | null | false;
  effectivePortfolio: Pick<Portfolio, "id">;
  client: IbkrConnectClient;
  onRefresh: () => void;
  onFetchTrigger: () => void;
}) {
  const t = useTranslations("PortfolioForm");
  const tibkr = useTranslations("InteractiveBrokers");
  const te = useTranslations("Empty");

  return (
    <div className="border-t border-line px-6 pb-6 pt-4">
      <p className="mb-3 text-sm font-medium">{tibkr("sectionTitle")}</p>
      {ibkrConnection === null ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Spinner size="sm" />
          <span>{t("trLoading")}</span>
        </div>
      ) : ibkrConnection === false ? (
        <p className="text-sm text-muted-foreground">{te("unavailableBody")}</p>
      ) : (
        <IbkrConnectFlow
          client={client}
          portfolioId={effectivePortfolio.id}
          initial={ibkrConnection}
          onChanged={() => {
            onRefresh();
            onFetchTrigger();
          }}
        />
      )}
    </div>
  );
}
