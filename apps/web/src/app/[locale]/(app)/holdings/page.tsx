import { getTranslations, setRequestLocale } from "next-intl/server";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { formatMoney, cn } from "@/lib/utils";
import {
  holdings,
  marketValue,
  unrealizedPnL,
  type AssetClass,
  type Holding,
} from "@/lib/mock-data";

const CLASS_TABS: { key: "all" | AssetClass }[] = [
  { key: "all" },
  { key: "equity" },
  { key: "gold" },
  { key: "bond" },
  { key: "mutual_fund" },
];

export default async function HoldingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Holdings");
  const tc = await getTranslations("AssetClass");
  const m = (n: number) => formatMoney(n, "IDR", locale);

  function HoldingsTable({ rows }: { rows: Holding[] }) {
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
            const pnl = unrealizedPnL(h);
            return (
              <TableRow key={h.id}>
                <TableCell>
                  <div className="font-medium">{h.symbol}</div>
                  <div className="text-xs text-muted-foreground">{h.name}</div>
                </TableCell>
                <TableCell className="tabular text-right">
                  {h.quantity} {h.unit}
                </TableCell>
                <TableCell className="tabular text-right">{m(h.avgCost)}</TableCell>
                <TableCell className="tabular text-right">{m(h.price)}</TableCell>
                <TableCell className="tabular text-right">
                  {m(marketValue(h))}
                </TableCell>
                <TableCell
                  className={cn(
                    "tabular text-right",
                    pnl >= 0 ? "text-success" : "text-destructive",
                  )}
                >
                  {pnl >= 0 ? "+" : ""}
                  {m(pnl)}
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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Tabs defaultValue="all">
        <TabsList>
          {CLASS_TABS.map(({ key }) => (
            <TabsTrigger key={key} value={key}>
              {key === "all" ? t("all") : tc(key)}
            </TabsTrigger>
          ))}
        </TabsList>
        {CLASS_TABS.map(({ key }) => (
          <TabsContent key={key} value={key}>
            <div className="rounded-xl border border-border">
              <HoldingsTable
                rows={
                  key === "all"
                    ? holdings
                    : holdings.filter((h) => h.assetClass === key)
                }
              />
            </div>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  );
}
