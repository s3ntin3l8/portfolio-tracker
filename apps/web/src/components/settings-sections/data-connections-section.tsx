import { getTranslations } from "next-intl/server";
import type { ApiToken, IbkrConnection, TrConnection } from "@portfolio/api-client";
import { FileInput } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { ApiTokens } from "@/components/api-tokens";
import { BrokerageIcon } from "@/components/brokerage-icon";
import { cn } from "@/lib/utils";

/**
 * The Settings "Data & connections" section: the existing API-tokens manager, plus a
 * "connected sources" list scoped to what's real — screenshot/CSV import (always on) and
 * the account-wide Trade Republic / IBKR sync connections (only shown once configured;
 * both are single account-wide connections, not per-portfolio, so there's nothing to
 * invent here beyond surfacing their existing status).
 */
export async function DataConnectionsSection({
  apiTokens,
  trConnection,
  ibkrConnection,
}: {
  apiTokens: ApiToken[];
  trConnection: TrConnection | null;
  ibkrConnection: IbkrConnection | null;
}) {
  const t = await getTranslations("Settings");
  const ttr = await getTranslations("TradeRepublic");
  const tibkr = await getTranslations("InteractiveBrokers");

  const sources = [
    {
      key: "import",
      label: t("dataSourceImport"),
      hint: t("dataSourceImportHint"),
      on: true,
    },
    ...(trConnection && trConnection.status !== "disconnected"
      ? [
          {
            key: "tr",
            label: t("dataSourceTr"),
            hint: ttr(`status.${trConnection.status}`),
            on: trConnection.status === "connected",
          },
        ]
      : []),
    ...(ibkrConnection && ibkrConnection.status !== "disconnected"
      ? [
          {
            key: "ibkr",
            label: t("dataSourceIbkr"),
            hint: tibkr(`status.${ibkrConnection.status}`),
            on: ibkrConnection.status === "connected",
          },
        ]
      : []),
  ];

  return (
    <div className="space-y-4">
      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-[.04em] text-text-3">
          {t("tokens")}
        </p>
        <Card>
          <CardContent className="p-5">
            <ApiTokens initialTokens={apiTokens} />
          </CardContent>
        </Card>
      </div>

      <div>
        <p className="mb-2 px-0.5 text-xs font-bold uppercase tracking-[.04em] text-text-3">
          {t("dataSourcesLabel")}
        </p>
        <div className="divide-y divide-border overflow-hidden rounded-[20px] bg-card shadow-card">
          {sources.map((s) => (
            <div key={s.key} className="flex items-center gap-3 px-4 py-3">
              {s.key === "import" ? (
                <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-muted text-muted-foreground">
                  <FileInput className="size-5" />
                </span>
              ) : (
                <BrokerageIcon
                  brokerage={s.key === "tr" ? "Trade Republic" : "Interactive Brokers"}
                  className="size-10 rounded-xl"
                />
              )}
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-bold">{s.label}</p>
                <p className="truncate text-xs text-muted-foreground">{s.hint}</p>
              </div>
              <span
                className={cn(
                  "shrink-0 rounded-md px-2 py-1 text-[11px] font-bold",
                  s.on ? "bg-success/15 text-success" : "bg-muted text-muted-foreground",
                )}
              >
                {s.on ? t("dataSourceOn") : t("dataSourceOff")}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
