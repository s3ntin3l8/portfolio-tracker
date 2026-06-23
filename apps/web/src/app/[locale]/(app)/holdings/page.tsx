import { getTranslations, setRequestLocale } from "next-intl/server";
import { Layers, Plus, AlertCircle, AlertTriangle } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvButton } from "@/components/export-csv-button";
import { HoldingsTable } from "@/components/holdings-table";
import { CostBasisToggle } from "@/components/cost-basis-toggle";
import { AddTransactionMenu } from "@/components/add-transaction-menu";
import { PortfolioFormDialog } from "@/components/portfolio-form-dialog";
import { loadHoldings, loadAnomalies } from "@/lib/server-api";

const CLASS_TABS = ["all", "equity", "etf", "gold", "bond", "mutual_fund"] as const;

type CostBasisMode = "purchase_price" | "total_paid";

export default async function HoldingsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ costBasis?: string }>;
}) {
  const { locale } = await params;
  const { costBasis: costBasisParam } = await searchParams;
  const costBasis: CostBasisMode =
    costBasisParam === "total_paid" ? "total_paid" : "purchase_price";
  setRequestLocale(locale);
  const t = await getTranslations("Holdings");
  const ta = await getTranslations("Anomalies");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");
  const tf = await getTranslations("PortfolioForm");

  const [result, anomalies] = await Promise.all([loadHoldings(costBasis), loadAnomalies()]);

  // Open positions only (computeHoldings also returns closed, zero-quantity ones).
  const holdings =
    result.status === "ok"
      ? result.holdings.filter((h) => Number(h.quantity) !== 0)
      : [];
  const currency = result.status === "ok" ? result.displayCurrency : "IDR";

  // Cash for cash-inclusive portfolios (cashTracked = cashCounted && hasCashMovement).
  const cash = result.status === "ok" ? result.cash : {};
  const cashTracked = result.status === "ok" ? result.cashTracked : false;
  const hasCash =
    cashTracked && Object.values(cash).some((v) => Number(v) !== 0);

  // Count holdings per asset class to determine which tabs to disable.
  const classCounts = holdings.reduce<Record<string, number>>((acc, h) => {
    const c = h.instrument?.assetClass;
    if (c) acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

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
      .map(([ccy, balance]) => [
        "Cash",
        t("cash"),
        "cash",
        "",
        "",
        "",
        "",
        ccy,
        balance,
        "",
        ccy,
      ]),
  ];

  const Heading = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {result.status === "ok" && (
        <div className="flex flex-col items-start gap-2 sm:flex-row sm:flex-wrap sm:items-center">
          <CostBasisToggle
            current={costBasis}
            labelPurchase={t("costBasisPurchasePrice")}
            labelTotal={t("costBasisTotalPaid")}
          />
          {holdings.length > 0 && (
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
            />
          )}
        </div>
      )}
    </div>
  );

  if (result.status === "unavailable") {
    return (
      <div className="space-y-6">
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
      <div className="space-y-6">
        {Heading}
        <EmptyState
          icon={Layers}
          title={
            result.status === "empty"
              ? te("noPortfolioTitle")
              : te("noHoldingsTitle")
          }
          description={
            result.status === "empty"
              ? te("noPortfolioBody")
              : te("noHoldingsBody")
          }
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

  const errors = anomalies?.filter((a) => a.severity === "error") ?? [];
  const warnings = anomalies?.filter((a) => a.severity === "warning") ?? [];
  const anomalyBanner =
    anomalies && (errors.length > 0 || warnings.length > 0) ? (
      <div
        role="alert"
        className={`flex items-start gap-3 rounded-lg border px-4 py-3 text-sm ${
          errors.length > 0
            ? "border-destructive/40 bg-destructive/5 text-destructive"
            : "border-amber-400/40 bg-amber-50 text-amber-700 dark:bg-amber-950/30 dark:text-amber-400"
        }`}
      >
        {errors.length > 0 ? (
          <AlertCircle className="mt-0.5 size-4 shrink-0" />
        ) : (
          <AlertTriangle className="mt-0.5 size-4 shrink-0" />
        )}
        <span>
          {errors.length > 0 && warnings.length > 0
            ? ta("bannerBoth", { errors: errors.length, warnings: warnings.length })
            : errors.length > 0
              ? ta("bannerError", { count: errors.length })
              : ta("bannerWarning", { count: warnings.length })}
        </span>
      </div>
    ) : null;

  return (
    <div className="space-y-6">
      {Heading}
      {anomalyBanner}

      <Tabs defaultValue="all">
        <div className="overflow-x-auto">
        <TabsList>
          {CLASS_TABS.map((key) => (
            <TabsTrigger
              key={key}
              value={key}
              disabled={key !== "all" && (classCounts[key] ?? 0) === 0}
            >
              {key === "all" ? t("all") : tc(key)}
            </TabsTrigger>
          ))}
        </TabsList>
        </div>
        {CLASS_TABS.map((key) => (
          <TabsContent key={key} value={key}>
            <div className="rounded-xl border border-border">
              <HoldingsTable
                rows={
                  key === "all"
                    ? holdings
                    : holdings.filter((h) => h.instrument?.assetClass === key)
                }
                currency={currency}
                cash={key === "all" && hasCash ? cash : undefined}
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
