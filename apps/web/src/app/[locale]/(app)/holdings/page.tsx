import { getTranslations, setRequestLocale } from "next-intl/server";
import { Layers, GitBranch } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { ExportCsvButton } from "@/components/export-csv-button";
import { HoldingsTable } from "@/components/holdings-table";
import { CostBasisToggle } from "@/components/cost-basis-toggle";
import { Link } from "@/i18n/navigation";
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
  const tca = await getTranslations("CorpAction");

  const result = await loadHoldings(costBasis);

  // Open positions only (computeHoldings also returns closed, zero-quantity ones).
  const holdings =
    result.status === "ok"
      ? result.holdings.filter((h) => Number(h.quantity) !== 0)
      : [];
  const currency = result.status === "ok" ? result.displayCurrency : "IDR";

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
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {result.status === "ok" && (
        <div className="flex items-center gap-2">
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
          <Button variant="outline" asChild>
            <Link href="/corporate-actions/new">
              <GitBranch className="size-4" />
              {tca("link")}
            </Link>
          </Button>
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
        <TabsList>
          {CLASS_TABS.map((key) => (
            <TabsTrigger key={key} value={key}>
              {key === "all" ? t("all") : tc(key)}
            </TabsTrigger>
          ))}
        </TabsList>
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
