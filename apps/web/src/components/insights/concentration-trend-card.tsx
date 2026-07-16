import { useTranslations } from "next-intl";
import { Info } from "lucide-react";
import { Card } from "@/components/ui/card";
import type { ConcentrationPoint } from "@portfolio/api-client";

function MiniSparkline({ data, color }: { data: number[]; color: string }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const w = 80;
  const h = 24;
  const points = data.map((v, i) => {
    const x = (i / (data.length - 1)) * w;
    const y = h - ((v - min) / range) * (h - 4) - 2;
    return `${x},${y}`;
  });
  return (
    <svg width={w} height={h} className="shrink-0">
      <polyline
        points={points.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

export function ConcentrationTrendCard({ trend }: { trend: ConcentrationPoint[] }) {
  const t = useTranslations("Insights.concentrationTrend");
  const latest = trend.length > 0 ? trend[trend.length - 1] : null;
  const first = trend.length > 0 ? trend[0] : null;
  const hhiData = trend.map((p) => p.hhi);
  const top1Data = trend.map((p) => p.top1Pct);

  return (
    <Card className="rounded-[20px] bg-card p-4 shadow-card">
      <p className="text-xs font-semibold text-text-2">{t("title")}</p>
      {latest ? (
        <>
          <p className="tabular mt-1 text-[22px] font-extrabold leading-none">
            {latest.top1Pct.toFixed(1)}%
          </p>
          <p className="mt-1 text-xs font-medium text-text-2">
            {t("topHolding", { hhi: (latest.hhi * 100).toFixed(1) })}
            {first && first.hhi !== latest.hhi && (
              <span className={latest.hhi < first.hhi ? " text-success" : " text-destructive"}>
                {" "}
                ({latest.hhi > first.hhi ? "+" : ""}
                {((latest.hhi - first.hhi) * 100).toFixed(2)} since {first.date})
              </span>
            )}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <div>
              <p className="text-[10px] text-text-2">{t("hhiTrend")}</p>
              <MiniSparkline data={hhiData} color="var(--color-chart-4)" />
            </div>
            <div>
              <p className="text-[10px] text-text-2">{t("top1Trend")}</p>
              <MiniSparkline data={top1Data} color="var(--color-chart-1)" />
            </div>
          </div>
          <p className="mt-1 text-[10px] text-text-2">
            {t("samples", { count: trend.length, classes: latest.classCount })}
          </p>
          <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/60 p-3 text-xs text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>{t("note")}</span>
          </div>
        </>
      ) : (
        <p className="mt-1 text-sm text-text-2">{t("insufficientData")}</p>
      )}
    </Card>
  );
}
