import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  ArrowLeft,
  LineChart,
  Receipt,
  Wallet,
  Pencil,
  AlertCircle,
  AlertTriangle,
} from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { StatCard } from "@/components/stat-card";
import { InstrumentLogo } from "@/components/instrument-logo";
import { InstrumentPriceCard } from "@/components/instrument-price-card";
import { InstrumentIncomeCard } from "@/components/instrument-income-card";
import { CorporateActionsManager } from "@/components/corporate-actions-manager";
import { InstrumentEditDialog } from "@/components/instrument-edit-dialog";
import { TransactionsTable } from "@/components/transactions-table";
import { InstrumentLotsTable } from "@/components/instrument-lots-table";
import {
  loadInstrument,
  loadInstrumentScope,
  loadAnomalies,
  loadIncomeStats,
  loadPreferences,
  loadMe,
} from "@/lib/server-api";
import { formatMoney, formatPercent, rowAnomalyCounts } from "@/lib/utils";
import { lastPriceInfo } from "@/lib/instrument-price";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function InstrumentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Instrument");
  const ta = await getTranslations("Anomalies");
  const tc = await getTranslations("AssetClass");

  // Cost basis is a single global preference — thread it into loadInstrumentScope,
  // which previously silently defaulted to purchase_price regardless of the user's
  // choice on Holdings (a real correctness gap: instrument P&L could disagree with
  // holdings P&L on cost basis).
  // loadPreferences() used to be awaited before anything else — a full serial round trip
  // blocking the whole page. The loaders that don't need costBasis are kicked off
  // immediately instead; only loadInstrumentScope waits on it.
  const prefsPromise = loadPreferences();
  const instrumentPromise = loadInstrument(id);
  const anomaliesPromise = loadAnomalies();
  const incomeStatsPromise = loadIncomeStats();
  const mePromise = loadMe();

  const prefs = await prefsPromise;
  const costBasis = prefs?.costBasisMode ?? "purchase_price";

  const [data, scope, allAnomalies, incomeStatsResult] = await Promise.all([
    instrumentPromise,
    loadInstrumentScope(id, costBasis),
    anomaliesPromise,
    incomeStatsPromise,
  ]);

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] InstrumentPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

  const me = await mePromise;
  const isAdmin = Boolean(me?.isAdmin);

  // Filter anomalies to those affecting this specific instrument. Portfolio-scoped
  // anomalies (reconciliation_gap, position_gap) are NOT instrument-specific — they used to
  // be included unconditionally here (`|| a.scope === "portfolio"`), which leaked an
  // unrelated portfolio-wide cash/position warning onto every single instrument's page.
  // They already have their own dedicated banner on Holdings/Transactions; this page only
  // needs anomalies that actually attach to one of this instrument's own transactions.
  const instrumentAnomalies = (allAnomalies ?? []).filter((a) => a.instrumentId === id);
  // Same dedup-by-transaction, worst-severity-wins count used everywhere else (Holdings,
  // Transactions) — see apps/web/src/lib/utils.ts `rowAnomalyCounts`.
  const { errors: instrumentAnomalyErrors, warnings: instrumentAnomalyWarnings } =
    rowAnomalyCounts(instrumentAnomalies);

  // This instrument's slice of the existing income analytics — reused as-is (same
  // lifetime `byInstrument` total and trailing `yields` the Income screen's YieldsTable
  // already renders), not a new aggregation.
  const incomeStats = incomeStatsResult.status === "ok" ? incomeStatsResult.data : null;
  const instrumentIncome = incomeStats?.byInstrument.find((i) => i.instrumentId === id) ?? null;
  const instrumentYield = incomeStats?.yields.find((y) => y.instrumentId === id) ?? null;

  const back = (
    <Button
      variant="outline"
      size="icon"
      asChild
      aria-label={t("priceHistory")}
      className="rounded-xl bg-card shadow-card"
    >
      <Link href="/holdings">
        <ArrowLeft className="size-4" />
      </Link>
    </Button>
  );

  if (!data) {
    return (
      <div className="space-y-6">
        <div className="flex items-center gap-3">{back}</div>
        <EmptyState icon={LineChart} title={t("notFound")} description={t("notFoundBody")} />
      </div>
    );
  }

  const { instrument, history, corporateActions } = data;

  // Your position in this instrument (null / zero-quantity = not held in the active scope).
  const holding = scope.holding;
  const hasPosition = holding !== null && Number(holding.quantity) !== 0;
  const pnlDisplay =
    holding?.unrealizedPnLDisplay != null ? Number(holding.unrealizedPnLDisplay) : null;
  const costBasisDisplay = holding ? Number(holding.costBasisDisplay) : 0;
  const pnlPct =
    pnlDisplay !== null && costBasisDisplay !== 0 ? pnlDisplay / costBasisDisplay : undefined;
  const qtyFmt = new Intl.NumberFormat(locale, { maximumFractionDigits: 8 });
  const lots = holding?.lots ?? [];
  const lotCurrency = holding?.currency ?? instrument.currency;

  // This position's market value ÷ the total market value of every holding in the active
  // scope — reuses `loadInstrumentScope`'s already-fetched holdings list (no new fetch).
  const marketValueDisplay =
    holding?.marketValueDisplay != null ? Number(holding.marketValueDisplay) : null;
  const portfolioWeight =
    marketValueDisplay !== null && scope.totalMarketValueDisplay
      ? marketValueDisplay / scope.totalMarketValueDisplay
      : null;

  // The price hero's "Last price · today's change" headline — derived once from the initial
  // (1Y) candle window loaded above, independent of `HoldingValuation.dayChange` so it works
  // the same whether or not the instrument is currently held.
  const lastPrice = lastPriceInfo(history, instrument.currency);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {back}
        {/* Reference detail header: instrument logo/monogram chip + symbol + class badge. */}
        <InstrumentLogo
          label={instrument.symbol}
          symbol={instrument.symbol}
          market={instrument.market}
          assetClass={instrument.assetClass}
          className="size-11 rounded-[13px] text-sm"
        />
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold">{instrument.symbol}</h1>
            <Badge variant="outline">{tc(instrument.assetClass)}</Badge>
            {isAdmin && (
              <InstrumentEditDialog instrument={instrument}>
                <Button variant="ghost" size="icon" aria-label={t("edit")}>
                  <Pencil className="size-4" />
                </Button>
              </InstrumentEditDialog>
            )}
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
          <InstrumentPriceCard
            instrumentId={id}
            initialHistory={history}
            currency={instrument.currency}
            lastPrice={lastPrice}
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("position")}</CardTitle>
        </CardHeader>
        <CardContent>
          {hasPosition && holding ? (
            <div className="grid grid-cols-3 gap-2.5 sm:gap-4 lg:grid-cols-5">
              <StatCard
                label={t("marketValueLabel")}
                value={
                  marketValueDisplay !== null
                    ? formatMoney(marketValueDisplay, scope.displayCurrency, locale)
                    : "—"
                }
              />
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
                  pnlDisplay !== null ? formatMoney(pnlDisplay, scope.displayCurrency, locale) : "—"
                }
                delta={pnlPct !== undefined ? formatPercent(pnlPct, locale) : undefined}
                deltaTone={pnlDisplay === null ? "neutral" : pnlDisplay >= 0 ? "up" : "down"}
              />
              <StatCard
                label={t("portfolioWeightLabel")}
                value={portfolioWeight !== null ? `${(portfolioWeight * 100).toFixed(1)}%` : "—"}
              />
            </div>
          ) : (
            <EmptyState icon={Wallet} title={t("noPosition")} description={t("noPositionBody")} />
          )}
        </CardContent>
      </Card>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-4">
        {lots.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("openLots")}</CardTitle>
            </CardHeader>
            <CardContent className="px-0">
              <InstrumentLotsTable lots={lots} currency={lotCurrency} />
            </CardContent>
          </Card>
        )}
        <InstrumentIncomeCard
          title={t("incomeCardTitle")}
          dividendsReceived={
            instrumentIncome
              ? formatMoney(
                  Number(instrumentIncome.total),
                  incomeStats?.displayCurrency ?? scope.displayCurrency,
                  locale,
                )
              : null
          }
          receivedCaption={t("incomeReceivedCaption")}
          emptyMessage={t("incomeEmpty")}
          yieldOnCost={
            instrumentYield?.yieldOnCost != null
              ? formatPercent(Number(instrumentYield.yieldOnCost), locale)
              : null
          }
          yieldTitle={t("yieldOnCostLabel")}
          yieldCaption={t("yieldOnCostCaption")}
        />
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-2">
            <CardTitle>{t("transactions")}</CardTitle>
            {(instrumentAnomalyErrors > 0 || instrumentAnomalyWarnings > 0) && (
              <span
                className={`flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  instrumentAnomalyErrors > 0
                    ? "bg-destructive/10 text-destructive"
                    : "bg-amber-100 text-amber-700 dark:bg-amber-950/40 dark:text-amber-400"
                }`}
              >
                {instrumentAnomalyErrors > 0 ? (
                  <AlertCircle className="size-3" />
                ) : (
                  <AlertTriangle className="size-3" />
                )}
                {instrumentAnomalyErrors > 0
                  ? ta("bannerError", { count: instrumentAnomalyErrors })
                  : ta("bannerWarning", { count: instrumentAnomalyWarnings })}
              </span>
            )}
          </div>
        </CardHeader>
        <CardContent className="px-0">
          {scope.transactions.length > 0 ? (
            <TransactionsTable
              rows={scope.transactions}
              showPortfolio={scope.aggregate}
              anomalies={instrumentAnomalies}
              showFilterBanners={false}
              scopeCurrency={scope.displayCurrency}
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
          <CorporateActionsManager items={corporateActions} isAdmin={isAdmin} />
        </CardContent>
      </Card>
    </div>
  );
}
