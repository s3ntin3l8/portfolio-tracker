import { getTranslations, setRequestLocale } from "next-intl/server";
import { Layers } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvButton } from "@/components/export-csv-button";
import { HoldingsTable } from "@/components/holdings-table";
import { CostBasisToggle } from "@/components/cost-basis-toggle";
import { loadHoldings } from "@/lib/server-api";

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
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");

  const result = await loadHoldings(costBasis);

  // Open positions only (computeHoldings also returns closed, zero-quantity ones).
  const holdings =
    result.status === "ok"
      ? result.holdings.filter((h) => Number(h.quantity) !== 0)
      : [];
  const currency = result.status === "ok" ? result.displayCurrency : "IDR";

  // Count holdings per asset class to determine which tabs to disable.
  const classCounts = holdings.reduce<Record<string, number>>((acc, h) => {
    const c = h.instrument?.assetClass;
    if (c) acc[c] = (acc[c] ?? 0) + 1;
    return acc;
  }, {});

  // Per-unit avgCost/price are native quotes (labeled by PriceCurrency); position
  // value/P&L are in the display currency (the trailing Currency column).
  const exportRows: (string | number)[][] = holdings.map((h) => [
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
  ]);

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

  if (holdings.length === 0) {
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
        />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {Heading}

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
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
