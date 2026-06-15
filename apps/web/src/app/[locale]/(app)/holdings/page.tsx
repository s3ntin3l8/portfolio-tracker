import { getTranslations, setRequestLocale } from "next-intl/server";
import { Layers, GitBranch } from "lucide-react";
import type { HoldingValuation } from "@portfolio/api-client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/empty-state";
import { Link } from "@/i18n/navigation";
import { loadPortfolio } from "@/lib/server-api";
import { formatMoney, cn } from "@/lib/utils";

const CLASS_TABS = ["all", "equity", "gold", "bond", "mutual_fund"] as const;

export default async function HoldingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Holdings");
  const tc = await getTranslations("AssetClass");
  const te = await getTranslations("Empty");
  const tca = await getTranslations("CorpAction");

  const result = await loadPortfolio((api, portfolio) =>
    api.getSummary(portfolio.id),
  );

  const Heading = (
    <div className="flex items-start justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>
      {result.status === "ok" && (
        <Button variant="outline" asChild>
          <Link href="/corporate-actions/new">
            <GitBranch className="size-4" />
            {tca("link")}
          </Link>
        </Button>
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

  // Open positions only (computeHoldings also returns closed, zero-quantity ones).
  const holdings =
    result.status === "ok"
      ? result.data.holdings.filter((h) => Number(h.quantity) !== 0)
      : [];
  const currency = result.status === "ok" ? result.data.displayCurrency : "IDR";
  const m = (n: number) => formatMoney(n, currency, locale);

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

  function HoldingsTable({ rows }: { rows: HoldingValuation[] }) {
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("instrument")}</TableHead>
            <TableHead className="text-right">{t("quantity")}</TableHead>
            <TableHead className="text-right">{t("avgCost")}</TableHead>
            <TableHead className="text-right">{t("price")}</TableHead>
            <TableHead className="text-right">{t("value")}</TableHead>
            <TableHead className="text-right">{t("pnl")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((h) => {
            const pnl = h.unrealizedPnL !== null ? Number(h.unrealizedPnL) : null;
            return (
              <TableRow key={h.instrumentId}>
                <TableCell>
                  <div className="font-medium">{h.instrument?.symbol ?? "—"}</div>
                  <div className="text-xs text-muted-foreground">
                    {h.instrument?.name ?? h.instrumentId}
                  </div>
                </TableCell>
                <TableCell className="tabular text-right">
                  {Number(h.quantity)} {h.instrument?.unit ?? ""}
                </TableCell>
                <TableCell className="tabular text-right">
                  {m(Number(h.avgCost))}
                </TableCell>
                <TableCell className="tabular text-right">
                  {h.price !== null ? m(Number(h.price)) : "—"}
                </TableCell>
                <TableCell className="tabular text-right">
                  {h.marketValue !== null ? m(Number(h.marketValue)) : "—"}
                </TableCell>
                <TableCell
                  className={cn(
                    "tabular text-right",
                    pnl === null
                      ? "text-muted-foreground"
                      : pnl >= 0
                        ? "text-success"
                        : "text-destructive",
                  )}
                >
                  {pnl === null ? "—" : `${pnl >= 0 ? "+" : ""}${m(pnl)}`}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
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
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
