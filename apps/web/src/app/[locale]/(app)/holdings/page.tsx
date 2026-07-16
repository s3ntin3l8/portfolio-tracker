import { getTranslations, setRequestLocale } from "next-intl/server";
import { Layers, Plus, AlertCircle, AlertTriangle } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvButton } from "@/components/export-csv-button";
import { HoldingsTable } from "@/components/holdings-table";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { HeroGlanceCard } from "@/components/holdings/hero-glance-card";
import { AllocationCard, type Tone } from "@/components/holdings/allocation-card";
import { RegionCurrencyCard } from "@/components/holdings/region-currency-card";
import {
  loadHoldings,
  loadAnomalies,
  loadNetWorth,
  loadNetWorthHistory,
  loadPreferences,
  getSelectedPortfolioId,
} from "@/lib/server-api";
import {
  formatMoney,
  formatPercent,
  formatSignedMoney,
  anomalyLabel,
  rowAnomalyCounts,
  bannerAnomalies,
  type AnomalyTranslator,
} from "@/lib/utils";
import { ReconciliationBanner } from "@/components/transactions/activity-banners";

const CLASS_TABS = [
  "all",
  "equity",
  "etf",
  "gold",
  "bond",
  "mutual_fund",
  "crypto",
  "cash",
] as const;

/** Colour direction for a signed gain figure on the allocation stats strip. */
const toneOf = (n: number): Tone => (n > 0 ? "up" : n < 0 ? "down" : "flat");

/**
 * The range the Holdings hero chart initially loads. Deliberately a day-grained range
 * (not 1D/7D): intraday snapshots are brand new (PR #386) and only backfill over time,
 * so defaulting to an intraday range would show "Collecting intraday data…" as the
 * landing state on every fresh install/portfolio. 1D/7D stay one tap away as chips.
 */
const HERO_INITIAL_RANGE = "1y";

const TIMING = typeof process !== "undefined" && process.env?.TIMING_ENABLED === "true";

