import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import type { InsightsVolatility } from "@portfolio/api-client";

export function VolatilityCard({
  volatility,
}: {
  volatility: InsightsVolatility;
}) {
  const t = useTranslations("Insights.volatility");
  const vol = volatility.annualizedVolatility ? Number(volatility.annualizedVolatility) : null;
  const sharpe = volatility.sharpeRatio ? Number(volatility.sharpeRatio) : null;
  const sortino = volatility.sortinoRatio ? Number(volatility.sortinoRatio) : null;

  return (
    <Card className="rounded-[20px] bg-card p-4 shadow-card">
      <p className="text-xs font-semibold text-text-2">{t("title")}</p>
      {vol !== null ? (
        <p className="tabular mt-1 text-[22px] font-extrabold leading-none">
          {(vol * 100).toFixed(1)}%
        </p>
      ) : (
        <p className="mt-1 text-[22px] font-extrabold leading-none text-text-2">—</p>
      )}
      <p className="mt-1 text-xs font-medium text-text-2">{t("annualized")}</p>
      <div className="mt-2 flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-text-2">
        {sharpe !== null && (
          <span>
            {t("sharpe")}: <span className="font-semibold">{sharpe.toFixed(2)}</span>
          </span>
        )}
        {sortino !== null && (
          <span>
            {t("sortino")}: <span className="font-semibold">{sortino.toFixed(2)}</span>
          </span>
        )}
      </div>
    </Card>
  );
}
