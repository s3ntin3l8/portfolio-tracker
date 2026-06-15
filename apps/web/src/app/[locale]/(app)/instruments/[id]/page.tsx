import { getTranslations, setRequestLocale } from "next-intl/server";
import { ArrowLeft, LineChart } from "lucide-react";
import { Link } from "@/i18n/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { EmptyState } from "@/components/empty-state";
import { PriceChart } from "@/components/charts/price-chart";
import { CorporateActionsManager } from "@/components/corporate-actions-manager";
import { loadInstrument } from "@/lib/server-api";

export default async function InstrumentPage({
  params,
}: {
  params: Promise<{ locale: string; id: string }>;
}) {
  const { locale, id } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("Instrument");
  const tc = await getTranslations("AssetClass");

  const data = await loadInstrument(id);

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
          <CardTitle>{t("corporateActions")}</CardTitle>
        </CardHeader>
        <CardContent>
          <CorporateActionsManager items={corporateActions} />
        </CardContent>
      </Card>
    </div>
  );
}
