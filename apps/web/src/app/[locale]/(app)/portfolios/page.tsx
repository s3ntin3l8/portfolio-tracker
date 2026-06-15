import { getTranslations, setRequestLocale } from "next-intl/server";
import { Briefcase } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { CreatePortfolio } from "@/components/create-portfolio";
import { loadPortfolios } from "@/lib/server-api";
import { formatMoney } from "@/lib/utils";

export default async function PortfoliosPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Portfolios");
  const te = await getTranslations("Empty");

  const result = await loadPortfolios();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {result.status === "unavailable" ? (
        <EmptyState
          icon={Briefcase}
          title={te("unavailableTitle")}
          description={te("unavailableBody")}
        />
      ) : (
        <>
          {result.portfolios.length > 0 ? (
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {result.portfolios.map(({ portfolio, netWorth }) => (
                <Card key={portfolio.id}>
                  <CardContent className="p-5">
                    <p className="font-medium">{portfolio.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {portfolio.baseCurrency}
                    </p>
                    <p className="tabular mt-3 text-xl font-semibold">
                      {formatMoney(
                        Number(netWorth),
                        portfolio.baseCurrency,
                        locale,
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">{t("value")}</p>
                  </CardContent>
                </Card>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
          )}

          <Card>
            <CardHeader>
              <CardTitle>{t("create")}</CardTitle>
            </CardHeader>
            <CardContent>
              <CreatePortfolio />
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
