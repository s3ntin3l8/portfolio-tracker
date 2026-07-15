import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { cn, formatPercent } from "@/lib/utils";
import { benchmarkLabel } from "@/lib/benchmark-labels";
import type { InsightsBenchmark } from "@portfolio/api-client";

export function BenchmarkCard({
  benchmark,
  locale,
}: {
  benchmark: InsightsBenchmark;
  locale: string;
}) {
  const t = useTranslations("Insights.benchmark");
  const activeReturn = Number(benchmark.activeReturn);
  const trackingError = Number(benchmark.trackingError);
  const correlation = Number(benchmark.correlation);

  return (
    <Card className="rounded-[20px] bg-card p-4 shadow-card">
      <p className="text-xs font-semibold text-text-2">{t("vs", { symbol: benchmarkLabel(benchmark.symbol) })}</p>
      <p className={cn("tabular mt-1 text-[22px] font-extrabold leading-none", activeReturn >= 0 ? "text-success" : "text-destructive")}>
        {formatPercent(activeReturn, locale)}
      </p>
      <p className="mt-1 text-xs font-medium text-text-2">{t("activeReturn")}</p>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-text-2">
        <span>
          {t("trackingError")}: <span className="font-semibold">{trackingError > 0 ? `${(trackingError * 100).toFixed(1)}%` : "—"}</span>
        </span>
        <span>
          {t("correlation")}: <span className="font-semibold">{correlation ? correlation.toFixed(2) : "—"}</span>
        </span>
      </div>
    </Card>
  );
}
