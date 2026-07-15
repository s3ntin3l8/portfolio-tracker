import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { cn, formatPercent } from "@/lib/utils";
import type { InsightsDrawdown } from "@portfolio/api-client";

export function DrawdownCard({
  drawdown,
  locale,
}: {
  drawdown: InsightsDrawdown;
  locale: string;
}) {
  const t = useTranslations("Insights.drawdown");
  const maxDdpct = Number(drawdown.maxDrawdownPct);
  const currDdpct = Number(drawdown.currentDrawdownPct);
  const isUnderwater = currDdpct < 0;

  return (
    <Card className="rounded-[20px] bg-card p-4 shadow-card">
      <p className="text-xs font-semibold text-text-2">{t("title")}</p>
      <p className={cn("tabular mt-1 text-[22px] font-extrabold leading-none", maxDdpct < 0 ? "text-destructive" : "")}>
        {formatPercent(maxDdpct, locale)}
      </p>
      {drawdown.peakDate && drawdown.troughDate && (
        <p className="mt-1 text-xs font-medium text-text-2">
          {drawdown.peakDate} → {drawdown.troughDate}
        </p>
      )}
      {drawdown.recoveryDays !== undefined ? (
        <p className="text-xs text-text-2">
          {t("recoveredIn", { days: drawdown.recoveryDays })}
        </p>
      ) : isUnderwater && drawdown.peakDate ? (
        <p className="text-xs text-destructive">{t("stillUnderwater")}</p>
      ) : null}
      <div className="mt-2 flex items-center gap-1 text-xs text-text-2">
        <span>{t("current")}:</span>
        <span className={cn("font-semibold", currDdpct < 0 ? "text-destructive" : "text-success")}>
          {formatPercent(currDdpct, locale)}
        </span>
      </div>
    </Card>
  );
}
