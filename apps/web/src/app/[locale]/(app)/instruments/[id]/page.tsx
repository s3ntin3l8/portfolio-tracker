import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft, LineChart, Receipt, Wallet } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { PriceChart } from "@/components/charts/price-chart";
import { CorporateActionsManager } from "@/components/corporate-actions-manager";
import { TransactionsTable } from "@/components/transactions-table";
import { loadInstrument, loadInstrumentScope } from "@/lib/server-api";
import { formatMoney, formatPercent } from "@/lib/utils";

export default async function InstrumentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Instrument");
  const tc = await getTranslations("AssetClass");

  const [data, scope] = await Promise.all([
    loadInstrument(id),
    loadInstrumentScope(id),
  ]);

  const back = (
    <Button variant="ghost" size="icon" asChild aria-label={t("priceHistory")}>
      <Link href="/holdings">
        <ArrowLeft className="size-4" />
      </Link>
    </Button>
  );

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">{back}</div>
        <EmptyState
          icon={LineChart}
          title={t("notFound")}
          description={t("notFoundBody")}
        />
      </div>
    );
  }

  const { instrument, history, corporateActions } = data;

  // Your position in this instrument (null / zero-quantity = not held in the active scope).
  const holding = scope.holding;
  const hasPosition = holding !== null && Number(holding.quantity) !== 0;
  const pnlDisplay =
    holding?.unrealizedPnLDisplay != null
      ? Number(holding.unrealizedPnLDisplay)
      : null;
  const costBasisDisplay = holding ? Number(holding.costBasisDisplay) : 0;
  const pnlPct =
    pnlDisplay !== null && costBasisDisplay !== 0
      ? pnlDisplay / costBasisDisplay
      : undefined;
  const qtyFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 8 });

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {back}
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {instrument.symbol}
            </h1>
            <Badge variant="outline">{tc(instrument.assetClass)}</Badge>
          </div>
          <p className="text-sm text-muted-foreground">
            {instrument.name} · {instrument.market} · {instrument.currency}
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("priceHistory")}</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length > 0 ? (
            <PriceChart data={history} currency={instrument.currency} />
          ) : (
            <EmptyState
              icon={LineChart}
              title={t("priceHistory")}
              description={t("noHistory")}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("position")}</CardTitle>
        </CardHeader>
        <CardContent>
          {hasPosition && holding ? (
            <div className="grid gap-4 sm:grid-cols-3">
              <StatCard
                label={t("quantityLabel")}
                value={qtyFmt.format(Number(holding.quantity))}
              />
              <StatCard
                label={t("avgCostLabel")}
                value={formatMoney(
                  Number(holding.avgCost),
                  holding.currency ?? instrument.currency,
                  locale,
                )}
              />
              <StatCard
                label={t("unrealizedPnl")}
                value={
                  pnlDisplay !== null
                    ? formatMoney(pnlDisplay, scope.displayCurrency, locale)
                    : "—"
                }
                delta={pnlPct !== undefined ? formatPercent(pnlPct, locale) : undefined}
                deltaTone={
                  pnlDisplay === null
                    ? "neutral"
                    : pnlDisplay >= 0
                      ? "up"
                      : "down"
                }
              />
            </div>
          ) : (
            <EmptyState
              icon={Wallet}
              title={t("noPosition")}
              description={t("noPositionBody")}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("transactions")}</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {scope.transactions.length > 0 ? (
            <TransactionsTable
              rows={scope.transactions}
              showPortfolio={scope.aggregate}
            />
          ) : (
            <EmptyState
              icon={Receipt}
              title={t("noTransactions")}
              description={t("noTransactionsBody")}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("corporateActions")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CorporateActionsManager items={corporateActions} />
        </CardContent>
      </Card>
    </div>
  );
}