export default async function HoldingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ portfolio?: string }>;
}) {
  // eslint-disable-next-line react-hooks/purity
  const t0 = TIMING ? performance.now() : 0;
  const { locale } = await params;
  const { portfolio: portfolioParam } = await searchParams;
  setRequestLocale(locale);
  const t = await getTranslations("Holdings");
  const ta = await getTranslations("Anomalies");
  const tc = await getTranslations("AssetClass");
  const tr = await getTranslations("Region");
  const te = await getTranslations("Empty");
  const tf = await getTranslations("PortfolioForm");

  // Cost basis is a single global preference (Settings → Investing), not a per-page
  // toggle — threaded into every cost-basis-sensitive loader below. The loaders that
  // don't need costBasis (anomalies, history, selectedId) are kicked off immediately
  // in parallel with loadPreferences; only the two that do (loadHoldings, loadNetWorth)
  // wait on it.
  const prefsPromise = loadPreferences();
  const anomaliesPromise = loadAnomalies(portfolioParam);
  const historyPromise = loadNetWorthHistory(HERO_INITIAL_RANGE);
  const selectedIdPromise = getSelectedPortfolioId();

  const prefs = await prefsPromise;
  const costBasis = prefs?.costBasisMode ?? "purchase_price";

  const [result, netWorthResult, anomalies, history, selectedId] = await Promise.all([
    loadHoldings(costBasis, portfolioParam),
    loadNetWorth(costBasis),
    anomaliesPromise,
    historyPromise,
    selectedIdPromise,
  ]);

  if (TIMING) {
    // eslint-disable-next-line react-hooks/purity
    const durationMs = performance.now() - t0;
    console.log(
      JSON.stringify({
        level: "info",
        msg: `[timing] HoldingsPage data fetch`,
        durationMs: Math.round(durationMs * 100) / 100,
      }),
    );
  }

  // Open positions only (computeHoldings also returns closed, zero-quantity ones).
  const holdings =
    result.status === "ok" ? result.holdings.filter((h) => Number(h.quantity) !== 0) : [];
  const currency = result.status === "ok" ? result.displayCurrency : "IDR";

  // Cash for cash-inclusive portfolios (cashTracked = cashCounted && hasCashMovement).
  const cash = result.status === "ok" ? result.cash : {};
  const cashTracked = result.status === "ok" ? result.cashTracked : false;
  const hasCash = cashTracked && Object.values(cash).some((v) => Number(v) !== 0);

  // Count holdings per asset class to determine which tabs to show. Reference
  // (Pocket Prototype.dc.html) only renders a pill for classes actually held in the
  // current scope — not a fixed set with disabled placeholders for empty ones.
  const classCounts = holdings.reduce<Record<string, number>>((acc, h) => {
    const c = h.instrument?.assetClass;
    if (c) acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});
  const visibleClassTabs = CLASS_TABS.filter(
    (key) => key === "all" || (key === "cash" ? hasCash : (classCounts[key] ?? 0) > 0),
  );

  // Per-unit avgCost/price are native quotes (labeled by PriceCurrency); position
  // value/P&L are in the display currency (the trailing Currency column).
  const exportRows: (string | number)[][] = [
    ...holdings.map((h) => [
      h.instrument?.symbol ?? "",
      h.instrument?.name ?? "",
      h.instrument?.assetClass ?? "",
      Number(h.quantity),
      h.instrument?.unit ?? "",
      h.avgCost,
      h.price ?? "",
      h.currency ?? currency,
      h.marketValueDisplay ?? "",
      h.unrealizedPnLDisplay ?? "",
      currency,
    ]),
    // Cash rows for cash-inclusive portfolios (one row per currency).
    ...Object.entries(cash)
      .filter(([, v]) => Number(v) !== 0)
      .map(([ccy, balance]) => ["Cash", t("cash"), "cash", "", "", "", "", ccy, balance, "", ccy]),
  ];

  // Title + (icon-only) export share the top line; the subtitle spans the full width below
  // it — same pattern as the Activity page header.
  const Heading = (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">
          <span className="sm:hidden">{t("titleMobile")}</span>
          <span className="hidden sm:inline">{t("title")}</span>
        </h1>
        {result.status === "ok" && holdings.length > 0 && (
          <ExportCsvButton
            filename="holdings.csv"
            headers={[
              "Symbol",
              "Name",
              "AssetClass",
              "Quantity",
              "Unit",
              "AvgCost",
              "Price",
              "PriceCurrency",
              "MarketValue",
              "UnrealizedPnL",
              "Currency",
            ]}
            rows={exportRows}
            label={t("exportCsv")}
            iconOnly
          />
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        {result.status === "ok" && holdings.length > 0
          ? t("subtitleCount", { count: holdings.length })
          : t("subtitle")}
      </p>
    </div>
  );

  if (result.status === "unavailable") {
    return (
      <div className="space-y-5">
        {Heading}
        <EmptyState
          icon={Layers}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      </div>
    );
  }

  if (holdings.length === 0 && !hasCash) {
    return (
      <div className="space-y-5">
        {Heading}
        <EmptyState
          icon={Layers}
          title={result.status === "empty" ? te("noPortfolioTitle") : te("noHoldingsTitle")}
          description={result.status === "empty" ? te("noPortfolioBody") : te("noHoldingsBody")}
          action={
            result.status === "empty" ? (
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
              <AddTransactionMenu autoOpenFromParams={false} />
            )
          }
        />
      </div>
    );
  }

  // Headline count = ONLY anomalies that attach to a row (missing_transfer_basis, oversell,
  // negative_cash, …). Unlike Transactions, Holdings is a positions list — it has no
  // transaction rows and no "Show flagged only" filter, so a row-attached anomaly can never
  // be located ON this page; it links to Transactions instead, where it can. Anomalies with
  // nowhere to attach at all (reconciliation_gap, position_gap, …) are rendered below as
  // their own labeled ReconciliationBanner — already fully locatable right here, no link
  // needed (see apps/web/src/lib/utils.ts `isRowAnomaly` for why this is a transactionId
  // partition, not a hardcoded code list).
  const { errors: errorCount, warnings: warningCount } = rowAnomalyCounts(anomalies ?? []);
  const standaloneAnomalies = bannerAnomalies(anomalies ?? []);
  const anomalyBanner =
    errorCount > 0 || warningCount > 0 ? (
      <div
        role="alert"
        className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          errorCount > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
        }`}
      >
        {errorCount > 0 ? (
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        )}
        <span className="flex-1">
          {errorCount > 0 && warningCount > 0
            ? ta("bannerBoth", { errors: errorCount, warnings: warningCount })
            : errorCount > 0
              ? ta("bannerError", { count: errorCount })
              : ta("bannerWarning", { count: warningCount })}
        </span>
        <Link href="/transactions" className="shrink-0 font-medium underline underline-offset-2">
          {ta("viewTransactions")}
        </Link>
      </div>
    ) : null;

  // ── Glance hero + allocation + region/currency (aggregate/single-portfolio scope
  // via loadNetWorth — same cookie-driven scope the rest of the app uses, independent
  // of the `?portfolio=` override that only applies to the positions table below). ──
  const summary = netWorthResult.status === "ok" ? netWorthResult.data : null;
  const allocation = summary?.allocation;

  const glanceSection = summary && (
    <>
      <HeroGlanceCard
        netWorth={summary.netWorth}
        currency={summary.displayCurrency}
        initialHistory={history}
        initialRange={HERO_INITIAL_RANGE}
        selectedId={selectedId}
      />

      {allocation && allocation.byAssetClass.some((s) => Number(s.value) > 0) && (
        <AllocationCard
          slices={allocation.byAssetClass
            .filter((s) => Number(s.value) > 0)
            .map((s) => ({
              key: s.key,
              label: s.key === "cash" ? tc("cash") : tc(s.key),
              value: Number(s.value),
            }))}
          currency={summary.displayCurrency}
          total={Number(summary.netWorth)}
          totalLabel={t("allocation.totalLabel")}
          totalValueFormatted={formatMoney(
            Number(summary.netWorth),
            summary.displayCurrency,
            locale,
          )}
          allTimeLabel={t("allocation.allTimeLabel")}
          allTimeAmount={formatSignedMoney(
            Number(summary.totalUnrealizedPnL),
            summary.displayCurrency,
            locale,
          )}
          allTimePct={
            Number(summary.totalCost) > 0
              ? formatPercent(
                  Number(summary.totalUnrealizedPnL) / Number(summary.totalCost),
                  locale,
                )
              : null
          }
          allTimeTone={toneOf(Number(summary.totalUnrealizedPnL))}
          todayLabel={t("allocation.todayLabel")}
          todayAmount={formatSignedMoney(
            Number(summary.totalDayChange),
            summary.displayCurrency,
            locale,
          )}
          todayPct={(() => {
            // Day-change %: the day's move over the prior close's book value. Securities
            // that lack a previous close contribute nothing to either totalDayChange or
            // (via a null/0 market value) totalMarketValue, so `market − change` is the
            // priced book's opening base. Guard a non-positive base.
            const base = Number(summary.totalMarketValue) - Number(summary.totalDayChange);
            return base > 0 ? formatPercent(Number(summary.totalDayChange) / base, locale) : null;
          })()}
          todayTone={toneOf(Number(summary.totalDayChange))}
        />
      )}

      {allocation && (
        <RegionCurrencyCard
          regionTitle={t("byRegion")}
          currencyTitle={t("byCurrency")}
          regionRows={allocation.byRegion
            .filter((s) => Number(s.value) > 0)
            .map((s) => ({ key: s.key, label: tr(s.key), pct: s.pct }))}
          currencyRows={allocation.byCurrency
            .filter((s) => Number(s.value) > 0)
            .map((s) => ({ key: s.key, label: s.key, pct: s.pct }))}
        />
      )}
    </>
  );

  return (
    <div className="space-y-5">
      {Heading}
      {anomalyBanner}
      {standaloneAnomalies.map((a, i) => (
        <ReconciliationBanner
          key={`${a.code}:${a.meta?.currency ?? a.meta?.isin ?? i}`}
          title={ta("reconciliationTitle")}
          detail={anomalyLabel(a, ta as AnomalyTranslator, locale)}
          tag={ta("portfolioTag")}
        />
      ))}
      {/* Reference stacks the glance cards 14px apart (each card: margin-bottom:14px). */}
      <div className="space-y-3.5">{glanceSection}</div>

      <div className="space-y-3">
        <Tabs defaultValue="all">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-base font-bold">
              <span className="sm:hidden">{t("positionsSectionMobile")}</span>
              <span className="hidden sm:inline">{t("positionsSectionDesktop")}</span>
            </h2>
            <div className="overflow-x-auto">
              {/* Pill spec transcribed from the reference's `deskOn`/`deskOff` chips:
                  active 700 12px white on var(--pill); inactive 600 12px on bg-card
                  WITH a border — not a bare transparent outline. */}
              <TabsList className="h-auto gap-2 rounded-full border-0 bg-transparent p-0">
                {visibleClassTabs.map((key) => (
                  <TabsTrigger
                    key={key}
                    value={key}
                    className="rounded-full border border-border bg-card px-3.5 py-[7px] text-xs font-semibold text-foreground data-[state=active]:border-transparent data-[state=active]:bg-pill data-[state=active]:font-bold data-[state=active]:text-white data-[state=active]:shadow-none"
                  >
                    {key === "all" ? t("all") : tc(key)}
                  </TabsTrigger>
                ))}
              </TabsList>
            </div>
          </div>
          {visibleClassTabs.map((key) => (
            <TabsContent key={key} value={key}>
              <div className="overflow-hidden rounded-[18px] bg-card shadow-card">
                <HoldingsTable
                  rows={
                    key === "all"
                      ? holdings
                      : holdings.filter((h) => h.instrument?.assetClass === key)
                  }
                  currency={currency}
                  cash={(key === "all" || key === "cash") && hasCash ? cash : undefined}
                />
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </div>
    </div>
  );
}
