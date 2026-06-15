import { getTranslations, setRequestLocale } from "next-intl/server";
import { Landmark } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { CreatePortfolio } from "@/components/create-portfolio";
import { TrConnect } from "@/components/tr-connect";
import { loadPortfolios, loadTrConnection } from "@/lib/server-api";

export default async function TradeRepublicSettingsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("TradeRepublic");
  const te = await getTranslations("Empty");

  const [connection, portfolios] = await Promise.all([
    loadTrConnection(),
    loadPortfolios(),
  ]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Landmark className="size-4" />
            {t("cardTitle")}
          </CardTitle>
          {connection && <Badge variant="outline">{t(`status.${connection.status}`)}</Badge>}
        </CardHeader>
        <CardContent>
          {connection === null || portfolios.status === "unavailable" ? (
            <EmptyState
              icon={Landmark}
              title={te("unavailableTitle")}
              description={te("unavailableBody")}
            />
          ) : portfolios.portfolios.length === 0 ? (
            <CreatePortfolio />
          ) : (
            <TrConnect
              initial={connection}
              portfolios={portfolios.portfolios.map((p) => ({
                id: p.portfolio.id,
                name: p.portfolio.name,
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
